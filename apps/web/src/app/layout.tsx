import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Saarthi",
  description: "Local AI trading demo. The AI is the analyst, never the trader. Testnet only.",
};

// Rule 9: this banner is part of the root layout, so it is on every page.
const DISCLAIMER =
  "Testnet with virtual funds. Not financial advice. Testnet results do not predict real results.";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div
          role="note"
          data-testid="disclaimer-banner"
          className="sticky top-0 z-50 border-b border-warn/40 bg-[#fff4e0] px-4 py-2 text-center text-sm font-bold text-[#7c2d12]"
        >
          {DISCLAIMER}
        </div>
        <Nav />
        {children}
      </body>
    </html>
  );
}
