"use client";

import { useState } from "react";

export interface LoggedInUser {
  userId: string;
  entityId: string;
  phone: string;
  kycStatus: string;
  legalName: string;
}

interface LoginPanelProps {
  onLoggedIn: (user: LoggedInUser) => void;
}

export function LoginPanel({ onLoggedIn }: LoginPanelProps) {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("+91");
  const [code, setCode] = useState("");
  const [devEchoCode, setDevEchoCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestOtp() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setDevEchoCode(body.devEchoCode ?? null);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setPending(false);
    }
  }

  async function verifyOtp() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      onLoggedIn(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border border-hairline bg-graphite-900 p-5">
      <p className="text-xs text-parchment-dim mb-4">Log in to lock a rate</p>

      {step === "phone" ? (
        <>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+9198XXXXXXXX"
            className="font-numeric w-full bg-transparent border border-hairline px-3 py-2 text-sm text-parchment placeholder:text-parchment-dim/60 outline-none focus:border-bullion-gold mb-3"
          />
          <button
            onClick={requestOtp}
            disabled={pending}
            className="w-full py-2.5 bg-bullion-gold text-graphite-950 text-sm font-medium hover:bg-bullion-gold/90 transition-colors disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send code"}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-parchment-dim mb-2">Code sent to {phone}</p>
          {devEchoCode && (
            <p className="text-xs text-bullion-gold mb-2">Dev mode — code: {devEchoCode}</p>
          )}
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="6-digit code"
            className="font-numeric w-full bg-transparent border border-hairline px-3 py-2 text-sm text-parchment placeholder:text-parchment-dim/60 outline-none focus:border-bullion-gold mb-3"
          />
          <button
            onClick={verifyOtp}
            disabled={pending || code.length !== 6}
            className="w-full py-2.5 bg-bullion-gold text-graphite-950 text-sm font-medium hover:bg-bullion-gold/90 transition-colors disabled:opacity-50"
          >
            {pending ? "Verifying…" : "Verify & continue"}
          </button>
          <button
            onClick={() => setStep("phone")}
            className="w-full mt-2 py-1 text-xs text-parchment-dim hover:text-parchment"
          >
            Change number
          </button>
        </>
      )}

      {error && <p className="mt-3 text-xs text-alert">{error}</p>}
    </div>
  );
}
