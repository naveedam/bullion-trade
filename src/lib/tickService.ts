/**
 * Tick Service
 * ---------------------------------------------------------------------------
 * Pricing model, per the platform's business decision (Bangalore bullion
 * trade, disrupting phone/WhatsApp price-locking — not a brokerage):
 *
 *   Anchor:  IBJA's published gold-999 / silver-999 rate (ibja.ts) — the
 *            benchmark the formal Indian bullion trade already references.
 *            Only republishes a few times a day.
 *   Drift:   Between IBJA refreshes, the anchor is scaled by how much the
 *            international spot + FX price (marketFeed.ts + pricing.ts)
 *            has moved since the moment the anchor was captured. So the
 *            displayed price is always live-moving, but always traceable
 *            back to a real, trade-recognized benchmark rather than a pure
 *            LBMA+duty reconstruction with no local-market grounding.
 *
 *   drift ratio = liveCustomsAdjustedPerGram / referenceCustomsAdjustedPerGram
 *   displayed base = ibjaRatePerGram * drift ratio
 *   ask price = displayed base + refiner premium + platform markup
 *
 * Falls back to the plain LBMA+FX reconstruction (no IBJA anchor at all) if
 * the IBJA feed fails outright — `priceSource` always records which mode
 * actually priced a given tick, never blended silently.
 *
 * Kotak Neo / MCX pricing (kotak/mcxPricingService.ts) is intentionally NOT
 * called from here — the platform doesn't place orders or need a broker
 * account, so MCX-via-Kotak was dropped from the pricing path. The Kotak
 * integration itself is untouched in the repo in case hedging becomes
 * relevant later; it's just disconnected from pricing.
 *
 * Caches the result under two Redis keys:
 *   tick:current:{metal}   - the latest tick, read by GET /api/tick.
 *   tick:byid:{quoteId}    - every tick ever generated, kept slightly
 *                             longer than the 30-second lock window, so a
 *                             rate-lock request can resolve the exact rate
 *                             quoted even after a newer tick supersedes it.
 */

import Decimal from "decimal.js";
import type Redis from "ioredis";
import { computeAskPricePerGram } from "./pricing";
import { getSpotUsdPerOz, getUsdInrRate } from "./marketFeed";
import type { MetalSymbol } from "./marketFeed";
import { getIbjaAnchor, IbjaFeedError } from "./ibja";
import type { Metal, MarketFeedSnapshot } from "../types";

const QUOTE_TTL_SECONDS = 35;
const CURRENT_TICK_TTL_SECONDS = 8;
// Reference snapshot lives at least as long as the anchor's own cache TTL
// (4h in ibja.ts) plus headroom, so it never expires out from under a still
// -valid anchor and forces a spurious re-anchor.
const DRIFT_REFERENCE_TTL_SECONDS = 5 * 60 * 60;

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

export type PriceSource = "IBJA_ANCHORED" | "LBMA_FX";

export interface TickSnapshot {
  metal: Metal;
  quoteId: string;
  priceSource: PriceSource;
  // IBJA_ANCHORED mode: the drift-adjusted base (IBJA rate scaled by live
  // international movement since anchor). LBMA_FX mode: base USD spot
  // converted to INR/gram, pre-duty.
  baseSpotPerGramInr: string;
  // IBJA_ANCHORED mode: same as baseSpotPerGramInr (duty is implicit in
  // IBJA's published rate). LBMA_FX mode: after customs duty is applied.
  customsAdjustedPerGramInr: string;
  refinerPremiumInr: string;
  platformMarkupInr: string;
  askPricePerGramInr: string;
  // Only meaningful in LBMA_FX mode; "0" in IBJA_ANCHORED mode.
  baseSpotUsdPerOz: string;
  usdInrRate: string;
  // Only present in IBJA_ANCHORED mode.
  ibjaRatePerGramInr?: string;
  ibjaPublishedAt?: string;
  driftRatio?: string;
  generatedAt: string;
  stale: boolean;
}

function metalToSymbol(metal: Metal): MetalSymbol {
  return metal === "GOLD" ? "XAU" : "XAG";
}

function buildQuoteId(metal: Metal): string {
  return `Q-${metal}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persistTick(redis: Redis, snapshot: TickSnapshot): Promise<void> {
  await redis.set(`tick:byid:${snapshot.quoteId}`, JSON.stringify(snapshot), "EX", QUOTE_TTL_SECONDS);
  await redis.set(`tick:current:${snapshot.metal}`, JSON.stringify(snapshot), "EX", CURRENT_TICK_TTL_SECONDS);
}

async function getLiveCustomsAdjusted(redis: Redis, metal: Metal): Promise<Decimal> {
  const symbol = metalToSymbol(metal);
  const [spot, fx] = await Promise.all([getSpotUsdPerOz(redis, symbol), getUsdInrRate(redis)]);
  const feed: MarketFeedSnapshot = {
    baseSpotUsdPerOz: spot.usdPerOz,
    usdInrRate: fx.usdInr,
    mcxFuturesPerGram: new Decimal(0),
    asOf: new Date(),
  };
  const priced = computeAskPricePerGram(feed, DEFAULT_PRICING_BY_METAL[metal]);
  return priced.customsAdjustedPerGramInr;
}

/**
 * The international-derived price at the moment the current IBJA anchor
 * was captured — cached and tied to that specific anchor's fetchedAt, so a
 * fresh IBJA publish automatically triggers a fresh reference point rather
 * than drifting off a stale one.
 */
async function getOrCreateDriftReference(
  redis: Redis,
  metal: Metal,
  anchorFetchedAtIso: string
): Promise<Decimal> {
  const key = `ibja:driftref:${metal}`;
  const cached = await redis.get(key);
  if (cached) {
    const parsed = JSON.parse(cached) as { anchorFetchedAt: string; customsAdjustedPerGramInr: string };
    if (parsed.anchorFetchedAt === anchorFetchedAtIso) {
      return new Decimal(parsed.customsAdjustedPerGramInr);
    }
  }

  const reference = await getLiveCustomsAdjusted(redis, metal);
  await redis.set(
    key,
    JSON.stringify({ anchorFetchedAt: anchorFetchedAtIso, customsAdjustedPerGramInr: reference.toString() }),
    "EX",
    DRIFT_REFERENCE_TTL_SECONDS
  );
  return reference;
}

async function generateAnchoredTick(redis: Redis, metal: Metal): Promise<TickSnapshot> {
  const anchor = await getIbjaAnchor(redis);
  const anchorFetchedAtIso = anchor.fetchedAt.toISOString();
  const referenceCustomsAdjusted = await getOrCreateDriftReference(redis, metal, anchorFetchedAtIso);
  const liveCustomsAdjusted = await getLiveCustomsAdjusted(redis, metal);

  const driftRatio = referenceCustomsAdjusted.isZero()
    ? new Decimal(1)
    : liveCustomsAdjusted.dividedBy(referenceCustomsAdjusted);

  const ibjaRatePerGram = metal === "GOLD" ? anchor.gold999PerGramInr : anchor.silver999PerGramInr;
  const driftedBasePerGram = ibjaRatePerGram.times(driftRatio);

  const defaults = DEFAULT_PRICING_BY_METAL[metal];
  const platformMarkupInr = driftedBasePerGram.times(defaults.platformMarkupBps).dividedBy(10000);
  const askPricePerGramInr = driftedBasePerGram
    .plus(defaults.refinerPremiumInrPerGram)
    .plus(platformMarkupInr);

  const snapshot: TickSnapshot = {
    metal,
    quoteId: buildQuoteId(metal),
    priceSource: "IBJA_ANCHORED",
    baseSpotPerGramInr: driftedBasePerGram.toDecimalPlaces(4).toString(),
    customsAdjustedPerGramInr: driftedBasePerGram.toDecimalPlaces(4).toString(),
    refinerPremiumInr: defaults.refinerPremiumInrPerGram.toString(),
    platformMarkupInr: platformMarkupInr.toDecimalPlaces(4).toString(),
    askPricePerGramInr: askPricePerGramInr.toDecimalPlaces(4).toString(),
    baseSpotUsdPerOz: "0",
    usdInrRate: "0",
    ibjaRatePerGramInr: ibjaRatePerGram.toString(),
    ibjaPublishedAt: anchor.publishedAt,
    driftRatio: driftRatio.toDecimalPlaces(6).toString(),
    generatedAt: new Date().toISOString(),
    stale: anchor.stale,
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
  try {
    return await generateAnchoredTick(redis, metal);
  } catch (err) {
    // IBJA feed not wired yet, or failed outright with no stale fallback
    // available — fall back to a plain LBMA+FX reconstruction rather than
    // 500ing the quote board. Once IbjaFeedError's cause is resolved (a
    // provider gets wired in ibja.ts), this branch stops firing on its own.
    const reason = err instanceof IbjaFeedError ? err.message : err;
    // eslint-disable-next-line no-console
    console.error(
      "[tickService] IBJA-anchored pricing failed, falling back to LBMA+FX reconstruction",
      reason
    );
    return generateLbmaFxTick(redis, metal);
  }
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
