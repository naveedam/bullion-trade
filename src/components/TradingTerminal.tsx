"use client";

import { useEffect, useRef, useState } from "react";
import { RateLockTimer } from "./RateLockTimer";
import { VolumeSelector } from "./VolumeSelector";
import { BreakdownDrawer } from "./BreakdownDrawer";
import { VanPaymentPanel } from "./VanPaymentPanel";

interface TickSnapshot {
  metal: "GOLD" | "SILVER";
  quoteId: string;
  baseSpotPerGramInr: string;
  customsAdjustedPerGramInr: string;
  refinerPremiumInr: string;
  platformMarkupInr: string;
  askPricePerGramInr: string;
  baseSpotUsdPerOz: string;
  usdInrRate: string;
  generatedAt: string;
  stale: boolean;
}

interface RateLockState {
  ratePerGram: number;
  expiresAt: Date;
  quoteId: string;
}

/**
 * There's no real auth in this scaffold yet, so trades are attributed to a
 * per-browser id persisted in localStorage — good enough to exercise the
 * rate-lock flow end to end, but this needs to become an actual logged-in
 * user/entity id (see the Entity/User models in prisma/schema.prisma)
 * before this goes anywhere near a real order.
 */
function getDemoUserId(): string {
  if (typeof window === "undefined") return "server";
  const key = "bullion-demo-user-id";
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(key, id);
  }
  return id;
}

export function TradingTerminal() {
  const [metal, setMetal] = useState<"GOLD" | "SILVER">("GOLD");
  const [volumeGrams, setVolumeGrams] = useState(1000);
  const [tick, setTick] = useState<TickSnapshot | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);
  const [lock, setLock] = useState<RateLockState | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const lockRef = useRef<RateLockState | null>(null);
  lockRef.current = lock;

  // Poll the live tick endpoint. Freezes while a rate is locked, since the
  // quote shouldn't visibly move once the price is fixed for this order.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (lockRef.current) return;
      try {
        const res = await fetch(`/api/tick?metal=${metal}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as TickSnapshot;
        if (!cancelled) {
          setTick(data);
          setTickError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setTickError(err instanceof Error ? err.message : "Failed to fetch live price");
        }
      }
    }

    poll();
    const interval = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [metal, lock]);

  // Reset the tick when the metal changes so stale-metal prices never flash.
  useEffect(() => {
    setTick(null);
    setLock(null);
  }, [metal]);

  async function handleLock() {
    if (!tick) return;
    setLockPending(true);
    setLockError(null);
    try {
      const res = await fetch("/api/rate-lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: getDemoUserId(),
          metal,
          volumeGrams: String(volumeGrams),
          quoteId: tick.quoteId,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setLock({
        ratePerGram: Number(body.ratePerGram),
        expiresAt: new Date(body.expiresAt),
        quoteId: body.quoteId,
      });
    } catch (err) {
      setLockError(
        err instanceof Error ? err.message : "Failed to lock rate — try again"
      );
    } finally {
      setLockPending(false);
    }
  }

  function handleExpire() {
    setLock(null);
  }

  const displayTick = tick;
  const displayRate = lock ? lock.ratePerGram : Number(displayTick?.askPricePerGramInr ?? 0);
  const customsAdjustedPerGramInr = Number(displayTick?.customsAdjustedPerGramInr ?? 0);
  const refinerPremiumPerGram = Number(displayTick?.refinerPremiumInr ?? 0);
  const platformMarkupInr = Number(displayTick?.platformMarkupInr ?? 0);

  const grossAmount = displayRate * volumeGrams;
  const gstAmount = grossAmount * 0.03;
  const courierCharge = volumeGrams >= 1000 ? 3500 : 1200;
  const netPayable = grossAmount + gstAmount + courierCharge;

  return (
    <div className="min-h-screen bg-graphite-950 text-parchment">
      <header className="border-b border-hairline px-6 py-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-medium">Bullion Trading Terminal</h1>
          <p className="text-xs text-parchment-dim">
            Wholesale settlement · {metal === "GOLD" ? "Gold" : "Silver"} ·
            999.9 fine
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-parchment-dim">
            Live spot{displayTick?.stale ? " (last known)" : ""}
          </p>
          {displayTick ? (
            <p className="font-numeric text-sm text-bullion-silver">
              ${Number(displayTick.baseSpotUsdPerOz).toFixed(2)} / oz · ₹
              {Number(displayTick.usdInrRate).toFixed(3)}
            </p>
          ) : (
            <p className="font-numeric text-sm text-parchment-dim">
              {tickError ?? "Loading…"}
            </p>
          )}
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-3 gap-5 p-6 max-w-6xl mx-auto">
        <section className="space-y-5 lg:col-span-1">
          <VolumeSelector
            metal={metal}
            onMetalChange={(m) => setMetal(m)}
            onVolumeChange={(grams) => {
              setVolumeGrams(grams);
              setLock(null);
            }}
          />
          <RateLockTimer
            lockedRatePerGram={lock ? lock.ratePerGram : null}
            expiresAt={lock ? lock.expiresAt : null}
            onExpire={handleExpire}
          />
          {!lock ? (
            <button
              onClick={handleLock}
              disabled={!tick || lockPending}
              className="w-full py-3 bg-bullion-gold text-graphite-950 text-sm font-medium hover:bg-bullion-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {lockPending
                ? "Locking…"
                : `Lock rate for ${volumeGrams.toLocaleString("en-IN")} g`}
            </button>
          ) : (
            <button
              disabled
              className="w-full py-3 border border-hairline text-parchment-dim text-sm cursor-not-allowed"
            >
              Rate locked — confirm payment below
            </button>
          )}
          {lockError && <p className="text-xs text-alert">{lockError}</p>}
        </section>

        <section className="lg:col-span-1">
          <BreakdownDrawer
            baseRatePerGram={customsAdjustedPerGramInr}
            refinerPremium={refinerPremiumPerGram}
            platformMarkup={platformMarkupInr}
            volumeGrams={volumeGrams}
            gstAmount={gstAmount}
            tcsAmount={0}
            courierCharge={courierCharge}
            netPayable={netPayable}
          />
        </section>

        <section className="lg:col-span-1">
          <VanPaymentPanel
            vanNumber="VAN2609841773"
            ifsc="ICIC0001234"
            bankName="ICICI Bank · e-Collection"
            amountDue={netPayable}
            settlementStatus={lock ? "AWAITING_TRANSFER" : "AWAITING_LOCK"}
          />
        </section>
      </main>
    </div>
  );
}
