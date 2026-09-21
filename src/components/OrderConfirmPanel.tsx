"use client";

import { useState } from "react";

interface OrderConfirmPanelProps {
  quoteId: string;
  lockToken: string;
  metal: "GOLD" | "SILVER";
  volumeGrams: number;
  onConfirmed: (result: {
    orderId: string;
    netPayableInr: string;
    vanNumber: string;
    ifsc: string;
    partnerBank: string;
  }) => void;
}

export function OrderConfirmPanel({
  quoteId,
  lockToken,
  metal,
  volumeGrams,
  onConfirmed,
}: OrderConfirmPanelProps) {
  const [deliveryMode, setDeliveryMode] = useState<"ARMORED_TRANSIT" | "VAULT_CUSTODY_HOLD">(
    "VAULT_CUSTODY_HOLD"
  );
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kycPending, setKycPending] = useState(false);

  async function confirm() {
    setPending(true);
    setError(null);
    setKycPending(false);
    try {
      const res = await fetch("/api/orders/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteId,
          lockToken,
          metal,
          volumeGrams: String(volumeGrams),
          deliveryMode,
          deliveryAddress: deliveryMode === "ARMORED_TRANSIT" ? address : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.code === "KYC_PENDING") {
          setKycPending(true);
          return;
        }
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onConfirmed(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm order");
    } finally {
      setPending(false);
    }
  }

  if (kycPending) {
    return (
      <div className="border border-hairline bg-graphite-900 p-5">
        <p className="text-sm text-bullion-gold mb-1">Verification pending</p>
        <p className="text-xs text-parchment-dim">
          Your account needs KYC verification before you can confirm an
          order. Contact the platform to complete this — your locked rate
          will remain valid for the remaining lease window.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-hairline bg-graphite-900 p-5">
      <p className="text-xs text-parchment-dim mb-3">Delivery</p>
      <div className="flex gap-2 mb-3">
        {[
          { value: "VAULT_CUSTODY_HOLD" as const, label: "Vault hold" },
          { value: "ARMORED_TRANSIT" as const, label: "Armored transit" },
        ].map((opt) => (
          <button
            key={opt.value}
            onClick={() => setDeliveryMode(opt.value)}
            className={`flex-1 py-2 text-sm border transition-colors ${
              deliveryMode === opt.value
                ? "border-bullion-gold text-bullion-gold bg-graphite-800"
                : "border-hairline text-parchment-dim hover:text-parchment"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {deliveryMode === "ARMORED_TRANSIT" && (
        <textarea
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Delivery address"
          rows={2}
          className="w-full bg-transparent border border-hairline px-3 py-2 text-sm text-parchment placeholder:text-parchment-dim/60 outline-none focus:border-bullion-gold mb-3 resize-none"
        />
      )}

      <button
        onClick={confirm}
        disabled={pending || (deliveryMode === "ARMORED_TRANSIT" && !address.trim())}
        className="w-full py-2.5 bg-bullion-gold text-graphite-950 text-sm font-medium hover:bg-bullion-gold/90 transition-colors disabled:opacity-50"
      >
        {pending ? "Confirming…" : "Confirm order"}
      </button>

      {error && <p className="mt-3 text-xs text-alert">{error}</p>}
    </div>
  );
}
