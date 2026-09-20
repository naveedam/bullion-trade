/**
 * Dynamic Spot Pricing Calculator
 * ---------------------------------------------------------------------------
 * Converts a live market feed snapshot into a fully-loaded, GST/TCS-inclusive
 * per-gram ask price. All arithmetic uses decimal.js — never native floats —
 * because paisa-level rounding errors compound badly across thousands of
 * daily quotes and are the kind of bug that shows up as a reconciliation
 * mismatch weeks later, not a crash today.
 *
 * Formula (per spec):
 *   Gross Ask Price/gram =
 *     [(Base Spot / 31.1035) * (1 + Customs Duty Factor) * USDINR]
 *     + Refiner Premium + Platform Markup (20-30 bps)
 */

import Decimal from "decimal.js";
import type {
  MarketFeedSnapshot,
  PricingInputs,
  PriceBreakdown,
} from "../types";

// Troy ounce to gram conversion — fixed constant, not configurable.
const GRAMS_PER_TROY_OUNCE = new Decimal("31.1035");

// Statutory rates
const GST_RATE = new Decimal("0.03"); // 3% per HSN 7108 (gold) / 7106 (silver)

// Section 206C(1H): 0.1% TCS on receipts above ₹50,00,000 in a financial year
// (seller-side, buyer PAN available). This module applies the marginal rate
// to the order only; cumulative-threshold tracking against the buyer's
// running annual receipts must be done by the ledger service, not here —
// pass `alreadyCollectedThisFy` so we only tax the amount above threshold.
const TCS_RATE = new Decimal("0.001");
const TCS_THRESHOLD_INR = new Decimal("5000000");

export function computeAskPricePerGram(
  feed: MarketFeedSnapshot,
  inputs: Pick<
    PricingInputs,
    "customsDutyFactor" | "refinerPremiumInrPerGram" | "platformMarkupBps"
  >
): {
  baseSpotPerGramInr: Decimal;
  customsAdjustedPerGramInr: Decimal;
  refinerPremiumInr: Decimal;
  platformMarkupInr: Decimal;
  askPricePerGramInr: Decimal;
} {
  const baseSpotPerGramUsd = feed.baseSpotUsdPerOz.dividedBy(
    GRAMS_PER_TROY_OUNCE
  );

  const customsAdjustedPerGramUsd = baseSpotPerGramUsd.times(
    new Decimal(1).plus(inputs.customsDutyFactor)
  );

  const customsAdjustedPerGramInr = customsAdjustedPerGramUsd.times(
    feed.usdInrRate
  );

  // platformMarkupBps is basis points of the customs-adjusted INR price,
  // e.g. 25 bps => 0.25% of the pre-premium price.
  const platformMarkupInr = customsAdjustedPerGramInr
    .times(inputs.platformMarkupBps)
    .dividedBy(10000);

  const askPricePerGramInr = customsAdjustedPerGramInr
    .plus(inputs.refinerPremiumInrPerGram)
    .plus(platformMarkupInr);

  return {
    baseSpotPerGramInr: baseSpotPerGramUsd.times(feed.usdInrRate),
    customsAdjustedPerGramInr,
    refinerPremiumInr: inputs.refinerPremiumInrPerGram,
    platformMarkupInr,
    askPricePerGramInr,
  };
}

export interface FullQuoteOptions {
  courierChargeInr?: Decimal;
  alreadyCollectedThisFyInr?: Decimal; // running TCS-relevant receipts for this buyer
  quoteId: string;
}

export function buildFullQuote(
  feed: MarketFeedSnapshot,
  inputs: PricingInputs,
  options: FullQuoteOptions
): PriceBreakdown {
  if (inputs.platformMarkupBps < 20 || inputs.platformMarkupBps > 30) {
    throw new PricingError(
      `platformMarkupBps must be within [20,30], got ${inputs.platformMarkupBps}`
    );
  }
  if (inputs.volumeGrams.lessThanOrEqualTo(0)) {
    throw new PricingError("volumeGrams must be positive");
  }

  const priced = computeAskPricePerGram(feed, inputs);
  const grossAmountInr = priced.askPricePerGramInr
    .times(inputs.volumeGrams)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const gstAmountInr = grossAmountInr
    .times(GST_RATE)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const courierChargeInr = (options.courierChargeInr ?? new Decimal(0)).toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP
  );

  const tcsAmountInr = computeTcs(
    grossAmountInr,
    options.alreadyCollectedThisFyInr ?? new Decimal(0)
  );

  const netPayableInr = grossAmountInr
    .plus(gstAmountInr)
    .plus(tcsAmountInr)
    .plus(courierChargeInr)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    baseSpotPerGramInr: priced.baseSpotPerGramInr.toDecimalPlaces(4),
    customsAdjustedPerGramInr: priced.customsAdjustedPerGramInr.toDecimalPlaces(4),
    refinerPremiumInr: priced.refinerPremiumInr.toDecimalPlaces(4),
    platformMarkupInr: priced.platformMarkupInr.toDecimalPlaces(4),
    askPricePerGramInr: priced.askPricePerGramInr.toDecimalPlaces(4),
    grossAmountInr,
    gstAmountInr,
    tcsAmountInr,
    courierChargeInr,
    netPayableInr,
    quoteId: options.quoteId,
    generatedAt: new Date(),
  };
}

/**
 * TCS under 206C(1H) is charged only on the portion of this FY's cumulative
 * receipts from this buyer that exceeds ₹50L. Given the running total
 * already collected against, compute how much of *this* order's gross
 * amount falls above the remaining threshold headroom.
 */
function computeTcs(
  orderGrossInr: Decimal,
  alreadyCollectedThisFyInr: Decimal
): Decimal {
  const headroom = Decimal.max(
    0,
    TCS_THRESHOLD_INR.minus(alreadyCollectedThisFyInr)
  );
  const taxableAmount = Decimal.max(0, orderGrossInr.minus(headroom));
  return taxableAmount.times(TCS_RATE).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}
