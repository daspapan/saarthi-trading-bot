"use client";

// Backtest Lab: set up a run, watch it finish, read the honest numbers, compare runs.
import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { Run, RunSummary } from "@/lib/backtest";
import { ComparePanel, RunsTable } from "./CompareRuns";
import { RunForm } from "./RunForm";
import { RunResult } from "./RunResult";

export function BacktestLab() {
  const data = useSWR("/backend/backtests/data", fetcher<{ range: { from: number; to: number } | null; hint: string | null }>);
  const settings = useSWR("/backend/settings", fetcher<Parameters<typeof RunForm>[0]["settings"]>);
  const runs = useSWR("/backend/backtests", fetcher<{ runs: RunSummary[] }>, { refreshInterval: (d) => (d?.runs.some((r) => r.status === "running") ? 1000 : 0) });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<number[]>([]);

  // Open the newest run by default.
  useEffect(() => {
    if (selectedId === null && runs.data?.runs[0]) setSelectedId(runs.data.runs[0].id);
  }, [runs.data, selectedId]);

  const selected = useSWR<Run>(selectedId ? `/backend/backtests/${selectedId}` : null, fetcher, {
    refreshInterval: (d) => (d?.status === "running" ? 1000 : 0),
  });

  // When the open run finishes, refresh the list so its numbers appear.
  useEffect(() => {
    if (selected.data && selected.data.status !== "running") void runs.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.data?.status]);

  const busy = runs.data?.runs.some((r) => r.status === "running") ?? false;
  const toggleCompare = (id: number) =>
    setCompareIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < 3 ? [...ids, id] : ids));

  if (data.error || settings.error) {
    return <p role="alert" className="rounded-2xl border border-down/50 bg-down/5 p-4 font-bold text-down">The API is not reachable. Is npm run dev running?</p>;
  }
  if (!data.data || !settings.data) {
    return <div className="h-96 animate-pulse rounded-2xl border border-line bg-panel" aria-label="Loading" />;
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <RunForm
          data={data.data}
          settings={settings.data}
          busy={busy}
          onStarted={(id) => {
            setSelectedId(id);
            void runs.mutate();
          }}
        />
        <div>
          {selected.data ? (
            <RunResult run={selected.data} />
          ) : (
            <div className="flex h-full min-h-60 items-center justify-center rounded-2xl border border-dashed border-line bg-panel p-6 text-center">
              <div>
                <p className="text-lg font-black">No run selected</p>
                <p className="text-sm font-medium text-muted">Results appear here: equity vs buy-and-hold, drawdown, a walk-forward check and every trade with its fees.</p>
              </div>
            </div>
          )}
        </div>
      </div>
      <ComparePanel ids={compareIds} />
      <RunsTable runs={runs.data?.runs ?? []} selectedId={selectedId} compareIds={compareIds} onSelect={setSelectedId} onToggleCompare={toggleCompare} />
    </div>
  );
}
