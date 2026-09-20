import Redis from "ioredis";

let redisSingleton: Redis | null = null;

/**
 * One Redis connection per server process, shared by the rate-lock manager,
 * the tick cache, and the Kotak Neo integration — rather than each module
 * opening its own connection. Safe to call from any route/module; ioredis
 * itself queues commands until the connection is ready.
 */
export function getRedis(): Redis {
  if (!redisSingleton) {
    redisSingleton = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }
  return redisSingleton;
}
