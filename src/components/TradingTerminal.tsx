"use client";

import { useEffect, useRef, useState } from "react";
import { RateLockTimer } from "./RateLockTimer";
import { VolumeSelector } from "./VolumeSelector";
import { BreakdownDrawer } from "./BreakdownDrawer";
import { VanPaymentPanel } from "./VanPaymentPanel";
import { LoginPanel, type LoggedInUser } from "./auth/LoginPanel";
import { OrderConfirmPanel } from "./OrderConfirmPanel";

interface TickSnapshot {
  metal: "GOLD" | "SILVER";
  quoteId: string;
  priceSource: "IBJA_ANCHORED" | "LBMA_FX";
  baseSpotPerGramInr: string;
  customsAdjustedPerGramInr: string;
  refinerPremiumInr: string;
  platformMarkupInr: string;
  askPricePerGramInr: string;
  baseSpotUsdPerOz: string;
  usdInrRate: string;
  ibjaRatePerGramInr?: string;
  ibjaPublishedAt?: string;
  driftRatio?: string;
  generatedAt: string;
  stale: boolean;
}

interface RateLockState {
  ratePerGram: number;
  expiresAt: Date;
  quoteId: string;
  lockToken: string;
}

interface ConfirmedOrder {
  orderId: string;
  netPayableInr: string;
  vanNumber: string;
  ifsc: string;
  partnerBank: string;
}

export function TradingTerminal() {
  const [authUser, setAuthUser] = useState<LoggedInUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [metal, setMetal] = useState<"GOLD" | "SILVER">("GOLD");
  const [volumeGrams, setVolumeGrams] = useState(1000);
  const [tick, setTick] = useState<TickSnapshot | null>(null);
  const [tickError, setTickError] = useState<string | null>(null);
  const [lock, setLock] = useState<RateLockState | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [lockPending, setLockPending] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<ConfirmedOrder | null>(null);
  const lockRef = useRef<RateLockState | null>(null);
  lockRef.current = lock;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/me");
        const body = await res.json();
        setAuthUser(body.user ?? null);
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

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

  useEffect(() => {
    setTick(null);
    setLock(null);
    setConfirmedOrder(null);
  }, [metal]);

  async function handleLock() {
    if (!tick || !authUser) return;
    setLockPending(true);
    setLockError(null);
    try {
      const res = await fetch("/api/rate-lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
        lockToken: body.lockToken,
      });
    } catch (err) {
      setLockError(err instanceof Error ? err.message : "Failed to lock rate — try again");
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
  const netPayable = confirmedOrder
    ? Number(confirmedOrder.netPayableInr)
    : grossAmount + gstAmount + courierCharge;

  return (
    <div className="min-h-screen bg-graphite-950 text-parchment">
      <header className="border-b border-hairline px-6 py-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-medium">Bullion Trading Terminal</h1>
          <p className="text-xs text-parchment-dim">
            Wholesale settlement · {metal === "GOLD" ? "Gold" : "Silver"} · 999.9 fine
          </p>
        </div>
        <div className="flex items-center gap-4">
          {authUser && <span className="text-xs text-parchment-dim">{authUser.phone}</span>}
          <div className="text-right">
            <p className="text-xs text-parchment-dim">
              {displayTick?.priceSource === "IBJA_ANCHORED"
                ? `IBJA anchored${displayTick.ibjaPublishedAt ? ` · ${displayTick.ibjaPublishedAt}` : ""}`
                : "Live spot"}
              {displayTick?.stale ? " (last known)" : ""}
            </p>
            {displayTick ? (
              displayTick.priceSource === "IBJA_ANCHORED" ? (
                <p className="font-numeric text-sm text-bullion-silver">
                  ₹{Number(displayTick.ibjaRatePerGramInr).toLocaleString("en-IN")}/g base
                  {displayTick.driftRatio && (
                    <> · {(Number(displayTick.driftRatio) * 100 - 100).toFixed(2)}% drift</>
                  )}
                </p>
              ) : (
                <p className="font-numeric text-sm text-bullion-silver">
                  ${Number(displayTick.baseSpotUsdPerOz).toFixed(2)} / oz · ₹
                  {Number(displayTick.usdInrRate).toFixed(3)}
                </p>
              )
            ) : (
              <p className="font-numeric text-sm text-parchment-dim">{tickError ?? "Loading…"}</p>
            )}
          </div>
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
              setConfirmedOrder(null);
            }}
          />
          <RateLockTimer
            lockedRatePerGram={lock ? lock.ratePerGram : null}
            expiresAt={lock ? lock.expiresAt : null}
            onExpire={handleExpire}
          />

          {!authChecked ? null : !authUser ? (
            <LoginPanel onLoggedIn={setAuthUser} />
          ) : !lock ? (
            <>
              <button
                onClick={handleLock}
                disabled={!tick || lockPending}
                className="w-full py-3 bg-bullion-gold text-graphite-950 text-sm font-medium hover:bg-bullion-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {lockPending ? "Locking…" : `Lock rate for ${volumeGrams.toLocaleString("en-IN")} g`}
              </button>
              {lockError && <p className="text-xs text-alert">{lockError}</p>}
            </>
          ) : confirmedOrder ? (
            <button
              disabled
              className="w-full py-3 border border-hairline text-verified text-sm cursor-not-allowed"
            >
              Order confirmed — {confirmedOrder.orderId.slice(0, 8)}
            </button>
          ) : (
            <button
              disabled
              className="w-full py-3 border border-hairline text-parchment-dim text-sm cursor-not-allowed"
            >
              Rate locked — confirm order to the right
            </button>
          )}
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
          {lock && !confirmedOrder ? (
            <OrderConfirmPanel
              quoteId={lock.quoteId}
              lockToken={lock.lockToken}
              metal={metal}
              volumeGrams={volumeGrams}
              onConfirmed={setConfirmedOrder}
            />
          ) : (
            <VanPaymentPanel
              vanNumber={confirmedOrder?.vanNumber ?? "—"}
              ifsc={confirmedOrder?.ifsc ?? "—"}
              bankName={confirmedOrder?.partnerBank ?? "—"}
              amountDue={netPayable}
              settlementStatus={confirmedOrder ? "AWAITING_TRANSFER" : "AWAITING_LOCK"}
            />
          )}
        </section>
      </main>
    </div>
  );
}
