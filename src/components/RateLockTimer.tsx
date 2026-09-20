"use client";

import { useEffect, useState } from "react";

interface RateLockTimerProps {
  /** Rate per gram in INR, already locked. Null when no lock is held. */
  lockedRatePerGram: number | null;
  expiresAt: Date | null;
  onExpire: () => void;
}

const LOCK_WINDOW_MS = 30_000;

export function RateLockTimer({
  lockedRatePerGram,
  expiresAt,
  onExpire,
}: RateLockTimerProps) {
  const [remainingMs, setRemainingMs] = useState<number>(
    expiresAt ? expiresAt.getTime() - Date.now() : 0
  );

  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => {
      const remaining = expiresAt.getTime() - Date.now();
      setRemainingMs(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(interval);
        onExpire();
      }
    }, 100);
    return () => clearInterval(interval);
  }, [expiresAt, onExpire]);

  if (!lockedRatePerGram || !expiresAt) {
    return (
      <div className="border border-hairline bg-graphite-900 px-5 py-4">
        <p className="text-sm text-parchment-dim">
          No rate locked. Select a volume to quote a price.
        </p>
      </div>
    );
  }

  const fraction = Math.max(0, Math.min(1, remainingMs / LOCK_WINDOW_MS));
  const seconds = (remainingMs / 1000).toFixed(1);
  const isUrgent = remainingMs < 8000;

  // Circumference-based ring progress, drawn as SVG rather than a canned
  // "spinner" component — the ring depletes clockwise from a fixed 12
  // o'clock start, echoing a lease timer rather than a loading indicator.
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  return (
    <div className="border border-hairline bg-graphite-900 px-5 py-4">
      <div className="flex items-center gap-4">
        <svg width="56" height="56" viewBox="0 0 56 56" className="shrink-0">
          <circle
            cx="28"
            cy="28"
            r={radius}
            fill="none"
            stroke="var(--hairline)"
            strokeWidth="3"
          />
          <circle
            cx="28"
            cy="28"
            r={radius}
            fill="none"
            stroke={isUrgent ? "var(--alert-red)" : "var(--bullion-gold)"}
            strokeWidth="3"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform="rotate(-90 28 28)"
            style={{ transition: "stroke-dashoffset 100ms linear" }}
          />
          <text
            x="28"
            y="32"
            textAnchor="middle"
            className="font-numeric"
            fontSize="13"
            fill={isUrgent ? "var(--alert-red)" : "var(--parchment)"}
          >
            {seconds}
          </text>
        </svg>
        <div>
          <p className="text-xs text-parchment-dim">Locked rate / gram</p>
          <p className="font-numeric text-2xl text-bullion-gold">
            ₹{lockedRatePerGram.toFixed(2)}
          </p>
        </div>
      </div>
      {isUrgent && (
        <p className="mt-3 text-xs text-alert">
          Lease expiring — confirm the order now or the quote will refresh.
        </p>
      )}
    </div>
  );
}
