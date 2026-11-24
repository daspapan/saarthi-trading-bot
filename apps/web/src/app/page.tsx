import { HealthStrip } from "@/components/HealthStrip";
import { PriceTiles } from "@/components/PriceTiles";
import { SignalGate } from "@/components/SignalGate";

// Phase 2 landing page: live prices and system health. It becomes the Cockpit in phase 7.
export default function Home() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Live market</h1>
        <p className="mt-1 text-lg font-medium text-muted">The AI is the analyst, never the trader.</p>
      </header>
      <SignalGate />
      <PriceTiles />
      <HealthStrip />
    </main>
  );
}
