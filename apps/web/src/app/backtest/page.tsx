import { BacktestLab } from "@/components/backtest/BacktestLab";

export const metadata = { title: "Backtest Lab · Saarthi" };

export default function BacktestPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Backtest Lab</h1>
        <p className="mt-1 text-lg font-medium text-muted">
          Replay past candles through the same strategy, sizing and risk code the live system uses.
        </p>
      </header>
      <BacktestLab />
    </main>
  );
}
