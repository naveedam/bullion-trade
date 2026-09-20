"use client";

import { useEffect, useState } from "react";
import { RateLockTimer } from "./RateLockTimer";
import { VolumeSelector } from "./VolumeSelector";
import { BreakdownDrawer } from "./BreakdownDrawer";
import { VanPaymentPanel } from "./VanPaymentPanel";

// Illustrative constants — in production these come from the live feed
// (LBMA/COMEX spot, interbank USD/INR) via the WebSocket gateway, and from
// the entity's negotiated refiner premium / platform markup tier.
const CUSTOMS_DUTY_FACTOR = 0.06;
const REFINER_PREMIUM_PER_GRAM = 45;
const PLATFORM_MARKUP_BPS = 25;
const GRAMS_PER_TROY_OUNCE = 31.1035;

interface Tick {
  baseSpotUsdPerOz: number;
  usdInrRate: number;
  askPricePerGram: number;
  quoteId: string;
  asOf: Date;
}

function generateTick(previous?: Tick): Tick {
  const baseSpotUsdPerOz =
    (previous?.baseSpotUsdPerOz ?? 2650) + (Math.random() - 0.5) * 1.2;
  const usdInrRate = (previous?.usdInrRate ?? 83.4) + (Math.random() - 0.5) * 0.01;

  const baseSpotPerGramUsd = baseSpotUsdPerOz / GRAMS_PER_TROY_OUNCE;
  const customsAdjustedPerGramInr =
    baseSpotPerGramUsd * (1 + CUSTOMS_DUTY_FACTOR) * usdInrRate;
  const platformMarkupInr =
    (customsAdjustedPerGramInr * PLATFORM_MARKUP_BPS) / 10000;
  const askPricePerGram =
    customsAdjustedPerGramInr + REFINER_PREMIUM_PER_GRAM + platformMarkupInr;

  return {
    baseSpotUsdPerOz,
    usdInrRate,
    askPricePerGram,
    quoteId: `Q-${Date.now()}`,
    asOf: new Date(),
  };
}

export function TradingTerminal() {
  const [metal, setMetal] = useState<"GOLD" | "SILVER">("GOLD");
  const [volumeGrams, setVolumeGrams] = useState(1000);
  const [tick, setTick] = useState<Tick>(() => generateTick());
  const [lock, setLock] = useState<{
    ratePerGram: number;
    expiresAt: Date;
  } | null>(null);

  // Simulate the live tick board — replace with the WebSocket gateway feed.
  useEffect(() => {
    if (lock) return; // freeze ticking while a rate is locked
    const interval = setInterval(() => setTick((t) => generateTick(t)), 1500);
    return () => clearInterval(interval);
  }, [lock]);

  function handleLock() {
    setLock({
      ratePerGram: tick.askPricePerGram,
      expiresAt: new Date(Date.now() + 30_000),
    });
  }

  function handleExpire() {
    setLock(null);
    setTick((t) => generateTick(t));
  }

  const displayRate = lock ? lock.ratePerGram : tick.askPricePerGram;
  const customsAdjustedPerGramInr =
    (tick.baseSpotUsdPerOz / GRAMS_PER_TROY_OUNCE) *
    (1 + CUSTOMS_DUTY_FACTOR) *
    tick.usdInrRate;
  const platformMarkupInr =
    (customsAdjustedPerGramInr * PLATFORM_MARKUP_BPS) / 10000;

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
          <p className="text-xs text-parchment-dim">Live spot</p>
          <p className="font-numeric text-sm text-bullion-silver">
            ${tick.baseSpotUsdPerOz.toFixed(2)} / oz · ₹
            {tick.usdInrRate.toFixed(3)}
          </p>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-3 gap-5 p-6 max-w-6xl mx-auto">
        <section className="space-y-5 lg:col-span-1">
          <VolumeSelector
            metal={metal}
            onMetalChange={(m) => {
              setMetal(m);
              setLock(null);
            }}
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
              className="w-full py-3 bg-bullion-gold text-graphite-950 text-sm font-medium hover:bg-bullion-gold/90 transition-colors"
            >
              Lock rate for {volumeGrams.toLocaleString("en-IN")} g
            </button>
          ) : (
            <button
              disabled
              className="w-full py-3 border border-hairline text-parchment-dim text-sm cursor-not-allowed"
            >
              Rate locked — confirm payment below
            </button>
          )}
        </section>

        <section className="lg:col-span-1">
          <BreakdownDrawer
            baseRatePerGram={customsAdjustedPerGramInr}
            refinerPremium={REFINER_PREMIUM_PER_GRAM}
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
