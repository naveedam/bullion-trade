import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Bullion Trading Platform",
  description: "B2B wholesale bullion trading and settlement",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
