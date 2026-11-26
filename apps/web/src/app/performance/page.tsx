import { PerformanceView } from "@/components/performance/PerformanceView";

export const metadata = { title: "Performance · Saarthi" };

export default function PerformancePage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Performance</h1>
        <p className="mt-1 text-lg font-medium text-muted">Everything after fees, next to what simply holding BTC would have done.</p>
      </header>
      <PerformanceView />
    </main>
  );
}
