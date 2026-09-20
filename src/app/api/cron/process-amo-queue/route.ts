import { NextRequest, NextResponse } from "next/server";
import {
  processDueScheduledHedges,
} from "../../../../lib/kotak/kotakNeoAdapter";
import { buildKotakNeoAdapter, getRedis } from "../../../../lib/kotak/wiring";
// import { prisma } from "../../../../lib/db";

/**
 * Scheduled to run at 09:00:05 IST (and as a safety net every few minutes
 * through the morning session, in case a leg was enqueued mid-poll-cycle
 * or the exact-time invocation was missed) via your platform's cron
 * scheduler. Protect this route with a shared secret header — cron
 * triggers are not otherwise authenticated here.
 */
export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adapter = buildKotakNeoAdapter();
  const redis = getRedis();

  const processed = await processDueScheduledHedges(adapter, redis, {
    onLegPlaced: async (orderId, result, leg) => {
      // await prisma.hedgingPosition.updateMany({
      //   where: { orderId, contractType: leg.contractCode, status: "QUEUED_AMO" },
      //   data: {
      //     brokerOrderId: result.brokerOrderId,
      //     status: result.status,
      //     errorDetail: result.errorDetail,
      //   },
      // });
      // if (result.status === "REJECTED") {
      //   await flagOrderHedgeFailure(orderId, result.errorDetail ?? "AMO leg rejected at market open");
      // }
      void orderId;
      void result;
      void leg;
      throw new Error("onLegPlaced persistence not wired to Prisma");
    },
  });

  return NextResponse.json({ processed });
}
