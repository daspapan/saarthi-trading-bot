// Equity and today's P&L (after fees), with what today's P&L is made of.

import type { RiskView } from "@/lib/risk";
import { signed } from "@/lib/risk";
import { TrendArrow } from "../TrendArrow";

const usd = (v: number | null) => (v === null ? "n/a" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function AccountCards({ v }: { v: RiskView }) {
  const a = v.assessment;
  const tone = !a || Math.abs(a.dailyPnl) < 0.005 ? "flat" : a.dailyPnl > 0 ? "up" : "down";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <h3 className="text-sm font-black uppercase tracking-wide text-muted">Equity</h3>
        <p className="num mt-1 text-4xl font-black">
          {usd(v.equity)} <span className="text-lg text-muted">USDT</span>
        </p>
        <p className="num mt-1 text-sm font-semibold text-muted">
          cash {usd(v.cash)} · high {usd(v.highWaterMark)}
          {v.equityAgeSec !== null && v.equityAgeSec > 60 && <span className="ml-2 font-bold text-warn">updated {v.equityAgeSec}s ago</span>}
        </p>
      </div>
      <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <h3 className="text-sm font-black uppercase tracking-wide text-muted">Today&apos;s P&amp;L, after fees</h3>
        <p className={`num mt-1 flex items-center gap-2 text-4xl font-black ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text"}`}>
          <TrendArrow tone={tone} size={26} />
          <span className="sr-only">{tone === "up" ? "Up" : tone === "down" ? "Down" : "Flat"}</span>
          {a ? signed(a.dailyPnl) : "n/a"} <span className="text-lg">USDT</span>
          {a && <span className="text-lg">({signed(a.dailyPnlPct)}%)</span>}
        </p>
        <p className="num mt-1 text-sm font-semibold text-muted">
          realised {signed(v.breakdown.realisedToday)} · open {signed(v.breakdown.unrealised)} · fees paid {v.breakdown.feesToday.toFixed(2)}
        </p>
      </div>
    </div>
  );
}
