import Decimal from "decimal.js";

/**
 * Logical hedge contract identifiers used throughout the platform. These are
 * stable regardless of which specific expiry is currently the active
 * near-month contract — the instrument resolver maps each of these to a
 * concrete `tradingSymbol` + `instrumentToken` that changes as contracts
 * roll.
 */
export type HedgeContractType =
  | "MCX_GOLD_1KG"
  | "MCX_GOLD_MINI_100G"
  | "MCX_GOLD_PETAL_1G";

export const HEDGE_CONTRACT_SPECS: Record<
  HedgeContractType,
  { baseSymbol: string; multiplierGrams: Decimal }
> = {
  MCX_GOLD_1KG: { baseSymbol: "GOLD", multiplierGrams: new Decimal(1000) },
  MCX_GOLD_MINI_100G: { baseSymbol: "GOLDM", multiplierGrams: new Decimal(100) },
  MCX_GOLD_PETAL_1G: { baseSymbol: "GOLDPETAL", multiplierGrams: new Decimal(1) },
};

/** A resolved, tradable instrument for a given logical contract type. */
export interface ResolvedInstrument {
  hedgeContractType: HedgeContractType;
  tradingSymbol: string; // e.g. "GOLDM26FEBFUT"
  instrumentToken: string; // Kotak Neo numeric/token identifier
  exchangeSegment: "mcx_fo";
  lotSize: number; // units per lot, exchange-defined (may differ from gram multiplier)
  multiplierGrams: Decimal; // grams represented by one lot
  expiryDate: string; // ISO date
  tenderPeriodStart: string; // ISO date — first day the contract is delivery-only
  resolvedAt: Date;
}

export type McxSessionWindow = "MORNING" | "EVENING" | "CLOSED";

export interface McxMarketStatus {
  isOpen: boolean;
  session: McxSessionWindow;
  isHoliday: boolean;
  nowIst: Date;
  nextOpenIst: Date | null;
}

export type KotakOrderStatus = "TRAD" | "OPEN" | "REJ" | "AMO_QUEUED" | "CANCELLED";

export interface KotakPlaceOrderArgs {
  hedgeContractType: HedgeContractType;
  lots: number;
  side: "SELL" | "BUY";
  clientOrderTag: string;
}

export interface KotakPlaceOrderResult {
  brokerOrderId: string;
  status: KotakOrderStatus;
  tradingSymbol: string;
  instrumentToken: string;
  rejectReason?: string;
  amoScheduledFor?: Date;
}

export interface KotakFillResult {
  brokerOrderId: string;
  status: "TRAD" | "OPEN" | "REJ" | "CANCELLED";
  avgPrice?: Decimal;
  filledQuantity?: number;
  transactionCharges?: Decimal;
  rejectReason?: string;
}
