"use client";

import { useState } from "react";

const TIERS = [
  { label: "100 g", grams: 100 },
  { label: "1 kg", grams: 1000 },
  { label: "5 kg", grams: 5000 },
];

interface VolumeSelectorProps {
  metal: "GOLD" | "SILVER";
  onMetalChange: (metal: "GOLD" | "SILVER") => void;
  onVolumeChange: (grams: number) => void;
}

export function VolumeSelector({
  metal,
  onMetalChange,
  onVolumeChange,
}: VolumeSelectorProps) {
  const [selectedTier, setSelectedTier] = useState<number | "custom">(1000);
  const [customValue, setCustomValue] = useState("");

  function selectTier(grams: number) {
    setSelectedTier(grams);
    onVolumeChange(grams);
  }

  function selectCustom(value: string) {
    setCustomValue(value);
    setSelectedTier("custom");
    const parsed = parseFloat(value);
    if (!Number.isNaN(parsed) && parsed > 0) onVolumeChange(parsed);
  }

  return (
    <div className="border border-hairline bg-graphite-900 p-5">
      <div className="flex gap-2 mb-5">
        {(["GOLD", "SILVER"] as const).map((m) => (
          <button
            key={m}
            onClick={() => onMetalChange(m)}
            className={`flex-1 py-2 text-sm border transition-colors ${
              metal === m
                ? "border-bullion-gold text-bullion-gold bg-graphite-800"
                : "border-hairline text-parchment-dim hover:text-parchment"
            }`}
          >
            {m === "GOLD" ? "Gold" : "Silver"}
          </button>
        ))}
      </div>

      <p className="text-xs text-parchment-dim mb-2">Volume</p>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {TIERS.map((tier) => (
          <button
            key={tier.grams}
            onClick={() => selectTier(tier.grams)}
            className={`font-numeric py-3 text-sm border transition-colors ${
              selectedTier === tier.grams
                ? "border-bullion-gold text-bullion-gold bg-graphite-800"
                : "border-hairline text-parchment hover:border-parchment-dim"
            }`}
          >
            {tier.label}
          </button>
        ))}
      </div>

      <div
        className={`flex items-center border px-3 ${
          selectedTier === "custom" ? "border-bullion-gold" : "border-hairline"
        }`}
      >
        <span className="text-sm text-parchment-dim mr-2">Custom</span>
        <input
          type="number"
          min="0"
          value={customValue}
          onChange={(e) => selectCustom(e.target.value)}
          placeholder="Grams"
          className="font-numeric flex-1 bg-transparent py-2 text-sm text-parchment placeholder:text-parchment-dim/60 outline-none"
        />
        <span className="text-xs text-parchment-dim">g</span>
      </div>
    </div>
  );
}
