/**
 * MCX Pricing Service
 * ---------------------------------------------------------------------------
 * Converts a live MCX gold futures LTP into a per-gram INR price, using the
 * canonical GOLD (1kg) contract as the reference - chosen for its deeper
 * institutional open interest over Gold Mini, per the platform's pricing
 * decision (see README).
 *
 * The one thing this file must never get wrong: GOLD and GOLDM are both
 * quoted per 10 grams on MCX, not per their lot size (1000g / 100g
 * respectively) - see HEDGE_CONTRACT_SPECS in types.ts for the full
 * breakdown and citation. quotationUnitGrams is applied here, explicitly,
 * rather than inferring a divisor from context.
 */

import Decimal from "decimal.js";
import { HEDGE_CONTRACT_SPECS } from "./types";
import type { HedgeContractType } from "./types";
import type { InstrumentResolver } from "./instrumentResolver";
import type { KotakNeoAuthClient } from "./neoAuth";
import { fetchLtp } from "./quotes";

export const CANONICAL_GOLD_REFERENCE: HedgeContractType = "MCX_GOLD_1KG";

export interface McxPriceResult {
  pricePerGramInr: Decimal;
  tradingSymbol: string;
  instrumentToken: string;
  ltp: Decimal;
  quotationUnitGrams: Decimal;
  fetchedAt: Date;
}

export async function getMcxGoldPricePerGram(
  authClient: KotakNeoAuthClient,
  instrumentResolver: InstrumentResolver,
  hedgeContractType: HedgeContractType = CANONICAL_GOLD_REFERENCE
): Promise<McxPriceResult> {
  const instrument = await instrumentResolver.resolve(hedgeContractType);
  const quote = await fetchLtp(authClient, instrument);
  const spec = HEDGE_CONTRACT_SPECS[hedgeContractType];

  return {
    pricePerGramInr: quote.ltp.dividedBy(spec.quotationUnitGrams),
    tradingSymbol: instrument.tradingSymbol,
    instrumentToken: instrument.instrumentToken,
    ltp: quote.ltp,
    quotationUnitGrams: spec.quotationUnitGrams,
    fetchedAt: quote.fetchedAt,
  };
}
