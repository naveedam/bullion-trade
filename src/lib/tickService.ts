/**
 * Tick Service
 * ---------------------------------------------------------------------------
 * Bridges the live market feed (marketFeed.ts) to the pricing engine
 * (pricing.ts) that already existed for order-level quotes, and caches the
 * result under two keys:
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

const QUOTE_TTL_SECONDS = 35; // slightly longer than the 30s lock window
const CURRENT_TICK_TTL_SECONDS = 8; // shorter than the client's poll interval, so a poll usually triggers a refresh

// Illustrative defaults - the same values the UI previously simulated
// locally. In production these come from each entity's negotiated refiner
// premium / platform markup tier, not a flat constant.
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

export interface TickSnapshot {
  metal: Metal;
  quoteId: string;
  baseSpotPerGramInr: string;
  customsAdjustedPerGramInr: string;
  refinerPremiumInr: string;
  platformMarkupInr: string;
  askPricePerGramInr: string;
  baseSpotUsdPerOz: string;
  usdInrRate: string;
  generatedAt: string;
  stale: boolean;
}

function metalToSymbol(metal: Metal): MetalSymbol {
  return metal === "GOLD" ? "XAU" : "XAG";
}

async function generateTick(redis: Redis, metal: Metal): Promise<TickSnapshot> {
  const symbol = metalToSymbol(metal);
  const [spot, fx] = await Promise.all([
    getSpotUsdPerOz(redis, symbol),
    getUsdInrRate(redis),
  ]);

  const feed: MarketFeedSnapshot = {
    baseSpotUsdPerOz: spot.usdPerOz,
    usdInrRate: fx.usdInr,
    mcxFuturesPerGram: new Decimal(0),
    asOf: new Date(),
  };

  const priced = computeAskPricePerGram(feed, DEFAULT_PRICING_BY_METAL[metal]);
  const quoteId = `Q-${metal}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const snapshot: TickSnapshot = {
    metal,
    quoteId,
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

  await redis.set(`tick:byid:${quoteId}`, JSON.stringify(snapshot), "EX", QUOTE_TTL_SECONDS);
  await redis.set(`tick:current:${metal}`, JSON.stringify(snapshot), "EX", CURRENT_TICK_TTL_SECONDS);

  return snapshot;
}

export async function getCurrentTick(redis: Redis, metal: Metal): Promise<TickSnapshot> {
  const cached = await redis.get(`tick:current:${metal}`);
  if (cached) {
    return JSON.parse(cached) as TickSnapshot;
  }
  return generateTick(redis, metal);
}

export async function getRateForQuote(
  redis: Redis,
  quoteId: string
): Promise<Decimal | null> {
  const raw = await redis.get(`tick:byid:${quoteId}`);
  if (!raw) return null;
  const snapshot = JSON.parse(raw) as TickSnapshot;
  return new Decimal(snapshot.askPricePerGramInr);
}
