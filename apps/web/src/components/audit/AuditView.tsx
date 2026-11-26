"use client";

// The hash-chained audit log: filters, every entry's data, and "Verify chain",
// which recomputes every hash on the server and names the first bad row.
import { useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { type AuditEntry, type AuditList, type ChainResult, shortHash, summarize } from "@/lib/audit";

export function AuditView() {
  const params = useSearchParams();
  const [type, setType] = useState("");
  const [actor, setActor] = useState("");
  const [q, setQ] = useState("");
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [verify, setVerify] = useState<ChainResult | "running" | null>(null);
  const qs = new URLSearchParams({ limit: "100", ...(type && { type }), ...(actor && { actor }), ...(q && { q }) }).toString();
  const { data, error } = useSWR<AuditList>(`/backend/audit?${qs}`, fetcher, { refreshInterval: 5000 });

  const runVerify = async () => {
    setVerify("running");
    const [res] = await Promise.all([fetch("/backend/audit/verify").then((r) => r.json()), new Promise((r) => setTimeout(r, 600))]);
    setVerify(res as ChainResult);
  };
  useEffect(() => {
    if (params.get("verify") === "1") void runVerify();
  }, [params]);
  useEffect(() => setOlder([]), [qs]);

  const loadOlder = async () => {
    const last = (older.at(-1) ?? data?.entries.at(-1))?.id;
    if (!last) return;
    const more: AuditList = await fetcher(`/backend/audit?${qs}&before=${last}`);
    setOlder((o) => [...o, ...more.entries]);
  };

  if (error) return <p role="alert" className="font-bold text-down">Could not reach the API.</p>;
  const entries = [...(data?.entries ?? []), ...older];
  const bad = verify && verify !== "running" && !verify.ok ? verify.badId : null;

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <button type="button" onClick={runVerify} disabled={verify === "running"} className="rounded-lg bg-accent px-5 py-2.5 text-lg font-black text-white disabled:opacity-60">
          {verify === "running" ? "Checking every hash…" : "Verify chain"}
        </button>
        <div role="status" aria-live="polite" className="min-w-60 flex-1">
          {verify && verify !== "running" && verify.ok && (
            <p className="pop-in text-lg font-black text-up">✓ Chain intact: all {verify.checked.toLocaleString()} entries check out ({verify.ms} ms).</p>
          )}
          {verify && verify !== "running" && !verify.ok && (
            <p className="pop-in text-lg font-black text-down">✕ Chain broken at entry #{verify.badId}. {verify.problem} The {verify.checked} entries before it are intact.</p>
          )}
          {!verify && <p className="font-semibold text-muted">Each entry's hash includes the one before it, so editing or deleting any entry breaks every link after it.</p>}
        </div>
      </section>

      <section className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-bold">Event
          <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 block rounded-lg border border-line bg-panel px-2 py-1.5 font-semibold">
            <option value="">all</option>
            {data?.types.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold">Who
          <select value={actor} onChange={(e) => setActor(e.target.value)} className="mt-1 block rounded-lg border border-line bg-panel px-2 py-1.5 font-semibold">
            <option value="">all</option>
            {data?.actors.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold">Contains
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="BTC, PIN, order…" className="mt-1 block rounded-lg border border-line bg-panel px-2 py-1.5 font-semibold" />
        </label>
      </section>

      <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <tr>{["#", "When", "Event", "Who", "What happened", "Hash"].map((h) => <th key={h} className="px-3 py-2 font-black">{h}</th>)}</tr>
          </thead>
          <tbody>
            {!data && <tr><td colSpan={6} className="h-40 animate-pulse" /></tr>}
            {entries.map((e, i) => (
              <Fragment key={e.id}>
                <tr
                  onClick={() => setOpen(open === e.id ? null : e.id)}
                  className={`cursor-pointer border-b border-line last:border-0 ${e.id === bad ? "bg-down/15" : bad !== null && e.id > bad ? "bg-down/5" : ""} ${verify && verify !== "running" && verify.ok ? "verify-row" : ""}`}
                  style={verify && verify !== "running" && verify.ok ? { animationDelay: `${Math.min(i, 40) * 25}ms` } : undefined}
                >
                  <td className="num px-3 py-2 font-bold">{e.id}</td>
                  <td className="num px-3 py-2 whitespace-nowrap">{new Date(e.createdAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                  <td className="px-3 py-2 font-bold">{e.eventType}</td>
                  <td className="px-3 py-2">{e.actor}</td>
                  <td className="px-3 py-2">{e.id === bad && <span className="mr-1 font-black text-down">EDITED:</span>}{summarize(e)}</td>
                  <td className="num px-3 py-2 text-muted">{shortHash(e.hash)}</td>
                </tr>
                {open === e.id && (
                  <tr className="border-b border-line bg-ink">
                    <td colSpan={6} className="px-3 py-3">
                      <pre className="num max-h-72 overflow-auto text-xs whitespace-pre-wrap">{JSON.stringify(e.payload, null, 2)}</pre>
                      <p className="num mt-2 text-xs break-all text-muted">hash {e.hash}<br />previous {e.prevHash}</p>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {data && entries.length === 0 && <tr><td colSpan={6} className="px-3 py-5 font-semibold text-muted">Nothing matches these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && data.entries.length === 100 && (
        <button type="button" onClick={loadOlder} className="rounded-lg border border-line bg-panel px-4 py-2 font-bold">Load older entries</button>
      )}
    </div>
  );
}
