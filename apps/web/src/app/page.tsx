import { EnableNotifications } from "@/components/AlertToaster";
import { HealthStrip } from "@/components/HealthStrip";
import { PriceTiles } from "@/components/PriceTiles";
import { SignalGate } from "@/components/SignalGate";
import { Cockpit } from "@/components/cockpit/Cockpit";
import { LatestSignals } from "@/components/cockpit/LatestSignals";

export default function CockpitPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Cockpit</h1>
          <p className="mt-1 text-lg font-medium text-muted">The AI is the analyst, never the trader. Code checks every limit.</p>
        </div>
        <EnableNotifications />
      </header>
      <Cockpit />
      <SignalGate />
      <PriceTiles />
      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <HealthStrip />
        <LatestSignals />
      </div>
    </main>
  );
}
