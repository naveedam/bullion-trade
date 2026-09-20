import { NextRequest, NextResponse } from "next/server";
import Decimal from "decimal.js";
import {
  handleSettlementWebhook,
  WebhookSignatureError,
  WebhookReconciliationError,
} from "../../../../lib/webhook";
import { triggerHedgeForOrder } from "../../../../lib/hedging";
import { buildKotakNeoAdapter } from "../../../../lib/kotak/wiring";
import type { SettlementWebhookPayload } from "../../../../types";
// import { prisma } from "../../../../lib/db"; // your Prisma client singleton

/**
 * POST /api/webhooks/settlement/[bankId]
 * Bank identifier is passed as a header (X-Bank-Id) by the partner bank
 * gateway config, or adapt to a dynamic route segment per bank if preferred.
 *
 * IMPORTANT: Next.js route handlers must read the *raw* body for HMAC
 * verification — do not call `req.json()` before capturing rawBody, since
 * re-serializing a parsed object will not byte-match what the bank signed.
 */
export async function POST(req: NextRequest) {
  const bankId = req.headers.get("x-bank-id") ?? "";
  const signature = req.headers.get("x-signature") ?? "";
  const rawBody = await req.text();

  let payload: SettlementWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as SettlementWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  try {
    const result = await handleSettlementWebhook(
      bankId,
      rawBody,
      signature,
      payload,
      {
        // --- Wire these to Prisma in your actual deployment ---
        findOrderById: async (orderId) => {
          throw new Error(`findOrderById not wired — lookup order ${orderId}`);
        },
        findSettlementByBankRef: async (bankRefNumber) => {
          throw new Error(
            `findSettlementByBankRef not wired — lookup ${bankRefNumber}`
          );
        },
        recordSettlement: async () => {
          throw new Error("recordSettlement not wired to Prisma");
        },
        advanceOrderToFunded: async () => {
          throw new Error("advanceOrderToFunded not wired to Prisma");
        },
        onFunded: async (orderId) => {
          // Fund confirmation must not block the webhook's HTTP response on
          // broker latency — in production this should enqueue to a job
          // queue rather than await inline. Awaited here for clarity; swap
          // for e.g. a BullMQ/Redis queue push in your actual deployment.
          //
          // const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
          // await triggerHedgeForOrder(
          //   {
          //     orderId,
          //     metal: order.metal,
          //     volumeGrams: new Decimal(order.volumeGrams.toString()),
          //     side: "SELL",
          //   },
          //   buildKotakNeoAdapter(),
          //   {
          //     createHedgingPositionRecords: (id, plan) =>
          //       prisma.hedgingPosition.createMany({
          //         data: plan.map((leg) => ({ orderId: id, ...leg })),
          //       }).then(() => undefined),
          //     advanceOrderToHedged: (id) =>
          //       prisma.order.update({ where: { id }, data: { status: "HEDGED" } }).then(() => undefined),
          //     markOrderAwaitingMarketOpen: (id, detail) =>
          //       prisma.order.update({
          //         where: { id },
          //         data: { status: "AWAITING_MARKET_OPEN" },
          //       }).then(() => {
          //         console.info(`Order ${id}: ${detail.legs} leg(s) queued for market open`, detail.scheduledFor);
          //       }),
          //     flagOrderHedgeFailure: (id, detail) =>
          //       prisma.order.update({ where: { id }, data: { status: "HEDGE_FAILED" } }).then(() => {
          //         // await notifyTreasury(`Hedge failed for order ${id}: ${detail}`);
          //       }),
          //   }
          // );
          void triggerHedgeForOrder;
          void buildKotakNeoAdapter;
          void Decimal;
          throw new Error(
            `onFunded hedge trigger not wired to Prisma — order ${orderId}`
          );
        },
      },
      {
        sharedSecretsByBank: {
          ICICI: process.env.ICICI_WEBHOOK_SECRET ?? "",
          HDFC: process.env.HDFC_WEBHOOK_SECRET ?? "",
          AXIS: process.env.AXIS_WEBHOOK_SECRET ?? "",
        },
      }
    );

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      // Logged and persisted already inside handleSettlementWebhook.
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof WebhookReconciliationError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 }
      );
    }
    // eslint-disable-next-line no-console
    console.error("[webhook:settlement] unexpected error", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
