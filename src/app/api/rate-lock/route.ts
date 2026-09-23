import { NextRequest, NextResponse } from "next/server";
import Decimal from "decimal.js";
import { RateLockError } from "../../../lib/rateLock";
import { getLockManager } from "../../../lib/rateLockService";
import { RedisNotConfiguredError } from "../../../lib/redis";
import { getSession } from "../../../lib/auth/session";

export async function POST(req: NextRequest) {
  // userId is NEVER trusted from the request body — it comes from the
  // verified session only. Previously this route trusted whatever userId
  // the client claimed to be, which meant anyone could lock rates (and, if
  // order confirmation had been wired to it, place orders) as anyone else.
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json(
      { error: "Not logged in — request and verify an OTP first" },
      { status: 401 }
    );
  }

  const body = await req.json();
  const { metal, volumeGrams, quoteId } = body as {
    metal: "GOLD" | "SILVER";
    volumeGrams: string;
    quoteId: string;
  };

  if (!metal || !volumeGrams || !quoteId) {
    return NextResponse.json(
      { error: "metal, volumeGrams, quoteId are all required" },
      { status: 400 }
    );
  }

  try {
    const result = await getLockManager().acquireLock({
      userId: session.userId,
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
