/**
 * Kotak Neo Live Quotes (LTP)
 * ---------------------------------------------------------------------------
 * Verified against OptionPal Pro's working kotak-market-data edge function
 * (fetchQuotesSDK, labeled there as "SDK-aligned config from
 * neo_api_client/urls.py & settings.py" — i.e. matched against Kotak's own
 * official Python SDK), rather than guessed.
 *
 *   GET {tradingBaseUrl}/script-details/1.0/quotes/neosymbol/{neoSymbols}/{quoteType}
 *
 *   neoSymbols: comma-separated "exchange_segment|instrument_token" pairs,
 *               URL-encoded as one path segment. For MCX gold futures this
 *               is "mcx_fo|{instrumentToken}" — OptionPal Pro only ever
 *               exercised nse_fo/nse_cm/bse_cm, so the mcx_fo segment
 *               string itself (lowercase, matching the other segments'
 *               convention) is inferred, not independently confirmed. If
 *               it doesn't match, the response's `stat`/`emsg` fields
 *               should say why — this function surfaces those rather than
 *               swallowing them.
 *   quoteType:  "ltp" | "ohlc" | "all" (lowercase)
 *
 *   Headers: Authorization: <raw consumerKey>, Auth: <accessToken>,
 *            sid: <session id>, neo-fin-key: "neotradeapi"
 *            (NOT "Authorization: Bearer <token>" — that convention is used
 *            by a couple of OTHER Kotak Neo endpoints in the same working
 *            codebase, e.g. order placement. The quotes endpoint specifically
 *            wants the split Authorization/Auth pair.)
 *
 * Response shape varies (OptionPal Pro's own comments note this): an array
 * directly, `{ message: [...] }`, or `{ data: [...] }`, with the price under
 * `ltp` / `last_traded_price` / `LastTradedPrice` / `lastPrice` depending on
 * which shape came back. parseLtp() below handles all of them the same way
 * OptionPal Pro's parseSpotFromQuote() does.
 *
 * Worth knowing: OptionPal Pro's own history shows 19 backup revisions of
 * this exact call before it was reliable for NSE — treat this as "verified
 * and working for NSE_CM/NSE_FO", not as a guarantee it works unmodified
 * for mcx_fo on the first attempt. Test against a real MCX token before
 * trusting it in the hedge-execution path.
 */

import Decimal from "decimal.js";
import type { KotakNeoAuthClient } from "./neoAuth";
import type { ResolvedInstrument, LtpQuote } from "./types";

const QUOTES_PATH = "script-details/1.0/quotes/neosymbol";

export class KotakQuoteError extends Error {
  constructor(message: string, public readonly detail?: unknown) {
    super(message);
    this.name = "KotakQuoteError";
  }
}

function parseLtp(quoteData: unknown): number {
  const arr = Array.isArray(quoteData)
    ? quoteData
    : (quoteData as { message?: unknown[]; data?: unknown[] })?.message ??
      (quoteData as { data?: unknown[] })?.data;
  const msg = (Array.isArray(arr) ? arr[0] : arr ?? quoteData) as
    | Record<string, unknown>
    | undefined;

  const raw =
    msg?.ltp ?? msg?.last_traded_price ?? msg?.LastTradedPrice ?? msg?.lastPrice ?? "0";
  return parseFloat(String(raw));
}

export async function fetchLtp(
  auth: KotakNeoAuthClient,
  instrument: ResolvedInstrument
): Promise<LtpQuote> {
  const session = await auth.getValidSession();

  const neoSymbol = `${instrument.exchangeSegment}|${instrument.instrumentToken}`;
  const url = `${session.tradingBaseUrl}/${QUOTES_PATH}/${encodeURIComponent(neoSymbol)}/ltp`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: session.consumerKey,
        Auth: session.accessToken,
        sid: session.sid,
        "neo-fin-key": "neotradeapi",
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new KotakQuoteError(
      `Network error fetching quote for ${neoSymbol}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const text = await response.text();

  if (response.status === 401 || response.status === 403) {
    throw new KotakQuoteError(
      `Kotak Neo session rejected (HTTP ${response.status}) fetching quote for ${neoSymbol} — session likely expired, needs re-login`
    );
  }

  if (!response.ok) {
    throw new KotakQuoteError(
      `Quote request failed: HTTP ${response.status} for ${neoSymbol}`,
      text.slice(0, 300)
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new KotakQuoteError(`Non-JSON quote response for ${neoSymbol}`, text.slice(0, 300));
  }

  const parsedObj = data as { fault?: unknown; stat?: string; emsg?: string };
  if (parsedObj?.fault) {
    throw new KotakQuoteError(`Quote request rejected (fault) for ${neoSymbol}`, parsedObj.fault);
  }
  if (parsedObj?.stat === "Not_Ok") {
    throw new KotakQuoteError(
      `Quote request rejected: ${parsedObj.emsg ?? "unknown reason"} for ${neoSymbol}`
    );
  }

  const ltp = parseLtp(data);
  if (!ltp || ltp <= 0) {
    throw new KotakQuoteError(
      `Quote response for ${neoSymbol} did not contain a usable LTP`,
      text.slice(0, 300)
    );
  }

  return {
    instrumentToken: instrument.instrumentToken,
    tradingSymbol: instrument.tradingSymbol,
    ltp: new Decimal(ltp),
    fetchedAt: new Date(),
  };
}
