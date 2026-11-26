"use client";

// Strategy and Risk: change settings only inside their approved ranges, review the
// diff, confirm with the PIN. Every change is audited and listed under History.
import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { type ChangeLine, type Setting, type SettingsFile, groupSettings, labelFor, pendingChanges, show, stepFor } from "@/lib/settings";

type FileName = "strategy.json" | "risk.json";
type History = { history: { id: number; file: string; key: string; old: unknown; new: unknown; createdAt: string }[] };

function Field({ k, s, value, onChange }: { k: string; s: Setting; value: unknown; onChange: (v: unknown) => void }) {
  const changed = JSON.stringify(value) !== JSON.stringify(s.value);
  const id = `set-${k}`;
  let input: React.ReactNode;
  if ("min" in s) {
    const v = typeof value === "number" ? value : s.value;
    input = (
      <div className="flex items-center gap-3">
        <input type="range" aria-label={`${labelFor(k)} slider`} min={s.min} max={s.max} step={stepFor(s)} value={v} onChange={(e) => onChange(Number(e.target.value))} className="w-40 accent-[var(--color-accent)]" />
        <input id={id} type="number" min={s.min} max={s.max} step={stepFor(s)} value={v} onChange={(e) => onChange(e.target.value === "" ? v : Number(e.target.value))} className="num w-24 rounded-lg border border-line bg-ink px-2 py-1.5 font-bold" />
        <span className="num text-xs font-semibold text-muted">{s.min} to {s.max}</span>
      </div>
    );
  } else if (typeof s.value === "boolean") {
    const on = value === true;
    input = (
      <button id={id} type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`rounded-full px-4 py-1.5 font-black ${on ? "bg-up text-white" : "bg-line text-text"}`}>
        {on ? "On" : "Off"}
      </button>
    );
  } else if (Array.isArray(s.value) && "allowed" in s) {
    const list = Array.isArray(value) ? (value as string[]) : s.value;
    input = (
      <div className="flex flex-wrap gap-2" id={id} role="group" aria-label={labelFor(k)}>
        {s.allowed.map((a) => (
          <label key={a} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 font-bold">
            <input type="checkbox" checked={list.includes(a)} onChange={(e) => onChange(e.target.checked ? [...list, a].sort((x, y) => s.allowed.indexOf(x) - s.allowed.indexOf(y)) : list.filter((x) => x !== a))} />
            {a}
          </label>
        ))}
      </div>
    );
  } else if ("allowed" in s) {
    input = (
      <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-line bg-ink px-2 py-1.5 font-bold">
        {s.allowed.map((a) => <option key={a}>{a}</option>)}
      </select>
    );
  }
  return (
    <div className={`grid gap-2 border-t border-line py-3 md:grid-cols-[1fr_auto] md:items-center ${changed ? "bg-accent/5" : ""}`}>
      <div>
        <label htmlFor={id} className="font-bold">
          {labelFor(k)} {changed && <span className="ml-1 rounded bg-accent px-1.5 py-0.5 text-xs font-black text-white">changed</span>}
        </label>
        <p className="text-sm text-muted">{s.help}</p>
      </div>
      {input}
    </div>
  );
}

export function SettingsView() {
  const settings = useSWR<{ strategy: SettingsFile; risk: SettingsFile }>("/backend/settings", fetcher);
  const history = useSWR<History>("/backend/settings/history", fetcher);
  const [file, setFile] = useState<FileName>("risk.json");
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [lines, setLines] = useState<ChangeLine[] | null>(null);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  if (settings.error) return <p role="alert" className="font-bold text-down">Could not reach the API.</p>;
  if (!settings.data) return <div className="h-96 animate-pulse rounded-2xl border border-line bg-panel" />;
  const current = file === "risk.json" ? settings.data.risk : settings.data.strategy;
  const changes = pendingChanges(current, draft);
  const count = Object.keys(changes).length;

  const switchFile = (f: FileName) => {
    setFile(f);
    setDraft({});
    setLines(null);
    setMsg(null);
  };
  const review = async () => {
    const res = await fetch("/backend/settings/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file, changes }) });
    setLines((await res.json()).lines);
  };
  const save = async () => {
    setBusy(true);
    const res = await fetch("/backend/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file, changes, pin }) });
    const body = await res.json();
    setBusy(false);
    setMsg({ text: body.message ?? body.error, ok: res.ok });
    setPin("");
    if (res.ok) {
      setDraft({});
      setLines(null);
      void settings.mutate();
      void history.mutate();
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <div role="tablist" aria-label="Settings file" className="mb-2 flex gap-2">
          {(["risk.json", "strategy.json"] as const).map((f) => (
            <button key={f} role="tab" aria-selected={file === f} type="button" onClick={() => switchFile(f)} className={`rounded-lg px-4 py-2 font-black ${file === f ? "bg-accent text-white" : "border border-line text-muted"}`}>
              {f === "risk.json" ? "Risk limits" : "Strategies"}
            </button>
          ))}
        </div>
        {groupSettings(current).map((g) => (
          <div key={g.group} className="mt-4">
            <h2 className="text-lg font-black">{g.group}</h2>
            {g.keys.map((k) => (
              <Field key={k} k={k} s={current[k]!} value={k in draft ? draft[k] : current[k]!.value} onChange={(v) => { setDraft((d) => ({ ...d, [k]: v })); setLines(null); setMsg(null); }} />
            ))}
          </div>
        ))}
      </section>

      <aside className="space-y-4 lg:sticky lg:top-16 lg:self-start">
        <section aria-labelledby="pend" className="rounded-2xl border-2 border-accent/40 bg-panel p-4 shadow-sm">
          <h2 id="pend" className="text-lg font-black">{count === 0 ? "No changes yet" : `${count} change${count === 1 ? "" : "s"}`}</h2>
          {count === 0 && <p className="mt-1 text-sm text-muted">Move a slider or flip a switch. Values can only go inside their approved range, and the AI can never see or change them.</p>}
          {count > 0 && !lines && (
            <button type="button" onClick={review} className="mt-3 w-full rounded-lg bg-accent py-2.5 font-black text-white">Review changes</button>
          )}
          {lines && (
            <div className="mt-3 space-y-2">
              <ul className="space-y-1.5">
                {lines.map((l) => (
                  <li key={l.key} className={`pop-in rounded-lg border px-3 py-2 ${l.ok ? "border-line" : "border-down bg-down/5"}`}>
                    <div className="font-bold">{labelFor(l.key)}</div>
                    <div className="num text-sm"><span className="text-down line-through">{show(l.old)}</span> → <span className="font-black text-up">{show(l.new)}</span></div>
                    {l.reason && <div className="text-sm font-bold text-down">{l.reason}</div>}
                    {l.restart && <div className="text-xs font-bold text-warn">Needs a restart: {l.restart}.</div>}
                  </li>
                ))}
              </ul>
              <label className="block text-sm font-bold">
                PIN to confirm
                <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))} className="num mt-1 block w-full rounded-lg border border-line bg-ink px-3 py-2 text-lg tracking-[0.3em]" />
              </label>
              <div className="flex gap-2">
                <button type="button" disabled={busy || pin.length < 4 || lines.some((l) => !l.ok)} onClick={save} className="flex-1 rounded-lg bg-accent py-2.5 font-black text-white disabled:opacity-50">Save</button>
                <button type="button" onClick={() => { setDraft({}); setLines(null); }} className="rounded-lg border border-line px-4 py-2.5 font-bold">Undo</button>
              </div>
            </div>
          )}
          {msg && <p role="alert" className={`mt-3 rounded-lg px-3 py-2 text-sm font-bold ${msg.ok ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>{msg.text}</p>}
        </section>

        <section aria-labelledby="hist" className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
          <h2 id="hist" className="text-lg font-black">History</h2>
          {(history.data?.history ?? []).length === 0 ? (
            <p className="mt-1 text-sm text-muted">No changes yet. Every change is also in the Audit log.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {history.data!.history.slice(0, 12).map((h) => (
                <li key={h.id} className="text-sm">
                  <div className="font-bold">{labelFor(h.key)}</div>
                  <div className="num text-muted">{show(h.old)} → {show(h.new)} · {new Date(h.createdAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
