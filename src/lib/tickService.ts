/**
 * Tick Service
 * ---------------------------------------------------------------------------
 * Primary pricing source, per the platform's pricing decision:
 *
 *   GOLD   -> MCX GOLD (1kg) futures LTP via Kotak Neo (mcxPricingService.ts),
 *             chosen over Gold Mini for its deeper institutional open
 *             interest. Falls back to the LBMA-equivalent spot + FX
 *             reconstruction (marketFeed.ts + pricing.ts) if the Kotak
 *             session or quote fetch fails for any reason - a broker-side
 *             hiccup degrades to a different, still-legitimate pricing
 *             method rather than taking the quote board down. Which source
 *             actually priced a given tick is always recorded in
 *             priceSource, never silently blended.
 *   SILVER -> LBMA-equivalent spot + FX only, for now. Not part of the
 *             MCX-primary decision - extend this the same way as GOLD
 *             (canonical Silver contract + mcxPricingService equivalent)
 *             if/when silver gets the same treatment.
 *
 * Caches the result under two Redis keys:
 *
 *   tick:current:{metal}   - the latest tick, read by GET /api/tick for the
 *                             UI's polling loop.
 *   tick:byid:{quoteId}    - every tick ever generated, kept for slightly
 *                             longer than the 30-second lock window, so a
 *                             rate-lock request naming an older quoteId can
 *                             still resolve the exact rate that was quoted
 *                             even after a newer tick has superseded it as
 *                             "current".
 */

import Decimal from "decimal.js";
import type Redis from "ioredis";
import { computeAskPricePerGram } from "./pricing";
import { getSpotUsdPerOz, getUsdInrRate } from "./marketFeed";
import type { MetalSymbol } from "./marketFeed";
import type { Metal, MarketFeedSnapshot } from "../types";
import { getMcxGoldPricePerGram, CANONICAL_GOLD_REFERENCE } from "./kotak/mcxPricingService";
import { buildKotakPricingGraph } from "./kotak/wiring";

const QUOTE_TTL_SECONDS = 35;
const CURRENT_TICK_TTL_SECONDS = 8;

const DEFAULT_PRICING_BY_METAL: Record<
  Metal,
  { customsDutyFactor: Decimal; refinerPremiumInrPerGram: Decimal; platformMarkupBps: number }
> = {
  GOLD: {
    customsDutyFactor: new Decimal("0.06"),
    refinerPremiumInrPerGram: new Decimal("45"),
    platformMarkupBps: 25,
  },
  SILVER: {
    customsDutyFactor: new Decimal("0.06"),
    refinerPremiumInrPerGram: new Decimal("2"),
    platformMarkupBps: 25,
  },
};

export type PriceSource = "MCX" | "LBMA_FX";

export interface TickSnapshot {
  metal: Metal;
  quoteId: string;
  priceSource: PriceSource;
  baseSpotPerGramInr: string;
  customsAdjustedPerGramInr: string;
  refinerPremiumInr: string;
  platformMarkupInr: string;
  askPricePerGramInr: string;
  baseSpotUsdPerOz: string;
  usdInrRate: string;
  mcxTradingSymbol?: string;
  mcxLtp?: string;
  generatedAt: string;
  stale: boolean;
}

function metalToSymbol(metal: Metal): MetalSymbol {
  return metal === "GOLD" ? "XAU" : "XAG";
}

function applyPremiumAndMarkup(
  basePricePerGramInr: Decimal,
  refinerPremiumInrPerGram: Decimal,
  platformMarkupBps: number
): { platformMarkupInr: Decimal; askPricePerGramInr: Decimal } {
  const platformMarkupInr = basePricePerGramInr.times(platformMarkupBps).dividedBy(10000);
  const askPricePerGramInr = basePricePerGramInr
    .plus(refinerPremiumInrPerGram)
    .plus(platformMarkupInr);
  return { platformMarkupInr, askPricePerGramInr };
}

function buildQuoteId(metal: Metal): string {
  return `Q-${metal}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persistTick(redis: Redis, snapshot: TickSnapshot): Promise<void> {
  await redis.set(`tick:byid:${snapshot.quoteId}`, JSON.stringify(snapshot), "EX", QUOTE_TTL_SECONDS);
  await redis.set(`tick:current:${snapshot.metal}`, JSON.stringify(snapshot), "EX", CURRENT_TICK_TTL_SECONDS);
}

async function generateMcxGoldTick(redis: Redis): Promise<TickSnapshot> {
  const { authClient, instrumentResolver } = buildKotakPricingGraph();
  const mcxPrice = await getMcxGoldPricePerGram(authClient, instrumentResolver, CANONICAL_GOLD_REFERENCE);

  const defaults = DEFAULT_PRICING_BY_METAL.GOLD;
  const { platformMarkupInr, askPricePerGramInr } = applyPremiumAndMarkup(
    mcxPrice.pricePerGramInr,
    defaults.refinerPremiumInrPerGram,
    defaults.platformMarkupBps
  );

  const snapshot: TickSnapshot = {
    metal: "GOLD",
    quoteId: buildQuoteId("GOLD"),
    priceSource: "MCX",
    baseSpotPerGramInr: mcxPrice.pricePerGramInr.toDecimalPlaces(4).toString(),
    customsAdjustedPerGramInr: mcxPrice.pricePerGramInr.toDecimalPlaces(4).toString(),
    refinerPremiumInr: defaults.refinerPremiumInrPerGram.toString(),
    platformMarkupInr: platformMarkupInr.toDecimalPlaces(4).toString(),
    askPricePerGramInr: askPricePerGramInr.toDecimalPlaces(4).toString(),
    baseSpotUsdPerOz: "0",
    usdInrRate: "0",
    mcxTradingSymbol: mcxPrice.tradingSymbol,
    mcxLtp: mcxPrice.ltp.toString(),
    generatedAt: mcxPrice.fetchedAt.toISOString(),
    stale: false,
  };

  await persistTick(redis, snapshot);
  return snapshot;
}

async function generateLbmaFxTick(redis: Redis, metal: Metal): Promise<TickSnapshot> {
  const symbol = metalToSymbol(metal);
  const [spot, fx] = await Promise.all([getSpotUsdPerOz(redis, symbol), getUsdInrRate(redis)]);

  const feed: MarketFeedSnapshot = {
    baseSpotUsdPerOz: spot.usdPerOz,
    usdInrRate: fx.usdInr,
    mcxFuturesPerGram: new Decimal(0),
    asOf: new Date(),
  };

  const priced = computeAskPricePerGram(feed, DEFAULT_PRICING_BY_METAL[metal]);

  const snapshot: TickSnapshot = {
    metal,
    quoteId: buildQuoteId(metal),
    priceSource: "LBMA_FX",
    baseSpotPerGramInr: priced.baseSpotPerGramInr.toString(),
    customsAdjustedPerGramInr: priced.customsAdjustedPerGramInr.toString(),
    refinerPremiumInr: priced.refinerPremiumInr.toString(),
    platformMarkupInr: priced.platformMarkupInr.toString(),
    askPricePerGramInr: priced.askPricePerGramInr.toString(),
    baseSpotUsdPerOz: spot.usdPerOz.toString(),
    usdInrRate: fx.usdInr.toString(),
    generatedAt: new Date().toISOString(),
    stale: spot.stale || fx.stale,
  };

  await persistTick(redis, snapshot);
  return snapshot;
}

async function generateTick(redis: Redis, metal: Metal): Promise<TickSnapshot> {
  if (metal === "GOLD") {
    try {
      return await generateMcxGoldTick(redis);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[tickService] MCX gold pricing failed, falling back to LBMA+FX reconstruction",
        err
      );
    }
  }
  return generateLbmaFxTick(redis, metal);
}

export async function getCurrentTick(redis: Redis, metal: Metal): Promise<TickSnapshot> {
  const cached = await redis.get(`tick:current:${metal}`);
  if (cached) {
    return JSON.parse(cached) as TickSnapshot;
  }
  return generateTick(redis, metal);
}

export async function getRateForQuote(redis: Redis, quoteId: string): Promise<Decimal | null> {
  const raw = await redis.get(`tick:byid:${quoteId}`);
  if (!raw) return null;
  const snapshot = JSON.parse(raw) as TickSnapshot;
  return new Decimal(snapshot.askPricePerGramInr);
}
