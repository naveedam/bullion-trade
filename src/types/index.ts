import Decimal from "decimal.js";

export type Metal = "GOLD" | "SILVER";

/** Live feed snapshot — the three inputs the pricing engine depends on. */
export interface MarketFeedSnapshot {
  baseSpotUsdPerOz: Decimal; // LBMA Loco London / COMEX, USD per troy oz
  usdInrRate: Decimal; // interbank USD/INR
  mcxFuturesPerGram: Decimal; // domestic MCX gold futures, INR per gram (sanity-check reference)
  asOf: Date;
}

export interface PricingInputs {
  metal: Metal;
  volumeGrams: Decimal;
  customsDutyFactor: Decimal; // e.g. 0.06 for 6%
  refinerPremiumInrPerGram: Decimal;
  platformMarkupBps: number; // 20-30 bps per spec
}

export interface PriceBreakdown {
  baseSpotPerGramInr: Decimal;
  customsAdjustedPerGramInr: Decimal;
  refinerPremiumInr: Decimal;
  platformMarkupInr: Decimal;
  askPricePerGramInr: Decimal; // final "Gross Ask Price/gram"
  grossAmountInr: Decimal; // askPricePerGram * volumeGrams
  gstAmountInr: Decimal; // 3% statutory
  tcsAmountInr: Decimal; // Section 206C(1H), only above threshold + no PAN exemption
  courierChargeInr: Decimal;
  netPayableInr: Decimal;
  quoteId: string;
  generatedAt: Date;
}

export interface RateLockRequest {
  userId: string;
  metal: Metal;
  volumeGrams: Decimal;
  quoteId: string;
}

export interface RateLockResult {
  lockToken: string;
  quoteId: string;
  ratePerGram: Decimal;
  volumeGrams: Decimal;
  acquiredAt: Date;
  expiresAt: Date;
  ttlMs: number;
}

export type OrderStatus =
  | "PENDING_LOCK"
  | "LOCKED"
  | "FUNDED"
  | "AWAITING_MARKET_OPEN"
  | "HEDGED"
  | "HEDGE_FAILED"
  | "DISPATCHED"
  | "COMPLETED"
  | "CANCELLED"
  | "LOCK_EXPIRED";

export interface SettlementWebhookPayload {
  bankRefNumber: string;
  vanNumber: string;
  amountInr: string; // string over the wire, parsed to Decimal
  utrNumber?: string;
  orderId: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface HedgeOrderRequest {
  orderId: string;
  metal: Metal;
  volumeGrams: Decimal;
  side: "SELL" | "BUY";
}

export interface HedgeOrderResult {
  brokerOrderId: string;
  broker: string;
  contractType: string;
  lots: Decimal;
  status: "SUBMITTED" | "FILLED" | "PARTIALLY_FILLED" | "REJECTED" | "CANCELLED";
  executionPrice?: Decimal;
  errorDetail?: string;
}
