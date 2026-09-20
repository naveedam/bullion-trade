/**
 * MCX Instrument Master & Token Resolver
 * ---------------------------------------------------------------------------
 * Kotak Neo publishes a per-segment scrip master (commonly a CSV, refreshed
 * once daily before market open) listing every tradable instrument on that
 * segment along with its `instrumentToken`, `tradingSymbol`, lot size, and
 * expiry. This module downloads that file for the `mcx_fo` segment, parses
 * it, and resolves each of our logical `HedgeContractType`s to the specific
 * contract we should actually be sending orders against today.
 *
 * "Active, most liquid near-month" resolution rule used here:
 *   1. Filter to rows whose base symbol matches (GOLD / GOLDM / GOLDPETAL)
 *      and instrument type is FUTCOM (commodity future).
 *   2. Drop any contract that has already entered its tender/delivery
 *      period — once a compulsory-delivery contract enters tender, trading
 *      volume collapses and the price can decouple from spot, so hedging
 *      against it defeats the purpose. Tender start is modelled as
 *      `expiryDate - tenderNoticeDays`; MCX publishes the exact tender
 *      start date per contract in its contract specification circular —
 *      the calendar-offset approximation here is a fallback and should be
 *      replaced with the exchange's published date wherever the master
 *      file (or a synced circular table) provides it directly.
 *   3. Among what's left, pick the soonest-expiring contract (near-month)
 *      as the liquidity proxy — near-month is conventionally the most
 *      liquid MCX gold contract outside of contract-roll week.
 *
 * The resolved instrument set is cached in Redis with a TTL tied to the
 * master file's own daily refresh cadence, so repeated hedge triggers
 * within a trading day don't re-download and re-parse the master file on
 * every single order.
 */

import type Redis from "ioredis";
import type { HedgeContractType, ResolvedInstrument } from "./types";
import { HEDGE_CONTRACT_SPECS } from "./types";

const REDIS_KEY_PREFIX = "kotak:neo:instrument:";
const CACHE_TTL_SECONDS = 12 * 60 * 60; // half a trading day; master refreshes daily
const DEFAULT_TENDER_NOTICE_DAYS = 5;

interface RawScripRow {
  tradingSymbol: string;
  instrumentToken: string;
  exchangeSegment: string;
  instrumentType: string;
  baseSymbol: string; // parsed out of tradingSymbol / a dedicated column if present
  expiryDate: string; // ISO
  lotSize: number;
}

export interface InstrumentResolverConfig {
  masterScripUrl?: string; // e.g. "https://gw-napi.kotaksecurities.com/masterscrip/mcx_fo.csv"
  tenderNoticeDays?: number;
  bearerTokenProvider: () => Promise<string>;
}

export class InstrumentResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstrumentResolutionError";
  }
}

export class InstrumentResolver {
  private readonly masterScripUrl: string;
  private readonly tenderNoticeDays: number;

  constructor(
    private readonly config: InstrumentResolverConfig,
    private readonly redis: Redis
  ) {
    this.masterScripUrl =
      config.masterScripUrl ??
      "https://gw-napi.kotaksecurities.com/masterscrip/mcx_fo.csv";
    this.tenderNoticeDays = config.tenderNoticeDays ?? DEFAULT_TENDER_NOTICE_DAYS;
  }

  async resolve(hedgeContractType: HedgeContractType): Promise<ResolvedInstrument> {
    const cached = await this.readCache(hedgeContractType);
    if (cached) return cached;

    const rows = await this.fetchAndParseMaster();
    const spec = HEDGE_CONTRACT_SPECS[hedgeContractType];

    const candidates = rows.filter(
      (r) =>
        r.baseSymbol === spec.baseSymbol &&
        r.instrumentType === "FUTCOM" &&
        new Date(r.expiryDate).getTime() > Date.now()
    );

    if (candidates.length === 0) {
      throw new InstrumentResolutionError(
        `No live futures contract found for ${hedgeContractType} (base symbol ${spec.baseSymbol}) in the master scrip file`
      );
    }

    const now = Date.now();
    const nonTender = candidates.filter((r) => {
      const tenderStart =
        new Date(r.expiryDate).getTime() -
        this.tenderNoticeDays * 24 * 60 * 60 * 1000;
      return now < tenderStart;
    });

    const pool = nonTender.length > 0 ? nonTender : candidates;
    if (nonTender.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[instrumentResolver] all ${hedgeContractType} contracts are within the tender window — falling back to nearest anyway; verify against the live contract calendar before relying on this in production`
      );
    }

    pool.sort(
      (a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime()
    );
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
        new Date(chosen.expiryDate).getTime() -
          this.tenderNoticeDays * 24 * 60 * 60 * 1000
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
      // Never serve a cached contract past its tender start, even if the
      // Redis TTL hasn't lapsed yet — the tender boundary is a hard business
      // rule, not just a cache-freshness concern.
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
    const bearerToken = await this.config.bearerTokenProvider();

    let response: Response;
    try {
      response = await fetch(this.masterScripUrl, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
    } catch (err) {
      throw new InstrumentResolutionError(
        `Network error fetching master scrip file: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    if (!response.ok) {
      throw new InstrumentResolutionError(
        `Master scrip fetch failed: HTTP ${response.status}`
      );
    }

    const csv = await response.text();
    return parseMasterScripCsv(csv);
  }
}

/**
 * Minimal CSV parser for the master scrip file. Assumes the broker's export
 * has no embedded commas/quotes within fields (typical for scrip masters,
 * which are machine-generated with plain alphanumeric fields) — if that
 * assumption doesn't hold for your actual export, swap this for a proper
 * CSV library (e.g. papaparse) rather than hardening this by hand.
 *
 * Expected columns (header row, order-independent, matched by name):
 *   trading_symbol, instrument_token, exchange_segment, instrument_type,
 *   symbol, expiry, lot_size
 */
export function parseMasterScripCsv(csv: string): RawScripRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);

  const idx = {
    tradingSymbol: col("trading_symbol"),
    instrumentToken: col("instrument_token"),
    exchangeSegment: col("exchange_segment"),
    instrumentType: col("instrument_type"),
    symbol: col("symbol"),
    expiry: col("expiry"),
    lotSize: col("lot_size"),
  };

  const missing = Object.entries(idx)
    .filter(([, i]) => i === -1)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new InstrumentResolutionError(
      `Master scrip CSV is missing expected column(s): ${missing.join(", ")} — verify the export format against the current API docs`
    );
  }

  const rows: RawScripRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < header.length) continue;

    const exchangeSegment = cells[idx.exchangeSegment]?.trim().toLowerCase();
    if (exchangeSegment !== "mcx_fo") continue;

    rows.push({
      tradingSymbol: cells[idx.tradingSymbol]?.trim(),
      instrumentToken: cells[idx.instrumentToken]?.trim(),
      exchangeSegment,
      instrumentType: cells[idx.instrumentType]?.trim().toUpperCase(),
      baseSymbol: cells[idx.symbol]?.trim().toUpperCase(),
      expiryDate: normalizeExpiry(cells[idx.expiry]?.trim()),
      lotSize: Number(cells[idx.lotSize]?.trim()),
    });
  }
  return rows;
}

function normalizeExpiry(raw: string): string {
  // Master files commonly express expiry as DD-MMM-YYYY (e.g. "26-FEB-2026").
  // Normalize to ISO so downstream Date comparisons are unambiguous.
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new InstrumentResolutionError(`Unparseable expiry date: "${raw}"`);
  }
  return parsed.toISOString();
}
