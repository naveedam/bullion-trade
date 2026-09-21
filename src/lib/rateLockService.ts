import { RateLockManager, RateLockError } from "./rateLock";
import { getRateForQuote } from "./tickService";
import { getRedis } from "./redis";

let lockManager: RateLockManager | null = null;

export function getLockManager(): RateLockManager {
  if (!lockManager) {
    const redis = getRedis();
    lockManager = new RateLockManager({
      redis,
      getQuotedRatePerGram: async (quoteId, _metal) => {
        const rate = await getRateForQuote(redis, quoteId);
        if (!rate) {
          throw new RateLockError(
            `No live quote for quoteId=${quoteId} - it has expired, refresh and try again`,
            "QUOTE_EXPIRED"
          );
        }
        return rate;
      },
      persistAudit: async (record) => {
        void record;
      },
    });
  }
  return lockManager;
}
