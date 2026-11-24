"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { type RiskView, gaugesFor } from "@/lib/risk";
import { AccountCards } from "./AccountCards";
import { KillSwitch } from "./KillSwitch";
import { RiskGauges } from "./RiskGauges";

export function Cockpit() {
  const { data, error, mutate } = useSWR<RiskView>("/backend/risk", fetcher, { refreshInterval: 2000 });
  if (error) return <p role="alert" className="rounded-2xl border border-down/50 bg-down/5 p-4 font-bold text-down">The API is not reachable, so risk figures can&apos;t be shown. The kill switch still works from a terminal: <code className="num">npm run kill -- &lt;PIN&gt;</code></p>;
  if (!data) return <div className="h-64 animate-pulse rounded-2xl border border-line bg-panel" aria-label="Loading risk" />;
  return (
    <div className="space-y-5">
      <KillSwitch v={data} onChange={() => void mutate()} />
      <AccountCards v={data} />
      <RiskGauges gauges={gaugesFor(data)} />
    </div>
  );
}
