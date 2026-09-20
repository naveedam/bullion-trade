import { NextRequest, NextResponse } from "next/server";
import Decimal from "decimal.js";
import Redis from "ioredis";
import { RateLockManager, RateLockError } from "../../../lib/rateLock";
// import { getLatestTick } from "../../../lib/tickCache";
// import { prisma } from "../../../lib/db";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const lockManager = new RateLockManager({
  redis,
  getQuotedRatePerGram: async (_quoteId, _metal) => {
    // Replace with a real lookup against the live tick cache (e.g. Redis
    // hash updated by the WebSocket ingestion service) keyed by quoteId.
    // Throwing here deliberately until wired, so a misconfigured deploy
    // fails loudly instead of quoting a stale placeholder price.
    throw new Error("getQuotedRatePerGram not wired to the live tick cache");
  },
  persistAudit: async (record) => {
    // await prisma.rateLockAudit.create({ data: { ... } });
    void record;
  },
});

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
    const result = await lockManager.acquireLock({
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
