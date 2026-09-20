/**
 * Virtual Account Settlement Webhook Ingestion
 * ---------------------------------------------------------------------------
 * Receives RTGS/NEFT settlement callbacks from partner banks (ICICI/HDFC/
 * Axis e-Collection), verifies authenticity, guards against replay, and
 * reconciles the payment against the locked order before advancing
 * RATE_LOCKED (mapped here to LOCKED) -> SETTLEMENT_CONFIRMED (mapped to
 * FUNDED, matching the Order model's status enum).
 *
 * Security properties enforced here:
 * 1. HMAC-SHA256 signature check against a per-bank shared secret.
 * 2. Replay protection via the settlement's bankRefNumber being a DB unique
 *    constraint — a duplicate webhook (retried by the bank) is idempotently
 *    absorbed, not double-applied to the ledger.
 * 3. Amount reconciliation — the credited amount must match the order's
 *    netPayableInr exactly (bank transfers don't do partial-order credit;
 *    a mismatch is parked as REJECTED_AMOUNT_MISMATCH for manual review
 *    rather than silently advancing the order).
 */

import { createHmac, timingSafeEqual } from "crypto";
import Decimal from "decimal.js";
import type { SettlementWebhookPayload } from "../types";

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export class WebhookReconciliationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "ORDER_NOT_FOUND"
      | "ORDER_WRONG_STATUS"
      | "AMOUNT_MISMATCH"
      | "VAN_MISMATCH"
  ) {
    super(message);
    this.name = "WebhookReconciliationError";
  }
}

/**
 * Verifies an inbound webhook's HMAC signature using constant-time
 * comparison (never `===` on secrets — that leaks timing information an
 * attacker can use to forge signatures byte by byte).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  sharedSecret: string
): boolean {
  const expected = createHmac("sha256", sharedSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signatureHeader, "hex");

  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

// ---------------------------------------------------------------------------
// Minimal persistence-layer interface — implement with Prisma in your app.
// Kept as an injected interface so this controller is unit-testable without
// spinning up a real database.
// ---------------------------------------------------------------------------

export interface OrderForReconciliation {
  id: string;
  status: string; // OrderStatus
  netPayableInr: Decimal;
  virtualAccountVan: string;
}

export interface WebhookPersistenceDeps {
  findOrderById: (orderId: string) => Promise<OrderForReconciliation | null>;
  findSettlementByBankRef: (
    bankRefNumber: string
  ) => Promise<{ id: string } | null>;
  recordSettlement: (args: {
    bankRefNumber: string;
    vanNumber: string;
    amountInr: Decimal;
    utrNumber: string | undefined;
    rawPayload: unknown;
    signatureValid: boolean;
    status:
      | "VERIFIED"
      | "REJECTED_SIGNATURE"
      | "REJECTED_AMOUNT_MISMATCH"
      | "RECONCILED";
    orderId: string;
  }) => Promise<void>;
  advanceOrderToFunded: (orderId: string) => Promise<void>;
  /** Trigger the next stage (delta hedge) once funds are confirmed. */
  onFunded: (orderId: string) => Promise<void>;
}

export interface WebhookHandlerConfig {
  sharedSecretsByBank: Record<string, string>;
}

/**
 * Top-level entry point: call this from your framework's route handler with
 * the raw request body string, the bank identifier, the signature header,
 * and the parsed payload.
 */
export async function handleSettlementWebhook(
  bankId: string,
  rawBody: string,
  signatureHeader: string,
  payload: SettlementWebhookPayload,
  deps: WebhookPersistenceDeps,
  config: WebhookHandlerConfig
): Promise<{ status: "ok" | "duplicate_ignored"; orderId: string }> {
  const secret = config.sharedSecretsByBank[bankId];
  if (!secret) {
    throw new WebhookSignatureError(`Unknown bank identifier: ${bankId}`);
  }

  const signatureValid = verifyWebhookSignature(rawBody, signatureHeader, secret);

  // Replay protection: if we've already recorded this bankRefNumber, this is
  // a bank-side retry of a webhook we already processed — ack without
  // reapplying it to the ledger.
  const existing = await deps.findSettlementByBankRef(payload.bankRefNumber);
  if (existing) {
    return { status: "duplicate_ignored", orderId: payload.orderId };
  }

  if (!signatureValid) {
    await deps.recordSettlement({
      bankRefNumber: payload.bankRefNumber,
      vanNumber: payload.vanNumber,
      amountInr: new Decimal(payload.amountInr),
      utrNumber: payload.utrNumber,
      rawPayload: payload,
      signatureValid: false,
      status: "REJECTED_SIGNATURE",
      orderId: payload.orderId,
    });
    throw new WebhookSignatureError(
      "Signature verification failed — payload rejected and logged, not applied"
    );
  }

  const order = await deps.findOrderById(payload.orderId);
  if (!order) {
    throw new WebhookReconciliationError(
      `No order found for id=${payload.orderId}`,
      "ORDER_NOT_FOUND"
    );
  }

  if (order.status !== "LOCKED") {
    throw new WebhookReconciliationError(
      `Order ${order.id} is in status ${order.status}, expected LOCKED`,
      "ORDER_WRONG_STATUS"
    );
  }

  if (order.virtualAccountVan !== payload.vanNumber) {
    await deps.recordSettlement({
      bankRefNumber: payload.bankRefNumber,
      vanNumber: payload.vanNumber,
      amountInr: new Decimal(payload.amountInr),
      utrNumber: payload.utrNumber,
      rawPayload: payload,
      signatureValid: true,
      status: "REJECTED_AMOUNT_MISMATCH",
      orderId: order.id,
    });
    throw new WebhookReconciliationError(
      `VAN mismatch: order expects ${order.virtualAccountVan}, payload has ${payload.vanNumber}`,
      "VAN_MISMATCH"
    );
  }

  const creditedAmount = new Decimal(payload.amountInr);
  if (!creditedAmount.equals(order.netPayableInr)) {
    await deps.recordSettlement({
      bankRefNumber: payload.bankRefNumber,
      vanNumber: payload.vanNumber,
      amountInr: creditedAmount,
      utrNumber: payload.utrNumber,
      rawPayload: payload,
      signatureValid: true,
      status: "REJECTED_AMOUNT_MISMATCH",
      orderId: order.id,
    });
    throw new WebhookReconciliationError(
      `Amount mismatch: expected ${order.netPayableInr.toString()}, received ${creditedAmount.toString()}`,
      "AMOUNT_MISMATCH"
    );
  }

  // All checks passed — record as reconciled and advance the state machine.
  await deps.recordSettlement({
    bankRefNumber: payload.bankRefNumber,
    vanNumber: payload.vanNumber,
    amountInr: creditedAmount,
    utrNumber: payload.utrNumber,
    rawPayload: payload,
    signatureValid: true,
    status: "RECONCILED",
    orderId: order.id,
  });

  await deps.advanceOrderToFunded(order.id);

  // Kick off delta-hedging immediately — must not block the webhook's HTTP
  // response for long; in production this should enqueue to a job queue
  // rather than await broker latency inline. Awaited here for clarity.
  await deps.onFunded(order.id);

  return { status: "ok", orderId: order.id };
}
