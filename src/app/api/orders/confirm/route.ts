import { NextRequest, NextResponse } from "next/server";
import Decimal from "decimal.js";
import { randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { getSession } from "../../../../lib/auth/session";
import { getLockManager } from "../../../../lib/rateLockService";
import { RateLockError } from "../../../../lib/rateLock";
import { getTickById } from "../../../../lib/tickService";
import { getRedis, RedisNotConfiguredError } from "../../../../lib/redis";
import { prisma } from "../../../../lib/db";

/**
 * POST /api/orders/confirm
 * body: { quoteId, lockToken, metal, volumeGrams, deliveryMode, deliveryAddress? }
 *
 * The step after a successful rate lock: turns a 30-second, Redis-only
 * reservation into a durable Order the buyer can actually pay against.
 * Requires:
 *   - An authenticated session (never trusts a client-supplied identity).
 *   - The entity's KYC to be VERIFIED - a brand-new phone signup can browse
 *     and lock rates, but cannot generate a real payment reference until
 *     verified. There's no admin review UI yet; see
 *     /api/admin/verify-entity for the manual lever until one exists.
 *   - The lock itself still being valid (commitLock verifies token
 *     ownership and atomically consumes it, so this can't be called twice
 *     for the same lock).
 *
 * VAN issuance here is a PLATFORM-GENERATED PLACEHOLDER, not a real
 * bank-issued virtual account - the original spec's "partner bank open
 * banking API" integration (ICICI/HDFC/Axis e-Collection) doesn't exist.
 * This is flagged, not silently faked: a real deployment needs an actual
 * banking partnership before this number means anything to a bank.
 */
export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json(
      { error: "Not logged in - request and verify an OTP first" },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { quoteId, lockToken, metal, volumeGrams, deliveryMode, deliveryAddress } = body as {
    quoteId?: string;
    lockToken?: string;
    metal?: "GOLD" | "SILVER";
    volumeGrams?: string;
    deliveryMode?: "ARMORED_TRANSIT" | "VAULT_CUSTODY_HOLD";
    deliveryAddress?: string;
  };

  if (!quoteId || !lockToken || !metal || !volumeGrams || !deliveryMode) {
    return NextResponse.json(
      { error: "quoteId, lockToken, metal, volumeGrams, deliveryMode are all required" },
      { status: 400 }
    );
  }
  if (deliveryMode === "ARMORED_TRANSIT" && !deliveryAddress?.trim()) {
    return NextResponse.json(
      { error: "deliveryAddress is required for armored transit" },
      { status: 400 }
    );
  }

  let entity;
  try {
    entity = await prisma.entity.findUniqueOrThrow({ where: { id: session.entityId } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[orders:confirm] entity lookup failed", err);
    return NextResponse.json({ error: "Could not verify account" }, { status: 500 });
  }
  if (entity.kycStatus !== "VERIFIED") {
    return NextResponse.json(
      {
        error: "KYC verification is required before confirming an order",
        code: "KYC_PENDING",
        kycStatus: entity.kycStatus,
      },
      { status: 403 }
    );
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    if (err instanceof RedisNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  try {
    await getLockManager().commitLock(quoteId, session.userId, lockToken);
  } catch (err) {
    if (err instanceof RateLockError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 410 });
    }
    throw err;
  }

  const tick = await getTickById(redis, quoteId);
  if (!tick) {
    return NextResponse.json(
      { error: "Locked rate's pricing detail expired before order could be created" },
      { status: 410 }
    );
  }

  const volume = new Decimal(volumeGrams);
  const askPricePerGram = new Decimal(tick.askPricePerGramInr);
  const grossAmountInr = askPricePerGram.times(volume).toDecimalPlaces(2);
  const gstAmountInr = grossAmountInr.times("0.03").toDecimalPlaces(2);
  const tcsAmountInr = new Decimal(0);
  const courierChargeInr = volume.greaterThanOrEqualTo(1000) ? new Decimal(3500) : new Decimal(1200);
  const netPayableInr = grossAmountInr.plus(gstAmountInr).plus(tcsAmountInr).plus(courierChargeInr);

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let virtualAccount = await tx.virtualAccount.findFirst({
        where: { entityId: entity.id, status: "ACTIVE" },
      });

      if (!virtualAccount) {
        virtualAccount = await tx.virtualAccount.create({
          data: {
            entityId: entity.id,
            vanNumber: `VAN${randomBytes(5).toString("hex").toUpperCase()}`,
            ifsc: "PLACEHOLDER0000",
            partnerBank: "UNCONFIGURED - no partner bank integration yet",
          },
        });
      }

      const order = await tx.order.create({
        data: {
          entityId: entity.id,
          userId: session!.userId,
          metal,
          volumeGrams: volume.toString(),
          priceSource: tick.priceSource,
          baseSpotUsdPerOz: tick.baseSpotUsdPerOz,
          usdInrRate: tick.usdInrRate,
          customsDutyFactor: "0.06",
          ibjaRatePerGramInr: tick.ibjaRatePerGramInr ?? null,
          driftRatio: tick.driftRatio ?? null,
          refinerPremiumInr: tick.refinerPremiumInr,
          platformMarkupBps: 25,
          lockedRatePerGram: askPricePerGram.toString(),
          grossAmountInr: grossAmountInr.toString(),
          gstAmountInr: gstAmountInr.toString(),
          tcsAmountInr: tcsAmountInr.toString(),
          courierChargeInr: courierChargeInr.toString(),
          netPayableInr: netPayableInr.toString(),
          quoteId,
          status: "LOCKED",
        },
      });

      await tx.logisticsRecord.create({
        data: {
          orderId: order.id,
          mode: deliveryMode,
          deliveryAddress: deliveryMode === "ARMORED_TRANSIT" ? deliveryAddress!.trim() : null,
          status: "AWAITING_DISPATCH",
        },
      });

      await tx.orderStatusEvent.create({
        data: { orderId: order.id, toStatus: "LOCKED", actor: session!.userId, reason: "Order confirmed" },
      });

      return { order, virtualAccount };
    });

    return NextResponse.json({
      orderId: result.order.id,
      netPayableInr: result.order.netPayableInr.toString(),
      vanNumber: result.virtualAccount.vanNumber,
      ifsc: result.virtualAccount.ifsc,
      partnerBank: result.virtualAccount.partnerBank,
      status: result.order.status,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[orders:confirm] failed to persist order", err);
    return NextResponse.json(
      { error: "Could not create order - database error. Is DATABASE_URL set and migrated?" },
      { status: 500 }
    );
  }
}
