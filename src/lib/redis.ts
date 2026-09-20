import Redis from "ioredis";

let redisSingleton: Redis | null = null;

export class RedisNotConfiguredError extends Error {
  constructor() {
    super(
      "REDIS_URL is not set. /api/tick, /api/rate-lock, and the Kotak Neo " +
        "integration all depend on Redis and cannot work without it. Set " +
        "REDIS_URL in your deployment environment (e.g. your Vercel " +
        "project's Environment Variables) to a real Redis instance's " +
        "connection string, then redeploy."
    );
    this.name = "RedisNotConfiguredError";
  }
}

/**
 * One Redis connection per server process, shared by the rate-lock manager,
 * the tick cache, and the Kotak Neo integration — rather than each module
 * opening its own connection. Safe to call from any route/module; ioredis
 * itself queues commands until the connection is ready.
 *
 * Deliberately does NOT fall back to redis://localhost:6379 when
 * REDIS_URL is unset in production — that silent fallback is exactly what
 * produced a confusing generic 500 (Redis unreachable, not the actual
 * feature failing) instead of a clear "you haven't configured this yet"
 * message. Local dev still gets the localhost fallback, since that's a
 * reasonable default when you're running `redis-server` on your own
 * machine; a real deployment should never be silently pointed at
 * localhost, since there is no Redis at localhost in that environment.
 */
export function getRedis(): Redis {
  if (!redisSingleton) {
    const url = process.env.REDIS_URL;
    if (!url) {
      if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
        throw new RedisNotConfiguredError();
      }
      redisSingleton = new Redis("redis://localhost:6379");
    } else {
      redisSingleton = new Redis(url);
    }
  }
  return redisSingleton;
}
