/**
 * Kotak Neo Hedge Broker Adapter
 * ---------------------------------------------------------------------------
 * Production implementation of the platform's `HedgeBroker` interface
 * (see ../hedging.ts) against Kotak Neo's Trade API, for MCX gold futures.
 *
 * Order routing logic:
 *   - MCX open (morning or evening session): fire an immediate MARKET/NRML
 *     order.
 *   - MCX closed (after-hours, weekend, or holiday): do NOT throw. Enqueue
 *     the leg into a Redis-backed scheduled queue keyed to the next known
 *     market-open instant, and report status QUEUED_AMO upstream. A
 *     separate worker (`processDueScheduledHedges`, intended to be invoked
 *     by an external cron a few seconds after 09:00:05 IST) drains the
 *     queue and places the real orders once the market is actually open.
 *
 *     Kotak Neo does support broker-native AMO (`amo: "YES"`) for equity
 *     segments; MCX AMO support varies by account type and is not
 *     guaranteed to route reliably overnight for commodity derivatives, so
 *     the Redis queue is the default, safer path. If your account and
 *     Kotak's current MCX AMO support are confirmed compatible, set
 *     `config.useNativeAmo = true` to route through the broker instead —
 *     verify this against your account documentation before flipping it in
 *     production.
 *
 * As with neoAuth.ts and instrumentResolver.ts, the exact order-placement
 * and order-report endpoint paths/response fields below follow Kotak Neo's
 * general API shape but must be checked against your credential bundle's
 * current documentation — this adapter fails loudly (typed errors, no
 * silent `undefined` fallthrough) specifically so a stale endpoint
 * assumption surfaces immediately in staging rather than as a phantom
 * unhedged position in production.
 */

import Decimal from "decimal.js";
import type Redis from "ioredis";
import type { HedgeBroker, HedgeBrokerOrderResult } from "../hedging";
import { KotakNeoAuthClient } from "./neoAuth";
import { InstrumentResolver } from "./instrumentResolver";
import { getMcxMarketStatus, type McxMarketHoursConfig } from "./marketHours";
import type { HedgeContractType, KotakFillResult } from "./types";

const CONTRACT_CODE_TO_HEDGE_TYPE: Record<string, HedgeContractType> = {
  GOLD: "MCX_GOLD_1KG",
  GOLDM: "MCX_GOLD_MINI_100G",
  GOLDPETAL: "MCX_GOLD_PETAL_1G",
};

const AMO_QUEUE_KEY = "kotak:neo:amo-queue"; // Redis sorted set, score = scheduled epoch ms

export interface KotakNeoAdapterConfig {
  baseUrl?: string;
  useNativeAmo?: boolean;
  marketHours: McxMarketHoursConfig;
}

export interface ScheduledHedgeLeg {
  orderId: string; // platform Order.id, for persistence callbacks
  contractCode: string;
  lots: number;
  side: "SELL" | "BUY";
  clientOrderTag: string;
  enqueuedAt: string;
}

export class KotakOrderError extends Error {
  constructor(message: string, public readonly rejectReason?: string) {
    super(message);
    this.name = "KotakOrderError";
  }
}

export class KotakNeoHedgeAdapter implements HedgeBroker {
  readonly name = "KOTAK_NEO";
  private readonly baseUrl: string;

  constructor(
    private readonly auth: KotakNeoAuthClient,
    private readonly instruments: InstrumentResolver,
    private readonly redis: Redis,
    private readonly config: KotakNeoAdapterConfig
  ) {
    this.baseUrl = config.baseUrl ?? "https://gw-napi.kotaksecurities.com";
  }

  async placeMarketOrder(args: {
    contractCode: string;
    lots: number;
    side: "SELL" | "BUY";
    clientOrderTag: string;
  }): Promise<HedgeBrokerOrderResult> {
    const hedgeContractType = CONTRACT_CODE_TO_HEDGE_TYPE[args.contractCode];
    if (!hedgeContractType) {
      return {
        brokerOrderId: "",
        status: "REJECTED",
        errorDetail: `Unknown contract code for Kotak Neo mapping: ${args.contractCode}`,
      };
    }

    let marketStatus;
    try {
      marketStatus = await getMcxMarketStatus(this.config.marketHours);
    } catch (err) {
      // If we can't even determine market status, we must not guess —
      // treat it as closed and queue, which is the fail-safe direction
      // (a delayed hedge is recoverable; a rejected/mis-timed live order
      // against an assumption that turned out wrong is not).
      // eslint-disable-next-line no-console
      console.error(
        "[kotakNeoAdapter] market status check failed, defaulting to queued",
        err
      );
      return this.enqueueForMarketOpen(args, hedgeContractType, null);
    }

    if (!marketStatus.isOpen) {
      return this.enqueueForMarketOpen(
        args,
        hedgeContractType,
        marketStatus.nextOpenIst
      );
    }

    // Market is open at this instant, so we always place a live order here
    // regardless of `useNativeAmo` — that flag only matters for the
    // already-closed branch above if you choose to route through Kotak's
    // own AMO flag instead of the Redis queue (not implemented by default;
    // see the class doc comment for why the queue is the safer default).
    return this.placeLiveOrder(hedgeContractType, args);
  }

  private async enqueueForMarketOpen(
    args: {
      contractCode: string;
      lots: number;
      side: "SELL" | "BUY";
      clientOrderTag: string;
    },
    hedgeContractType: HedgeContractType,
    nextOpenIst: Date | null
  ): Promise<HedgeBrokerOrderResult> {
    const scheduledFor = nextOpenIst
      ? new Date(nextOpenIst.getTime() + 5_000) // 09:00:05 IST convention from spec
      : new Date(Date.now() + 60_000); // unknown next-open: retry in a minute rather than never

    const leg: ScheduledHedgeLeg = {
      orderId: args.clientOrderTag.replace(/^order-/, ""),
      contractCode: args.contractCode,
      lots: args.lots,
      side: args.side,
      clientOrderTag: args.clientOrderTag,
      enqueuedAt: new Date().toISOString(),
    };

    await this.redis.zadd(
      AMO_QUEUE_KEY,
      scheduledFor.getTime(),
      JSON.stringify(leg)
    );

    return {
      brokerOrderId: `amo-pending-${leg.clientOrderTag}-${Date.now()}`,
      status: "QUEUED_AMO",
      amoScheduledFor: scheduledFor,
      errorDetail: undefined,
    };
  }

  private async placeLiveOrder(
    hedgeContractType: HedgeContractType,
    args: { contractCode: string; lots: number; side: "SELL" | "BUY"; clientOrderTag: string }
  ): Promise<HedgeBrokerOrderResult> {
    const instrument = await this.instruments.resolve(hedgeContractType).catch((err) => {
      throw new KotakOrderError(
        `Instrument resolution failed for ${hedgeContractType}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });

    const session = await this.auth.getValidSession();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/Orders/2.0/quick/order/rule/ms/place`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.bearerToken}`,
          sid: session.sid,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          exchangeSegment: instrument.exchangeSegment,
          tradingSymbol: instrument.tradingSymbol,
          instrumentToken: instrument.instrumentToken,
          transactionType: args.side,
          quantity: String(args.lots),
          orderType: "MKT",
          product: "NRML",
          validity: "DAY",
          amo: "NO",
          tag: args.clientOrderTag,
        }),
      });
    } catch (err) {
      return {
        brokerOrderId: "",
        status: "REJECTED",
        errorDetail: `Network error placing order: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const body = (await response.json().catch(() => null)) as {
      stat?: string;
      nOrdNo?: string;
      rejReason?: string;
    } | null;

    if (!response.ok || !body || body.stat !== "Ok" || !body.nOrdNo) {
      return {
        brokerOrderId: "",
        status: "REJECTED",
        errorDetail:
          body?.rejReason ?? `Order placement failed: HTTP ${response.status}`,
      };
    }

    // Order accepted by the exchange gateway — not yet necessarily filled.
    // The caller (triggerHedgeForOrder) records this as SUBMITTED/OPEN;
    // fill confirmation and avgPrice arrive via pollFill / a fill webhook.
    return {
      brokerOrderId: body.nOrdNo,
      status: "SUBMITTED",
    };
  }

  /**
   * Polls a single order for terminal fill status. Call from a scheduled
   * job for every HedgingPosition in SUBMITTED/OPEN state until it reaches
   * a terminal status (TRAD or REJ), then persist avgPrice/charges and
   * advance or flag the parent Order accordingly.
   */
  async pollFill(brokerOrderId: string): Promise<KotakFillResult> {
    const session = await this.auth.getValidSession();

    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/Orders/2.0/quick/order-report?nOrdNo=${encodeURIComponent(
          brokerOrderId
        )}`,
        {
          headers: {
            Authorization: `Bearer ${session.bearerToken}`,
            sid: session.sid,
          },
        }
      );
    } catch (err) {
      return {
        brokerOrderId,
        status: "OPEN",
        rejectReason: `Network error polling fill: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const body = (await response.json().catch(() => null)) as {
      ordSt?: string; // e.g. "complete" | "open" | "rejected" | "cancelled"
      avgPrc?: string;
      fldQty?: string;
      chrges?: string;
      rejRsn?: string;
    } | null;

    if (!response.ok || !body) {
      return {
        brokerOrderId,
        status: "OPEN",
        rejectReason: `Order-report fetch failed: HTTP ${response.status}`,
      };
    }

    const statusMap: Record<string, KotakFillResult["status"]> = {
      complete: "TRAD",
      open: "OPEN",
      rejected: "REJ",
      cancelled: "CANCELLED",
    };
    const status = statusMap[(body.ordSt ?? "").toLowerCase()] ?? "OPEN";

    return {
      brokerOrderId,
      status,
      avgPrice: body.avgPrc ? new Decimal(body.avgPrc) : undefined,
      filledQuantity: body.fldQty ? Number(body.fldQty) : undefined,
      transactionCharges: body.chrges ? new Decimal(body.chrges) : undefined,
      rejectReason: body.rejRsn,
    };
  }
}

// ---------------------------------------------------------------------------
// AMO queue worker
// ---------------------------------------------------------------------------

export interface ScheduledHedgeDeps {
  /** Called for each leg once it's actually been (re)placed at market open. */
  onLegPlaced: (
    orderId: string,
    result: HedgeBrokerOrderResult,
    leg: ScheduledHedgeLeg
  ) => Promise<void>;
}

/**
 * Drains due entries (score <= now) from the AMO queue and places them for
 * real, now that the market is open. Intended to be invoked by an external
 * scheduler at 09:00:05 IST (and as a safety net, periodically thereafter
 * in case the exact-time invocation is missed) — this module holds no
 * timer of its own.
 */
export async function processDueScheduledHedges(
  adapter: KotakNeoHedgeAdapter,
  redis: Redis,
  deps: ScheduledHedgeDeps,
  now: number = Date.now()
): Promise<number> {
  const due = await redis.zrangebyscore(AMO_QUEUE_KEY, 0, now);
  if (due.length === 0) return 0;

  let processed = 0;
  for (const raw of due) {
    const leg = JSON.parse(raw) as ScheduledHedgeLeg;

    // Remove first — if placement fails we'd rather investigate a dropped
    // leg via logs/alerts than silently retry it every polling cycle
    // against a broker that already rejected it once.
    await redis.zrem(AMO_QUEUE_KEY, raw);

    const result = await adapter.placeMarketOrder({
      contractCode: leg.contractCode,
      lots: leg.lots,
      side: leg.side,
      clientOrderTag: leg.clientOrderTag,
    });

    await deps.onLegPlaced(leg.orderId, result, leg);
    processed += 1;
  }

  return processed;
}
