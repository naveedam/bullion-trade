/**
 * Delta-Hedging Middleware
 * ---------------------------------------------------------------------------
 * As soon as a physical order is funded, the platform is holding directional
 * exposure until the corresponding bar is procured/allocated. This module
 * immediately fires an equivalent-size counter-order on MCX to neutralise
 * that exposure ("Zero Balance-Sheet Slippage" constraint from the spec).
 *
 * Broker integration is behind the `HedgeBroker` interface so the platform
 * can swap Zerodha Kite Connect / Kotak Neo / an institutional FIX engine
 * without touching the trigger logic. Contract-size mapping (which MCX
 * lot — Gold Petal 1g, Gold Mini 100g, Gold 1kg — best matches a given
 * gram volume) is centralised in `decomposeHedgeVolume` so it's tested once.
 *
 * A hedge leg placed outside MCX trading hours is not an error state: a
 * broker adapter may report QUEUED_AMO instead of SUBMITTED/REJECTED, and
 * the order is parked in AWAITING_MARKET_OPEN rather than either HEDGED
 * (wrong — nothing has actually executed) or HEDGE_FAILED (wrong — nothing
 * has actually gone wrong yet). See KotakNeoHedgeAdapter for the concrete
 * after-hours queueing implementation.
 */

import Decimal from "decimal.js";
import type { HedgeOrderRequest, HedgeOrderResult } from "../types";

// ---------------------------------------------------------------------------
// MCX contract catalogue (illustrative — sizes/symbols must be reconfirmed
// against the live MCX contract specification sheet before going live,
// since lot sizes are revised periodically by the exchange).
// ---------------------------------------------------------------------------

export interface McxContract {
  code: string;
  label: string;
  lotSizeGrams: Decimal;
}

export const MCX_GOLD_CONTRACTS: McxContract[] = [
  { code: "GOLDPETAL", label: "Gold Petal", lotSizeGrams: new Decimal(1) },
  { code: "GOLDM", label: "Gold Mini", lotSizeGrams: new Decimal(100) },
  { code: "GOLD", label: "Gold (1kg)", lotSizeGrams: new Decimal(1000) },
];

/**
 * Greedily decompose a gram volume into the fewest lots across the
 * available contract sizes (largest first), so a 1250g hedge becomes
 * 1x Gold(1kg) + 2x Gold Mini + 5x Gold Petal rather than 1250 petals.
 * Returns the plan; the caller submits one broker order per line.
 */
export function decomposeHedgeVolume(
  volumeGrams: Decimal,
  contracts: McxContract[] = MCX_GOLD_CONTRACTS
): Array<{ contract: McxContract; lots: number }> {
  let remaining = volumeGrams;
  const sorted = [...contracts].sort((a, b) =>
    b.lotSizeGrams.comparedTo(a.lotSizeGrams)
  );
  const plan: Array<{ contract: McxContract; lots: number }> = [];

  for (const contract of sorted) {
    const lots = remaining.dividedToIntegerBy(contract.lotSizeGrams);
    if (lots.greaterThan(0)) {
      plan.push({ contract, lots: lots.toNumber() });
      remaining = remaining.minus(lots.times(contract.lotSizeGrams));
    }
  }

  if (remaining.greaterThan(0)) {
    // Residual smaller than the finest available lot — round up one extra
    // petal lot rather than leave exposure unhedged. Over-hedging by <1g is
    // an acceptable, auditable trade-off against carrying open delta.
    const finest = sorted[sorted.length - 1];
    const existing = plan.find((p) => p.contract.code === finest.code);
    if (existing) {
      existing.lots += 1;
    } else {
      plan.push({ contract: finest, lots: 1 });
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Broker abstraction
// ---------------------------------------------------------------------------

export type HedgeBrokerOrderStatus =
  | "SUBMITTED" // accepted by the exchange gateway, fill pending
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "REJECTED"
  | "QUEUED_AMO" // market closed — queued for placement at next open
  | "CANCELLED";

export interface HedgeBrokerOrderResult {
  brokerOrderId: string;
  status: HedgeBrokerOrderStatus;
  executionPrice?: Decimal;
  errorDetail?: string;
  /** Set when status is QUEUED_AMO — when the adapter expects to place it for real. */
  amoScheduledFor?: Date;
}

export interface HedgeBroker {
  readonly name: string;
  placeMarketOrder(args: {
    contractCode: string;
    lots: number;
    side: "SELL" | "BUY";
    clientOrderTag: string;
  }): Promise<HedgeBrokerOrderResult>;
  /**
   * Optional: poll a previously-submitted order for terminal fill status.
   * Brokers that confirm fills synchronously (or via a separate webhook)
   * may omit this; the hedge poller job (see triggerHedgeForOrder's
   * caller-side worker) only calls it when present.
   */
  pollFill?(brokerOrderId: string): Promise<{
    brokerOrderId: string;
    status: "TRAD" | "OPEN" | "REJ" | "CANCELLED";
    avgPrice?: Decimal;
    filledQuantity?: number;
    transactionCharges?: Decimal;
    rejectReason?: string;
  }>;
}

/**
 * Zerodha Kite Connect adapter (stub, kept as a secondary/fallback broker
 * option). Swap the fetch call for the official kiteconnect SDK in
 * production; kept as a raw HTTP call here so the shape of the request/
 * response contract is explicit and dependency-free. Kite never returns
 * QUEUED_AMO from this adapter — it has no after-hours MCX queueing logic
 * of its own; use KotakNeoHedgeAdapter for that behaviour.
 */
export class KiteConnectBroker implements HedgeBroker {
  readonly name = "ZERODHA_KITE";

  constructor(
    private readonly apiKey: string,
    private readonly accessToken: string,
    private readonly baseUrl = "https://api.kite.trade"
  ) {}

  async placeMarketOrder(args: {
    contractCode: string;
    lots: number;
    side: "SELL" | "BUY";
    clientOrderTag: string;
  }): Promise<HedgeBrokerOrderResult> {
    try {
      const response = await fetch(`${this.baseUrl}/orders/regular`, {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${this.apiKey}:${this.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          exchange: "MCX",
          tradingsymbol: args.contractCode,
          transaction_type: args.side,
          quantity: String(args.lots),
          order_type: "MARKET",
          product: "NRML",
          tag: args.clientOrderTag,
        }),
      });

      const body = (await response.json()) as {
        status: string;
        data?: { order_id: string };
        message?: string;
      };

      if (!response.ok || body.status !== "success" || !body.data) {
        return {
          brokerOrderId: "",
          status: "REJECTED",
          errorDetail: body.message ?? `HTTP ${response.status}`,
        };
      }

      return {
        brokerOrderId: body.data.order_id,
        status: "SUBMITTED",
      };
    } catch (err) {
      return {
        brokerOrderId: "",
        status: "REJECTED",
        errorDetail: err instanceof Error ? err.message : "Unknown broker error",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Hedging controller — the trigger fired by the webhook handler's onFunded
// ---------------------------------------------------------------------------

export interface HedgingPersistenceDeps {
  createHedgingPositionRecords: (
    orderId: string,
    plan: Array<{
      contractCode: string;
      lots: number;
      broker: string;
      brokerOrderId: string;
      status: string;
      errorDetail?: string;
    }>
  ) => Promise<void>;
  advanceOrderToHedged: (orderId: string) => Promise<void>;
  /** Order has one or more legs queued for market open — not failed, not yet hedged. */
  markOrderAwaitingMarketOpen: (
    orderId: string,
    detail: { legs: number; scheduledFor: Date | null }
  ) => Promise<void>;
  flagOrderHedgeFailure: (orderId: string, detail: string) => Promise<void>;
}

export async function triggerHedgeForOrder(
  req: HedgeOrderRequest,
  broker: HedgeBroker,
  deps: HedgingPersistenceDeps
): Promise<HedgeOrderResult[]> {
  const plan = decomposeHedgeVolume(req.volumeGrams);
  const results: HedgeOrderResult[] = [];
  const persistedRows: Array<{
    contractCode: string;
    lots: number;
    broker: string;
    brokerOrderId: string;
    status: string;
    errorDetail?: string;
  }> = [];

  let anyRejected = false;
  let queuedCount = 0;
  let earliestAmoSchedule: Date | null = null;

  for (const line of plan) {
    const result = await broker.placeMarketOrder({
      contractCode: line.contract.code,
      lots: line.lots,
      side: req.side,
      clientOrderTag: `order-${req.orderId}`,
    });

    if (result.status === "REJECTED") anyRejected = true;
    if (result.status === "QUEUED_AMO") {
      queuedCount += 1;
      if (
        result.amoScheduledFor &&
        (!earliestAmoSchedule || result.amoScheduledFor < earliestAmoSchedule)
      ) {
        earliestAmoSchedule = result.amoScheduledFor;
      }
    }

    results.push({
      brokerOrderId: result.brokerOrderId,
      broker: broker.name,
      contractType: line.contract.code,
      lots: new Decimal(line.lots),
      status: result.status === "QUEUED_AMO" ? "SUBMITTED" : result.status,
      executionPrice: result.executionPrice,
      errorDetail: result.errorDetail,
    });

    persistedRows.push({
      contractCode: line.contract.code,
      lots: line.lots,
      broker: broker.name,
      brokerOrderId: result.brokerOrderId,
      // Persist the true status (including QUEUED_AMO) rather than the
      // collapsed one used in the HedgeOrderResult union above, so ops
      // tooling querying HedgingPosition rows directly can tell "queued for
      // market open" apart from "live order accepted, fill pending".
      status: result.status,
      errorDetail: result.errorDetail,
    });
  }

  await deps.createHedgingPositionRecords(req.orderId, persistedRows);

  if (anyRejected) {
    // Zero-balance-sheet-slippage constraint: a partially-hedged order must
    // never look "done" — surface it explicitly for ops to intervene
    // (manual hedge or order cancellation/refund), never silently proceed
    // to DISPATCHED with open exposure.
    await deps.flagOrderHedgeFailure(
      req.orderId,
      `One or more hedge legs rejected: ${JSON.stringify(
        results.filter((r) => r.status === "REJECTED")
      )}`
    );
  } else if (queuedCount > 0) {
    // Not a failure, not yet complete — MCX is closed and one or more legs
    // are parked for release at market open. The AMO queue worker (see
    // processDueScheduledHedges in kotak/kotakNeoAdapter.ts) will place
    // these for real and the fill poller will then advance the order.
    await deps.markOrderAwaitingMarketOpen(req.orderId, {
      legs: queuedCount,
      scheduledFor: earliestAmoSchedule,
    });
  } else {
    await deps.advanceOrderToHedged(req.orderId);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fill poller — reconciles SUBMITTED/OPEN hedging positions to a terminal
// state once the broker confirms them. Intended to run on a schedule
// (e.g. every 5-10s while any positions are non-terminal) rather than being
// invoked inline on the webhook's critical path, since fills are not
// instantaneous even in live-market conditions.
// ---------------------------------------------------------------------------

export interface PollablePosition {
  id: string;
  orderId: string;
  brokerOrderId: string;
}

export interface FillPollerDeps {
  fetchNonTerminalPositions: () => Promise<PollablePosition[]>;
  recordFill: (
    positionId: string,
    fill: {
      status: "TRAD" | "OPEN" | "REJ" | "CANCELLED";
      avgPrice?: Decimal;
      transactionCharges?: Decimal;
    }
  ) => Promise<void>;
  /** All legs for this order are now TRAD (filled) — safe to mark HEDGED. */
  onAllLegsFilled: (orderId: string) => Promise<void>;
  /** A leg came back REJ or hit a circuit/margin block during polling. */
  onLegFailed: (
    orderId: string,
    positionId: string,
    reason: string | undefined
  ) => Promise<void>;
  /** Look up whether every position for this order is now TRAD. */
  areAllPositionsFilled: (orderId: string) => Promise<boolean>;
}

export async function pollAndReconcileHedgeFills(
  broker: HedgeBroker,
  deps: FillPollerDeps
): Promise<{ polled: number; filled: number; failed: number }> {
  if (!broker.pollFill) {
    return { polled: 0, filled: 0, failed: 0 };
  }

  const positions = await deps.fetchNonTerminalPositions();
  let filled = 0;
  let failed = 0;

  const ordersTouched = new Set<string>();

  for (const position of positions) {
    const fill = await broker.pollFill(position.brokerOrderId);

    await deps.recordFill(position.id, {
      status: fill.status,
      avgPrice: fill.avgPrice,
      transactionCharges: fill.transactionCharges,
    });

    if (fill.status === "TRAD") {
      filled += 1;
      ordersTouched.add(position.orderId);
    } else if (fill.status === "REJ") {
      failed += 1;
      await deps.onLegFailed(position.orderId, position.id, fill.rejectReason);
    }
  }

  for (const orderId of ordersTouched) {
    if (await deps.areAllPositionsFilled(orderId)) {
      await deps.onAllLegsFilled(orderId);
    }
  }

  return { polled: positions.length, filled, failed };
}
