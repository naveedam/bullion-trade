/**
 * Single place that constructs the Kotak Neo integration graph from
 * environment variables, so every route/worker that needs it (order
 * placement, AMO queue drain, fill polling, session health-check) shares
 * one wiring path instead of five slightly-different ad hoc constructions.
 */

import Redis from "ioredis";
import { KotakNeoAuthClient } from "./neoAuth";
import { InstrumentResolver } from "./instrumentResolver";
import { KotakNeoHedgeAdapter } from "./kotakNeoAdapter";
import type { McxMarketHoursConfig } from "./marketHours";

let redisSingleton: Redis | null = null;
function getRedis(): Redis {
  if (!redisSingleton) {
    redisSingleton = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }
  return redisSingleton;
}

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

export function buildKotakNeoAdapter(): KotakNeoHedgeAdapter {
  const redis = getRedis();

  const authClient = new KotakNeoAuthClient(
    {
      consumerKey: requireEnv("KOTAK_CONSUMER_KEY"),
      consumerSecret: requireEnv("KOTAK_CONSUMER_SECRET"),
      mobileNumber: requireEnv("KOTAK_MOBILE_NUMBER"),
      password: requireEnv("KOTAK_PASSWORD"),
      totpSecret: requireEnv("KOTAK_TOTP_SECRET"),
      baseUrl: process.env.KOTAK_API_BASE_URL,
    },
    redis
  );

  const instrumentResolver = new InstrumentResolver(
    {
      masterScripUrl: process.env.KOTAK_MASTER_SCRIP_URL,
      bearerTokenProvider: async () => (await authClient.getValidSession()).bearerToken,
    },
    redis
  );

  return new KotakNeoHedgeAdapter(authClient, instrumentResolver, redis, {
    baseUrl: process.env.KOTAK_API_BASE_URL,
    useNativeAmo: process.env.KOTAK_USE_NATIVE_AMO === "true",
    marketHours: marketHoursConfig,
  });
}

export function buildAuthClientForHealthCheck(): KotakNeoAuthClient {
  return new KotakNeoAuthClient(
    {
      consumerKey: requireEnv("KOTAK_CONSUMER_KEY"),
      consumerSecret: requireEnv("KOTAK_CONSUMER_SECRET"),
      mobileNumber: requireEnv("KOTAK_MOBILE_NUMBER"),
      password: requireEnv("KOTAK_PASSWORD"),
      totpSecret: requireEnv("KOTAK_TOTP_SECRET"),
      baseUrl: process.env.KOTAK_API_BASE_URL,
    },
    getRedis()
  );
}

export { getRedis };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
