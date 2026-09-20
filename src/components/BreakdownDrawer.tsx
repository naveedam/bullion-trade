interface LineItem {
  label: string;
  amount: number;
  isDeduction?: boolean;
}

interface BreakdownDrawerProps {
  baseRatePerGram: number;
  refinerPremium: number;
  platformMarkup: number;
  volumeGrams: number;
  gstAmount: number;
  tcsAmount: number;
  courierCharge: number;
  netPayable: number;
}

function formatInr(amount: number): string {
  return amount.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function BreakdownDrawer({
  baseRatePerGram,
  refinerPremium,
  platformMarkup,
  volumeGrams,
  gstAmount,
  tcsAmount,
  courierCharge,
  netPayable,
}: BreakdownDrawerProps) {
  const grossAmount =
    (baseRatePerGram + refinerPremium + platformMarkup) * volumeGrams;

  const lines: LineItem[] = [
    { label: `Base rate × ${volumeGrams.toLocaleString("en-IN")} g`, amount: baseRatePerGram * volumeGrams },
    { label: "Refiner premium", amount: refinerPremium * volumeGrams },
    { label: "Platform markup", amount: platformMarkup * volumeGrams },
  ];

  return (
    <div className="border border-hairline bg-graphite-900 p-5">
      <p className="text-xs text-parchment-dim mb-4">Order breakdown</p>

      <dl className="space-y-2.5">
        {lines.map((line) => (
          <div key={line.label} className="flex justify-between text-sm">
            <dt className="text-parchment-dim">{line.label}</dt>
            <dd className="font-numeric text-parchment">
              ₹{formatInr(line.amount)}
            </dd>
          </div>
        ))}

        <div className="h-px bg-hairline my-3" />

        <div className="flex justify-between text-sm">
          <dt className="text-parchment-dim">Gross amount</dt>
          <dd className="font-numeric text-parchment">
            ₹{formatInr(grossAmount)}
          </dd>
        </div>
        <div className="flex justify-between text-sm">
          <dt className="text-parchment-dim">GST (3%)</dt>
          <dd className="font-numeric text-parchment">₹{formatInr(gstAmount)}</dd>
        </div>
        {tcsAmount > 0 && (
          <div className="flex justify-between text-sm">
            <dt className="text-parchment-dim">TCS (206C(1H))</dt>
            <dd className="font-numeric text-parchment">
              ₹{formatInr(tcsAmount)}
            </dd>
          </div>
        )}
        <div className="flex justify-between text-sm">
          <dt className="text-parchment-dim">Armored courier</dt>
          <dd className="font-numeric text-parchment">
            ₹{formatInr(courierCharge)}
          </dd>
        </div>

        <div className="h-px bg-hairline my-3" />

        <div className="flex justify-between items-baseline">
          <dt className="text-sm text-parchment">Net payable</dt>
          <dd className="font-numeric text-xl text-bullion-gold">
            ₹{formatInr(netPayable)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
