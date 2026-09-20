/**
 * Single place that constructs the Kotak Neo integration graph from
 * environment variables, so every route/worker that needs it (order
 * placement, AMO queue drain, fill polling, session health-check) shares
 * one wiring path instead of five slightly-different ad hoc constructions.
 */

import { KotakNeoAuthClient } from "./neoAuth";
import { InstrumentResolver } from "./instrumentResolver";
import { KotakNeoHedgeAdapter } from "./kotakNeoAdapter";
import type { McxMarketHoursConfig } from "./marketHours";
import { getRedis } from "../redis";

/**
 * Holiday check backed by a Redis SET of ISO date strings (YYYY-MM-DD),
 * expected to be synced from MCX's published annual holiday circular by a
 * separate, periodic job — not maintained here. `smembers` on a small set
 * (≈15-20 holidays/year) is cheap enough to call per market-status check
 * without its own caching layer.
 */
async function isHolidayIst(dateIst: Date): Promise<boolean> {
  const redis = getRedis();
  const key = `${dateIst.getFullYear()}-${String(dateIst.getMonth() + 1).padStart(2, "0")}-${String(
    dateIst.getDate()
  ).padStart(2, "0")}`;
  const isMember = await redis.sismember("mcx:holidays", key);
  return isMember === 1;
}

const marketHoursConfig: McxMarketHoursConfig = { isHolidayIst };

function buildAuthClient(): KotakNeoAuthClient {
  return new KotakNeoAuthClient(
    {
      consumerKey: requireEnv("KOTAK_CONSUMER_KEY"),
      mobileNumber: requireEnv("KOTAK_MOBILE_NUMBER"),
      ucc: requireEnv("KOTAK_UCC"),
      mpin: requireEnv("KOTAK_MPIN"),
    },
    getRedis()
  );
}

function buildInstrumentResolver(authClient: KotakNeoAuthClient): InstrumentResolver {
  return new InstrumentResolver(
    authClient,
    { tenderNoticeDays: process.env.KOTAK_TENDER_NOTICE_DAYS ? Number(process.env.KOTAK_TENDER_NOTICE_DAYS) : undefined },
    getRedis()
  );
}

/**
 * Shared by both the hedge-execution path (kotakNeoAdapter.ts) and the
 * MCX pricing path (mcxPricingService.ts) — one auth client + resolver
 * pair per process rather than each building its own.
 */
export function buildKotakPricingGraph(): {
  authClient: KotakNeoAuthClient;
  instrumentResolver: InstrumentResolver;
} {
  const authClient = buildAuthClient();
  return { authClient, instrumentResolver: buildInstrumentResolver(authClient) };
}

export function buildKotakNeoAdapter(): KotakNeoHedgeAdapter {
  const redis = getRedis();
  const authClient = buildAuthClient();
  const instrumentResolver = buildInstrumentResolver(authClient);

  return new KotakNeoHedgeAdapter(authClient, instrumentResolver, redis, {
    useNativeAmo: process.env.KOTAK_USE_NATIVE_AMO === "true",
    marketHours: marketHoursConfig,
  });
}

export function buildAuthClientForHealthCheck(): KotakNeoAuthClient {
  return buildAuthClient();
}

export { getRedis };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
