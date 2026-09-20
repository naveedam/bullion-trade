import { NextRequest, NextResponse } from "next/server";
import { pollAndReconcileHedgeFills } from "../../../../lib/hedging";
import { buildKotakNeoAdapter } from "../../../../lib/kotak/wiring";
// import { prisma } from "../../../../lib/db";

/**
 * Scheduled every 5-10 seconds while MCX is open (or while any
 * HedgingPosition rows are in SUBMITTED/OPEN state) via your platform's
 * cron/queue scheduler. Reconciles broker fills into HedgingPosition and
 * advances the parent Order to HEDGED once every leg is TRAD, or to
 * HEDGE_FAILED (with a treasury alert) if a leg comes back rejected —
 * e.g. a circuit-limit or margin block discovered after initial
 * acceptance, which the synchronous placement call can't always catch.
 */
export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adapter = buildKotakNeoAdapter();

  const summary = await pollAndReconcileHedgeFills(adapter, {
    fetchNonTerminalPositions: async () => {
      // return prisma.hedgingPosition.findMany({
      //   where: { status: { in: ["SUBMITTED", "OPEN" as never] } },
      //   select: { id: true, orderId: true, brokerOrderId: true },
      // });
      throw new Error("fetchNonTerminalPositions not wired to Prisma");
    },
    recordFill: async (positionId, fill) => {
      // await prisma.hedgingPosition.update({
      //   where: { id: positionId },
      //   data: {
      //     status: fill.status === "TRAD" ? "FILLED"
      //       : fill.status === "REJ" ? "REJECTED"
      //       : fill.status === "CANCELLED" ? "CANCELLED"
      //       : "SUBMITTED",
      //     executionPrice: fill.avgPrice?.toString(),
      //     transactionChargesInr: fill.transactionCharges?.toString(),
      //     filledAt: fill.status === "TRAD" ? new Date() : undefined,
      //   },
      // });
      void positionId;
      void fill;
      throw new Error("recordFill not wired to Prisma");
    },
    onAllLegsFilled: async (orderId) => {
      // await prisma.order.update({ where: { id: orderId }, data: { status: "HEDGED" } });
      void orderId;
      throw new Error("onAllLegsFilled not wired to Prisma");
    },
    onLegFailed: async (orderId, positionId, reason) => {
      // await prisma.order.update({
      //   where: { id: orderId },
      //   data: { status: "HEDGE_FAILED" },
      // });
      // await notifyTreasury(`Hedge leg ${positionId} for order ${orderId} failed: ${reason}`);
      void orderId;
      void positionId;
      void reason;
      throw new Error("onLegFailed not wired to Prisma / treasury alerting");
    },
    areAllPositionsFilled: async (orderId) => {
      // const positions = await prisma.hedgingPosition.findMany({ where: { orderId } });
      // return positions.length > 0 && positions.every((p) => p.status === "FILLED");
      void orderId;
      throw new Error("areAllPositionsFilled not wired to Prisma");
    },
  });

  return NextResponse.json(summary);
}
