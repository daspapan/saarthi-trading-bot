"use client";

// The five latest AI signals, one line each, linking to the AI Analyst page.
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { SignalCard } from "@/lib/analyst";

function outcome(s: SignalCard): { text: string; tone: string } {
  if (s.direction === "neutral") return { text: "no trade", tone: "text-muted" };
  if (!s.guardrails.passed) return { text: "rejected by guardrails", tone: "text-down" };
  if (s.validator && !s.validator.passed) return { text: `blocked: rule ${s.validator.rules.filter((r) => !r.passed).map((r) => r.rule).join(", ")}`, tone: "text-down" };
  if (s.queue) return { text: `queued (${s.queue.status})`, tone: "text-up" };
  return { text: "checked", tone: "text-muted" };
}

export function LatestSignals() {
  const { data } = useSWR<{ signals: SignalCard[] }>("/backend/signals?limit=5", fetcher, { refreshInterval: 4000 });
  const list = data?.signals ?? [];
  return (
    <section aria-labelledby="ls" className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 id="ls" className="text-lg font-black">Latest signals</h2>
        <Link href="/analyst" className="text-sm font-bold text-accent">All signals</Link>
      </div>
      {list.length === 0 ? (
        <p className="font-semibold text-muted">No signals yet. The analyst runs every 15 minutes, or press Analyse now on the AI Analyst page.</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((s) => {
            const o = outcome(s);
            return (
              <li key={s.id} className="slide-in flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="font-bold">
                  {s.pair} <span className="uppercase text-muted">{s.direction}</span>
                  {s.confidence && <span className="ml-1 text-sm text-muted">· {s.confidence}</span>}
                </span>
                <span className={`text-sm font-bold ${o.tone}`}>{o.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
