/**
 * Live Market Feed
 * ---------------------------------------------------------------------------
 * Two free, no-API-key public sources, used as a pragmatic stand-in for a
 * proper LBMA/COMEX + interbank FX feed:
 *
 *   - Gold/silver spot (USD/troy oz): https://api.gold-api.com/price/{XAU|XAG}
 *     Confirmed working for XAU directly; XAG follows the same path shape
 *     per gold-api.com's own documented usage pattern but wasn't
 *     independently re-verified here — the fallback-to-stale-cache logic
 *     below means a bad response degrades gracefully rather than breaking
 *     the quote board if that assumption is ever wrong.
 *   - USD/INR: https://open.er-api.com/v6/latest/USD — free, no key, but
 *     only updates once per day (ECB/interbank-derived, not tick-level).
 *     That's a real limitation for a platform pricing gram-level gold: it
 *     means the FX leg of the ask price is accurate to "today's rate", not
 *     "this second's rate". Fine for a working scaffold; swap for a paid
 *     intraday FX feed (or your bank's own rate) before this handles real
 *     settlement amounts.
 *
 * Both are wrapped in a Redis pull-through cache: a short TTL throttles how
 * often we actually hit the upstream API regardless of how many clients are
 * polling /api/tick, and a separate long-TTL "last known good" value is
 * kept so a transient upstream failure serves a stale-but-valid price
 * instead of a 500 — with the response marked `stale: true` so this is
 * visible, never silently mixed in as if fresh.
 */

import Decimal from "decimal.js";
import type Redis from "ioredis";

const GOLD_API_BASE_URL = "https://api.gold-api.com/price";
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";

const SPOT_CACHE_TTL_SECONDS = 5;
const FX_CACHE_TTL_SECONDS = 60 * 60; // open.er-api.com only refreshes daily; an hour is plenty
const STALE_FALLBACK_TTL_SECONDS = 24 * 60 * 60;

export type MetalSymbol = "XAU" | "XAG";

export interface SpotResult {
  usdPerOz: Decimal;
  stale: boolean;
}

export interface FxResult {
  usdInr: Decimal;
  stale: boolean;
}

export class MarketFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketFeedError";
  }
}

async function fetchSpotUsd(symbol: MetalSymbol): Promise<Decimal> {
  let response: Response;
  try {
    response = await fetch(`${GOLD_API_BASE_URL}/${symbol}`);
  } catch (err) {
    throw new MarketFeedError(
      `Network error fetching ${symbol} spot: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    throw new MarketFeedError(`gold-api.com returned HTTP ${response.status} for ${symbol}`);
  }
  const body = (await response.json().catch(() => null)) as { price?: number } | null;
  if (!body || typeof body.price !== "number" || body.price <= 0) {
    throw new MarketFeedError(`gold-api.com response missing a valid price for ${symbol}`);
  }
  return new Decimal(body.price);
}

async function fetchUsdInr(): Promise<Decimal> {
  let response: Response;
  try {
    response = await fetch(FX_API_URL);
  } catch (err) {
    throw new MarketFeedError(
      `Network error fetching USD/INR: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    throw new MarketFeedError(`open.er-api.com returned HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as
    | { result?: string; rates?: { INR?: number } }
    | null;
  const inr = body?.rates?.INR;
  if (body?.result !== "success" || typeof inr !== "number" || inr <= 0) {
    throw new MarketFeedError("open.er-api.com response missing a valid INR rate");
  }
  return new Decimal(inr);
}

/**
 * Pull-through cache: serves the short-TTL cached value if fresh; otherwise
 * fetches, and on fetch failure falls back to the long-TTL "last known
 * good" value rather than throwing. Only throws if there's truly nothing —
 * fresh fetch failed AND no fallback has ever been recorded (e.g. first
 * request ever, upstream down from the start).
 */
async function pullThroughCache(
  redis: Redis,
  cacheKey: string,
  fallbackKey: string,
  ttlSeconds: number,
  fetcher: () => Promise<Decimal>
): Promise<{ value: Decimal; stale: boolean }> {
  const cached = await redis.get(cacheKey);
  if (cached) {
    return { value: new Decimal(cached), stale: false };
  }

  try {
    const fresh = await fetcher();
    await redis.set(cacheKey, fresh.toString(), "EX", ttlSeconds);
    await redis.set(fallbackKey, fresh.toString(), "EX", STALE_FALLBACK_TTL_SECONDS);
    return { value: fresh, stale: false };
  } catch (err) {
    const fallback = await redis.get(fallbackKey);
    if (fallback) {
      // eslint-disable-next-line no-console
      console.error(
        `[marketFeed] fresh fetch failed for ${cacheKey}, serving stale fallback`,
        err
      );
      return { value: new Decimal(fallback), stale: true };
    }
    throw err;
  }
}

export async function getSpotUsdPerOz(redis: Redis, symbol: MetalSymbol): Promise<SpotResult> {
  const { value, stale } = await pullThroughCache(
    redis,
    `feed:spot:${symbol}`,
    `feed:spot:${symbol}:fallback`,
    SPOT_CACHE_TTL_SECONDS,
    () => fetchSpotUsd(symbol)
  );
  return { usdPerOz: value, stale };
}

export async function getUsdInrRate(redis: Redis): Promise<FxResult> {
  const { value, stale } = await pullThroughCache(
    redis,
    "feed:fx:usdinr",
    "feed:fx:usdinr:fallback",
    FX_CACHE_TTL_SECONDS,
    fetchUsdInr
  );
  return { usdInr: value, stale };
}
