/**
 * MCX Instrument Master & Token Resolver
 * ---------------------------------------------------------------------------
 * Rewritten against OptionPal Pro's verified kotak-scrip-master
 * implementation. Two corrections from the first draft:
 *
 *   1. This is a TWO-STEP fetch, not a direct CSV URL:
 *        Step 1 - GET {tradingBaseUrl}/script-details/1.0/masterscrip/file-paths
 *                 headers: Authorization: Bearer <accessToken>, sid, neo-fin-key
 *                 -> { filesPaths: [{ path/filePath/url, ... }, ...] }
 *        Step 2 - GET whichever returned path contains "mcx_fo" (no auth
 *                 headers needed for this one - it's a direct CSV download
 *                 off a file host, per OptionPal Pro's own working code).
 *      There is no fixed, guessable CSV URL - it's issued per-session by
 *      step 1 and can change.
 *   2. There's no clean instrument_type / symbol column to rely on.
 *      OptionPal Pro's real CSV has unpredictable, broker-internal column
 *      names (their code fuzzy-matches headers by substring - "token",
 *      "psymbol", "ptrdsymbol", etc. - because the exact names aren't
 *      documented anywhere they could find). The same approach is used
 *      here. Row identification for a specific contract (GOLD vs GOLDM vs
 *      GOLDPETAL) then can't rely on a clean base-symbol column either -
 *      it has to pattern-match the trading-symbol-like column directly,
 *      which is genuinely ambiguous: "GOLD" is a string-prefix of
 *      "GOLDM", "GOLDPETAL", and "GOLDGUINEA" alike. The regex below
 *      requires the base symbol to be followed immediately by a digit
 *      (the start of the expiry date, e.g. "GOLD25FEBFUT" vs
 *      "GOLDM25FEBFUT") to disambiguate - a reasonable but NOT verified
 *      heuristic, since OptionPal Pro never exercised mcx_fo rows.
 *
 * If resolution fails, the error includes the actual CSV header row seen,
 * specifically so a real run against a real MCX file can be diagnosed and
 * the column matchers adjusted quickly, rather than guessing blind again.
 */

import type Redis from "ioredis";
import type { HedgeContractType, ResolvedInstrument } from "./types";
import { HEDGE_CONTRACT_SPECS } from "./types";
import type { KotakNeoAuthClient } from "./neoAuth";

const REDIS_KEY_PREFIX = "kotak:neo:instrument:";
const CACHE_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_TENDER_NOTICE_DAYS = 5;
const SCRIP_MASTER_PATHS_ENDPOINT = "script-details/1.0/masterscrip/file-paths";

interface RawScripRow {
  tradingSymbol: string;
  instrumentToken: string;
  expiryDate: string;
  lotSize: number;
}

export interface InstrumentResolverConfig {
  tenderNoticeDays?: number;
}

export class InstrumentResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstrumentResolutionError";
  }
}

export class InstrumentResolver {
  private readonly tenderNoticeDays: number;

  constructor(
    private readonly authClient: KotakNeoAuthClient,
    config: InstrumentResolverConfig,
    private readonly redis: Redis
  ) {
    this.tenderNoticeDays = config.tenderNoticeDays ?? DEFAULT_TENDER_NOTICE_DAYS;
  }

  async resolve(hedgeContractType: HedgeContractType): Promise<ResolvedInstrument> {
    const cached = await this.readCache(hedgeContractType);
    if (cached) return cached;

    const rows = await this.fetchAndParseMaster();
    const spec = HEDGE_CONTRACT_SPECS[hedgeContractType];

    const symbolPattern = new RegExp(`^${escapeRegExp(spec.baseSymbol)}\\d`);
    const isFuture = (tradingSymbol: string) => tradingSymbol.toUpperCase().endsWith("FUT");

    const candidates = rows.filter(
      (r) =>
        symbolPattern.test(r.tradingSymbol.toUpperCase()) &&
        isFuture(r.tradingSymbol) &&
        new Date(r.expiryDate).getTime() > Date.now()
    );

    if (candidates.length === 0) {
      throw new InstrumentResolutionError(
        `No live futures contract found for ${hedgeContractType} (base symbol ${spec.baseSymbol}) in the mcx_fo master scrip file. ` +
          `This most likely means the column-matching or symbol-pattern heuristics in this file don't match the real CSV format - ` +
          `check a sample row from the actual mcx_fo file and adjust parseMasterScripCsv() / the symbolPattern regex above.`
      );
    }

    const now = Date.now();
    const nonTender = candidates.filter((r) => {
      const tenderStart =
        new Date(r.expiryDate).getTime() - this.tenderNoticeDays * 24 * 60 * 60 * 1000;
      return now < tenderStart;
    });

    const pool = nonTender.length > 0 ? nonTender : candidates;
    if (nonTender.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[instrumentResolver] all ${hedgeContractType} contracts are within the tender window — falling back to nearest anyway; verify against the live contract calendar before relying on this in production`
      );
    }

    pool.sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
    const chosen = pool[0];

    const resolved: ResolvedInstrument = {
      hedgeContractType,
      tradingSymbol: chosen.tradingSymbol,
      instrumentToken: chosen.instrumentToken,
      exchangeSegment: "mcx_fo",
      lotSize: chosen.lotSize,
      multiplierGrams: spec.multiplierGrams,
      expiryDate: chosen.expiryDate,
      tenderPeriodStart: new Date(
        new Date(chosen.expiryDate).getTime() - this.tenderNoticeDays * 24 * 60 * 60 * 1000
      ).toISOString(),
      resolvedAt: new Date(),
    };

    await this.writeCache(hedgeContractType, resolved);
    return resolved;
  }

  private cacheKey(hedgeContractType: HedgeContractType): string {
    return `${REDIS_KEY_PREFIX}${hedgeContractType}`;
  }

  private async readCache(
    hedgeContractType: HedgeContractType
  ): Promise<ResolvedInstrument | null> {
    const raw = await this.redis.get(this.cacheKey(hedgeContractType));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ResolvedInstrument;
      if (new Date(parsed.tenderPeriodStart).getTime() <= Date.now()) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeCache(
    hedgeContractType: HedgeContractType,
    resolved: ResolvedInstrument
  ): Promise<void> {
    await this.redis.set(
      this.cacheKey(hedgeContractType),
      JSON.stringify(resolved),
      "EX",
      CACHE_TTL_SECONDS
    );
  }

  private async fetchAndParseMaster(): Promise<RawScripRow[]> {
    const session = await this.authClient.getValidSession();

    let pathsResponse: Response;
    try {
      pathsResponse = await fetch(`${session.tradingBaseUrl}/${SCRIP_MASTER_PATHS_ENDPOINT}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "neo-fin-key": "neotradeapi",
          sid: session.sid,
        },
      });
    } catch (err) {
      throw new InstrumentResolutionError(
        `Network error fetching scrip master file paths: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    if (!pathsResponse.ok) {
      throw new InstrumentResolutionError(
        `Scrip master file-paths request failed: HTTP ${pathsResponse.status}`
      );
    }

    const pathsData = (await pathsResponse.json().catch(() => null)) as {
      filesPaths?: unknown[];
      data?: { filesPaths?: unknown[] };
      result?: unknown[];
    } | null;

    const fileList = pathsData?.filesPaths ?? pathsData?.data?.filesPaths ?? pathsData?.result ?? [];

    let mcxCsvUrl = "";
    if (Array.isArray(fileList)) {
      for (const item of fileList) {
        const entry = item as { path?: string; filePath?: string; url?: string };
        const path = entry?.path ?? entry?.filePath ?? entry?.url ?? "";
        if (typeof path === "string" && path.includes("mcx_fo")) {
          mcxCsvUrl = path;
          break;
        }
      }
    }

    if (!mcxCsvUrl) {
      throw new InstrumentResolutionError(
        `No "mcx_fo" entry found in the scrip master file-paths response: ${JSON.stringify(
          pathsData
        ).slice(0, 500)}`
      );
    }

    let csvResponse: Response;
    try {
      csvResponse = await fetch(mcxCsvUrl);
    } catch (err) {
      throw new InstrumentResolutionError(
        `Network error downloading mcx_fo scrip master CSV: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    if (!csvResponse.ok) {
      throw new InstrumentResolutionError(
        `mcx_fo scrip master CSV download failed: HTTP ${csvResponse.status}`
      );
    }

    const csv = await csvResponse.text();
    return parseMasterScripCsv(csv);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseMasterScripCsv(csv: string): RawScripRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headerLine = lines[0]?.toLowerCase() ?? "";
  const cols = headerLine.split(",");

  const tokenIdx = cols.findIndex(
    (h) => h.includes("token") || h.includes("instrument_token") || h.includes("psymbol")
  );
  // Excludes tokenIdx explicitly — a column like "pSymbol" can satisfy
  // both this pattern and the token pattern above (it contains both
  // "symbol" and, literally, "psymbol"), so without this exclusion the
  // two fields collide on the same column. Caught by a smoke test against
  // a synthetic CSV using that exact header style.
  const symbolIdx = cols.findIndex(
    (h, i) =>
      i !== tokenIdx &&
      (h.includes("symbol") || h.includes("trading_symbol") || h.includes("ptrdsymbol"))
  );
  const expiryIdx = cols.findIndex(
    (h) => h.includes("expiry") || h.includes("pexpirydate") || h.includes("dexpiry")
  );
  const lotSizeIdx = cols.findIndex(
    (h) => h.includes("lot") || h.includes("lotsize") || h.includes("boardlotqty")
  );

  if (tokenIdx < 0 || symbolIdx < 0 || expiryIdx < 0) {
    throw new InstrumentResolutionError(
      `Could not find token/symbol/expiry columns in the mcx_fo CSV header. Header row seen: "${lines[0]}"`
    );
  }

  const rows: RawScripRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",");
    if (row.length <= Math.max(tokenIdx, symbolIdx, expiryIdx)) continue;

    const tradingSymbol = row[symbolIdx]?.trim().toUpperCase() ?? "";
    const instrumentToken = row[tokenIdx]?.trim() ?? "";
    const expiryRaw = row[expiryIdx]?.trim() ?? "";
    const lotSize = lotSizeIdx >= 0 ? parseInt(row[lotSizeIdx] ?? "0", 10) : 0;

    if (!tradingSymbol || !instrumentToken || !expiryRaw) continue;

    const expiryDate = normalizeExpiry(expiryRaw);
    if (!expiryDate) continue;

    rows.push({ tradingSymbol, instrumentToken, expiryDate, lotSize });
  }

  return rows;
}

function normalizeExpiry(raw: string): string | null {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
