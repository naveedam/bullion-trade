import { NextRequest, NextResponse } from "next/server";
import Decimal from "decimal.js";
import { RateLockManager, RateLockError } from "../../../lib/rateLock";
import { getRateForQuote } from "../../../lib/tickService";
import { getRedis, RedisNotConfiguredError } from "../../../lib/redis";
// import { prisma } from "../../../lib/db";

// Built lazily inside the handler, not at module load time — getRedis()
// now throws when REDIS_URL is unset, and a throw at module scope crashes
// the whole route on cold start with an opaque error rather than a clean
// HTTP response. Constructing it inside POST() means the try/catch below
// actually gets a chance to handle it.
let lockManager: RateLockManager | null = null;
function getLockManager(): RateLockManager {
  if (!lockManager) {
    const redis = getRedis();
    lockManager = new RateLockManager({
      redis,
      getQuotedRatePerGram: async (quoteId, _metal) => {
        const rate = await getRateForQuote(redis, quoteId);
        if (!rate) {
          // Most common cause: the quote this lock request names has aged
          // out of the tick cache (>35s old) — the client's poll loop
          // should have a fresher quoteId within a couple of seconds
          // either way.
          throw new RateLockError(
            `No live quote for quoteId=${quoteId} — it has expired, refresh and try again`,
            "QUOTE_EXPIRED"
          );
        }
        return rate;
      },
      persistAudit: async (record) => {
        // await prisma.rateLockAudit.create({ data: { ... } });
        void record;
      },
    });
  }
  return lockManager;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { userId, metal, volumeGrams, quoteId } = body as {
    userId: string;
    metal: "GOLD" | "SILVER";
    volumeGrams: string;
    quoteId: string;
  };

  if (!userId || !metal || !volumeGrams || !quoteId) {
    return NextResponse.json(
      { error: "userId, metal, volumeGrams, quoteId are all required" },
      { status: 400 }
    );
  }

  try {
    const result = await getLockManager().acquireLock({
      userId,
      metal,
      volumeGrams: new Decimal(volumeGrams),
      quoteId,
    });

    return NextResponse.json({
      lockToken: result.lockToken,
      quoteId: result.quoteId,
      ratePerGram: result.ratePerGram.toString(),
      volumeGrams: result.volumeGrams.toString(),
      acquiredAt: result.acquiredAt.toISOString(),
      expiresAt: result.expiresAt.toISOString(),
      ttlMs: result.ttlMs,
    });
  } catch (err) {
    if (err instanceof RedisNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof RateLockError) {
      const statusByCode: Record<string, number> = {
        QUOTE_EXPIRED: 409,
        ALREADY_LOCKED: 409,
        LOCK_NOT_FOUND: 404,
        LOCK_EXPIRED_OR_STOLEN: 410,
      };
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: statusByCode[err.code] ?? 400 }
      );
    }
    // eslint-disable-next-line no-console
    console.error("[api:rate-lock] unexpected error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
