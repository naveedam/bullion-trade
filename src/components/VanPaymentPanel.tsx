"use client";

import { useState } from "react";

interface VanPaymentPanelProps {
  vanNumber: string;
  ifsc: string;
  bankName: string;
  amountDue: number;
  settlementStatus: "AWAITING_LOCK" | "AWAITING_TRANSFER" | "FUNDED";
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center justify-between border border-hairline px-3 py-2.5">
      <div>
        <p className="text-xs text-parchment-dim">{label}</p>
        <p className="font-numeric text-sm text-parchment">{value}</p>
      </div>
      <button
        onClick={copy}
        className="text-xs px-2.5 py-1 border border-hairline text-parchment-dim hover:border-bullion-gold hover:text-bullion-gold transition-colors"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const STATUS_COPY: Record<
  VanPaymentPanelProps["settlementStatus"],
  { label: string; tone: string }
> = {
  AWAITING_LOCK: {
    label: "Lock a rate to generate a payment reference",
    tone: "text-parchment-dim",
  },
  AWAITING_TRANSFER: {
    label: "Awaiting RTGS/NEFT transfer",
    tone: "text-bullion-gold",
  },
  FUNDED: { label: "Payment confirmed", tone: "text-verified" },
};

export function VanPaymentPanel({
  vanNumber,
  ifsc,
  bankName,
  amountDue,
  settlementStatus,
}: VanPaymentPanelProps) {
  const status = STATUS_COPY[settlementStatus];

  return (
    <div className="border border-hairline bg-graphite-900 p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-parchment-dim">Settlement account</p>
        <p className={`text-xs ${status.tone}`}>{status.label}</p>
      </div>

      <div className="space-y-2">
        <CopyField label="Virtual account number" value={vanNumber} />
        <CopyField label="IFSC" value={ifsc} />
        <CopyField label="Bank" value={bankName} />
      </div>

      <div className="mt-4 flex justify-between items-baseline border-t border-hairline pt-4">
        <span className="text-sm text-parchment-dim">Amount to transfer</span>
        <span className="font-numeric text-lg text-parchment">
          ₹
          {amountDue.toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </span>
      </div>

      <p className="mt-3 text-xs text-parchment-dim">
        Transfer the exact amount via RTGS or NEFT from an account registered
        to your entity. Partial or split transfers cannot be reconciled
        automatically.
      </p>
    </div>
  );
}
