"use client";

// On a phone (ALLOW_LAN), the dashboard is locked until the PIN is entered.
// On this computer it's never shown.
import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { SessionInfo } from "@/lib/session";

export function LockGate({ children }: { children: React.ReactNode }) {
  const { data, mutate } = useSWR<SessionInfo>("/backend/session", fetcher, { refreshInterval: 60_000 });
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!data || data.unlocked) return <>{children}</>;

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const res = await fetch("/backend/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setErr(body.error ?? "Could not unlock.");
    setPin("");
    void mutate();
  };

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <form onSubmit={unlock} className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
        <h1 className="text-2xl font-black">Enter your PIN</h1>
        <p className="mt-2 font-medium text-muted">This device isn&apos;t the computer Saarthi runs on, so the dashboard is locked. The PIN unlocks it for 12 hours.</p>
        <label className="mt-4 block text-sm font-bold">
          PIN
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
            className="num mt-1 block w-full rounded-lg border border-line bg-ink px-3 py-3 text-2xl tracking-[0.4em]"
          />
        </label>
        <button type="submit" disabled={pin.length < 4} className="mt-4 w-full rounded-lg bg-accent py-3 text-lg font-black text-white disabled:opacity-50">
          Unlock
        </button>
        {err && <p role="alert" className="mt-3 font-bold text-down">{err}</p>}
      </form>
    </main>
  );
}
