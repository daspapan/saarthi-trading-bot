"use client";

// AI Analyst page: the analyst's status, an "Analyse now" button, and a timeline
// of analysis runs. Every run shows each pair's signal and how the checks went.
import { useState } from "react";
import useSWR from "swr";
import { type Health, fetcher } from "@/lib/api";
import { type SignalCard, groupByRun, runSummary, sourceLabel, timeOf } from "@/lib/analyst";
import { processPill } from "@/lib/status";
import { StatusPill } from "../StatusPill";
import { SignalCardView } from "./SignalCardView";

export function AnalystView() {
  const signals = useSWR<{ signals: SignalCard[] }>("/backend/signals?limit=60", fetcher, { refreshInterval: 3000 });
  const health = useSWR<Health>("/backend/health", fetcher, { refreshInterval: 3000 });
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [asking, setAsking] = useState(false);

  const analyst = health.data?.processes.find((p) => p.name === "analyst");
  const trusted = health.data?.feeds?.trusted;

  async function analyseNow() {
    setAsking(true);
    setMessage(null);
    try {
      const res = await fetch("/backend/analyse", { method: "POST" });
      const body = await res.json();
      setMessage({ text: res.ok ? `${body.message} Results appear below in a few seconds.` : body.error, ok: res.ok && body.analystRunning });
    } catch {
      setMessage({ text: "Could not reach the API.", ok: false });
    } finally {
      setAsking(false);
    }
  }

  const runs = groupByRun(signals.data?.signals ?? []);

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-start gap-4 rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <ul className="min-w-60 flex-1">
          {analyst ? (
            <StatusPill name="Analyst process (no keys)" pill={processPill(analyst.status)} sub={analyst.detail ?? undefined} tooltip="Reads a read-only copy of the data, asks Ollama, and can only submit signals." />
          ) : (
            <li className="h-20 animate-pulse rounded-xl border border-line bg-ink" />
          )}
        </ul>
        <div className="flex flex-col items-start gap-2">
          <button
            onClick={analyseNow}
            disabled={asking}
            className="rounded-xl bg-accent px-5 py-3 text-base font-black text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
          >
            {asking ? "Asking…" : "Analyse now"}
          </button>
          {trusted === false && <p className="max-w-72 text-xs font-bold text-warn">Feeds are paused, so the analyst will record “skipped” without calling the model.</p>}
        </div>
        {message && (
          <p role="status" className={`w-full rounded-lg px-3 py-2 text-sm font-bold ${message.ok ? "bg-up/5 text-up" : "bg-warn/5 text-warn"}`}>
            {message.text}
          </p>
        )}
      </section>

      {signals.isLoading && <div className="h-64 animate-pulse rounded-2xl border border-line bg-panel" />}

      {!signals.isLoading && runs.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line bg-panel p-8 text-center">
          <p className="text-lg font-black">No analysis yet</p>
          <p className="text-sm font-medium text-muted">
            The analyst runs every 15 minutes. Press “Analyse now” to run it immediately (Ollama must be running with the model pulled).
          </p>
        </div>
      )}

      {runs.map((run) => {
        const { passed, rejected } = runSummary(run);
        return (
          <section key={run.runId} aria-label={`Analysis at ${timeOf(run.createdAt)}`} className="space-y-3">
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-1">
              <h2 className="num text-xl font-black">{timeOf(run.createdAt)}</h2>
              <span className="text-sm font-bold text-muted">{run.trigger === "manual" ? "Analyse now" : "Scheduled run"}</span>
              <span className={`text-sm font-bold ${run.source === "ollama" ? "text-accent" : "text-warn"}`}>{sourceLabel(run)}</span>
              <span className="ml-auto text-sm font-bold">
                <span className="text-up">{passed} passed</span>
                {rejected > 0 && <span className="text-down"> · {rejected} rejected</span>}
              </span>
              {run.snapshotHash && (
                <a
                  href={`/backend/snapshots/${run.snapshotHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="num w-full truncate text-xs font-semibold text-muted underline decoration-dotted"
                  title="Open the exact data the AI saw"
                >
                  snapshot {run.snapshotHash}
                </a>
              )}
            </header>
            <div className="grid gap-3 lg:grid-cols-2">
              {run.signals.map((s) => (
                <SignalCardView key={s.id} s={s} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
