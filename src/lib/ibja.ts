/**
 * IBJA Anchor Rate
 * ---------------------------------------------------------------------------
 * India Bullion and Jewellers Association (IBJA) publishes official AM/PM
 * gold and silver rates - the benchmark the formal Indian bullion trade
 * actually references (RBI-regulated lending against jewellery, sovereign
 * gold bond issuance, etc.), updated a few times a day rather than
 * tick-by-tick. This is the platform's pricing anchor: tickService.ts
 * takes this rate and drifts it live between refreshes using the
 * international spot + FX movement (see the "anchor + drift" comment
 * there), so the displayed price is always moving even though IBJA itself
 * only republishes periodically.
 *
 * NOT WIRED - unlike marketFeed.ts's gold-api.com/open.er-api.com (which
 * are genuinely free, no-key, and were verified working), there is no
 * single obvious free IBJA source with a confirmed, documented response
 * shape. A few real options exist (a licensed commercial API such as
 * indiagoldratesapi.com, or a RapidAPI-hosted listing like "Gold Rates
 * India") but I don't have an account with any of them to verify the
 * actual field names against - guessing at that here would repeat exactly
 * the mistake the Kotak Neo integration made before your working repo
 * caught it, except this time there's no working reference to correct
 * against. fetchIbjaFromProvider throws until you've picked a provider and
 * plugged in its real request/response shape.
 *
 * Whichever provider you use, this function's contract is: return the
 * current published gold-999 and silver-999 rates in INR per gram. Do any
 * unit conversion (many providers quote per 10g or per kg) here, not in
 * the caller.
 */

import Decimal from "decimal.js";
import type Redis from "ioredis";

const ANCHOR_TTL_SECONDS = 4 * 60 * 60;
const STALE_FALLBACK_TTL_SECONDS = 24 * 60 * 60;

export interface IbjaAnchorRate {
  gold999PerGramInr: Decimal;
  silver999PerGramInr: Decimal;
  publishedAt: string;
  fetchedAt: Date;
  stale: boolean;
}

export class IbjaFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IbjaFeedError";
  }
}

/**
 * Swap this out for your chosen provider. Left unimplemented rather than
 * guessed - see file header.
 *
 * Example shape for a RapidAPI-hosted provider (the header convention here
 * IS standard/confirmed across all RapidAPI listings; the response field
 * names below are NOT confirmed for any specific listing and must be
 * checked against the Playground/docs for whichever one you subscribe to):
 *
 *   const response = await fetch("https://<listing-host>.p.rapidapi.com/<path>", {
 *     headers: {
 *       "X-RapidAPI-Key": process.env.IBJA_RAPIDAPI_KEY!,
 *       "X-RapidAPI-Host": "<listing-host>.p.rapidapi.com",
 *     },
 *   });
 *   const body = await response.json();
 *   return {
 *     gold999PerGramInr: new Decimal(body.gold999 ?? body.Gold999_AM),
 *     silver999PerGramInr: new Decimal(body.silver999 ?? body.Silver999_AM),
 *     publishedAt: body.date ?? new Date().toISOString(),
 *   };
 */
async function fetchIbjaFromProvider(): Promise<{
  gold999PerGramInr: Decimal;
  silver999PerGramInr: Decimal;
  publishedAt: string;
}> {
  throw new IbjaFeedError(
    "fetchIbjaFromProvider is not wired - pick an IBJA data provider " +
      "(e.g. a licensed API like indiagoldratesapi.com, or a RapidAPI " +
      "listing) and implement the real request/response shape here. See " +
      "this file's header comment for the contract and an example shape."
  );
}

async function pullThroughAnchor(redis: Redis): Promise<IbjaAnchorRate> {
  const cacheKey = "ibja:anchor";
  const fallbackKey = "ibja:anchor:fallback";

  const cached = await redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as {
      gold999PerGramInr: string;
      silver999PerGramInr: string;
      publishedAt: string;
      fetchedAt: string;
    };
    return {
      gold999PerGramInr: new Decimal(parsed.gold999PerGramInr),
      silver999PerGramInr: new Decimal(parsed.silver999PerGramInr),
      publishedAt: parsed.publishedAt,
      fetchedAt: new Date(parsed.fetchedAt),
      stale: false,
    };
  }

  try {
    const fresh = await fetchIbjaFromProvider();
    const record = {
      gold999PerGramInr: fresh.gold999PerGramInr.toString(),
      silver999PerGramInr: fresh.silver999PerGramInr.toString(),
      publishedAt: fresh.publishedAt,
      fetchedAt: new Date().toISOString(),
    };
    await redis.set(cacheKey, JSON.stringify(record), "EX", ANCHOR_TTL_SECONDS);
    await redis.set(fallbackKey, JSON.stringify(record), "EX", STALE_FALLBACK_TTL_SECONDS);
    return {
      gold999PerGramInr: fresh.gold999PerGramInr,
      silver999PerGramInr: fresh.silver999PerGramInr,
      publishedAt: fresh.publishedAt,
      fetchedAt: new Date(),
      stale: false,
    };
  } catch (err) {
    const fallback = await redis.get(fallbackKey);
    if (fallback) {
      const parsed = JSON.parse(fallback) as {
        gold999PerGramInr: string;
        silver999PerGramInr: string;
        publishedAt: string;
        fetchedAt: string;
      };
      // eslint-disable-next-line no-console
      console.error("[ibja] fresh fetch failed, serving stale anchor", err);
      return {
        gold999PerGramInr: new Decimal(parsed.gold999PerGramInr),
        silver999PerGramInr: new Decimal(parsed.silver999PerGramInr),
        publishedAt: parsed.publishedAt,
        fetchedAt: new Date(parsed.fetchedAt),
        stale: true,
      };
    }
    throw err;
  }
}

export async function getIbjaAnchor(redis: Redis): Promise<IbjaAnchorRate> {
  return pullThroughAnchor(redis);
}
