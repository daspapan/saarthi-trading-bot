"use client";

// The big kill switch. Enter the PIN (if one is set), then press and HOLD for two
// seconds: a ring fills around the button and it fires when the ring closes. Letting
// go early cancels. Keyboard: hold Space or Enter. While closing it shows progress;
// afterwards a PIN restart.

import { useEffect, useRef, useState } from "react";
import { HOLD_MS, type RiskView, holdProgress, tradingState } from "@/lib/risk";

async function post(path: string, body: object) {
  const res = await fetch(`/backend${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, message: (json.message ?? json.error ?? `HTTP ${res.status}`) as string };
}

export function KillSwitch({ v, onChange }: { v: RiskView; onChange: () => void }) {
  const [pin, setPin] = useState("");
  const [progress, setProgress] = useState(0);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const state = tradingState(v);

  const stopHold = () => {
    start.current = null;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    setProgress(0);
  };
  useEffect(() => stopHold, []);

  const fire = async () => {
    stopHold();
    setBusy(true);
    const r = await post("/kill", { pin });
    setMsg({ text: r.message, ok: r.ok });
    setBusy(false);
    if (r.ok) setPin("");
    onChange();
  };

  const beginHold = () => {
    if (busy || start.current !== null) return;
    if (v.pinRequired && pin.length < 4) {
      setMsg({ text: "Enter your PIN first.", ok: false });
      return;
    }
    setMsg(null);
    start.current = performance.now();
    const loop = (t: number) => {
      if (start.current === null) return;
      const p = holdProgress(t - start.current);
      setProgress(p);
      if (p >= 1) void fire();
      else raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
  };

  const restart = async () => {
    setBusy(true);
    const r = await post("/restart", { pin });
    setMsg({ text: r.message, ok: r.ok });
    setBusy(false);
    if (r.ok) setPin("");
    onChange();
  };

  const C = 2 * Math.PI * 70;
  const pinField = (
    <label className="block text-sm font-bold">
      PIN
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
        className="num mt-1 block w-36 rounded-lg border border-line bg-ink px-3 py-2 text-lg tracking-[0.3em]"
        aria-describedby="pin-help"
      />
    </label>
  );

  return (
    <section id="kill-switch" aria-labelledby="ks" className={`rounded-2xl border-2 p-5 shadow-sm ${state.kind === "trading" || state.kind === "daily-stop" ? "border-down/40 bg-panel" : "border-down bg-down/5"}`}>
      <h2 id="ks" className="text-xl font-black">Kill switch</h2>

      {(state.kind === "trading" || state.kind === "daily-stop") && (
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <button
            type="button"
            disabled={busy}
            onPointerDown={beginHold}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onPointerCancel={stopHold}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                e.preventDefault();
                beginHold();
              }
            }}
            onKeyUp={(e) => (e.key === " " || e.key === "Enter") && stopHold()}
            aria-label="Kill switch: press and hold for two seconds to cancel every order and sell every position"
            className="relative grid h-40 w-40 shrink-0 touch-none select-none place-items-center rounded-full"
          >
            <svg viewBox="0 0 160 160" className="absolute inset-0" aria-hidden="true">
              <circle cx="80" cy="80" r="70" fill="#be123c" />
              <circle cx="80" cy="80" r="70" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="8" />
              <circle cx="80" cy="80" r="70" fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - progress)} transform="rotate(-90 80 80)" />
            </svg>
            <span className="relative text-center text-lg font-black leading-tight text-white">
              {progress > 0 ? `${Math.ceil(((1 - progress) * HOLD_MS) / 1000)}…` : "HOLD TO\nSTOP".split("\n").map((l) => <span key={l} className="block">{l}</span>)}
            </span>
          </button>
          <div className="min-w-56 flex-1 space-y-3">
            <p className="font-semibold">
              Cancels every order and sells every position at market, then stops trading until you restart it with the PIN. It works even if the AI, the feeds or this page stop.
            </p>
            {v.pinRequired ? pinField : <p className="text-sm font-bold text-warn">No PIN is set, so anyone who can open this page can press it. Set PIN_HASH in .env.</p>}
            <p id="pin-help" className="text-sm text-muted">From a terminal: <code className="num">npm run kill -- &lt;PIN&gt;</code></p>
            {state.kind === "daily-stop" && <p className="rounded-lg bg-warn/10 px-3 py-2 text-sm font-bold text-warn">Daily loss limit hit: {state.reason} No new orders until 00:00 UTC.</p>}
          </div>
        </div>
      )}

      {state.kind === "liquidating" && (
        <div className="mt-3 flex items-center gap-4" role="status" aria-live="polite">
          <span className="attention block h-5 w-5 shrink-0 rounded-full bg-down" aria-hidden="true" />
          <p className="text-lg font-black text-down">
            Closing everything: {state.ordersLeft} order{state.ordersLeft === 1 ? "" : "s"} left · {state.sinceSec}s
          </p>
        </div>
      )}

      {state.kind === "stopped" && (
        <div className="mt-3 space-y-3">
          <p className="text-lg font-black text-down">Trading is stopped. {state.reason}</p>
          <p className="font-semibold">Everything is closed. Check the Orders page, then enter the PIN to allow new trades again.</p>
          <div className="flex flex-wrap items-end gap-3">
            {pinField}
            <button type="button" disabled={busy || pin.length < 4} onClick={restart} className="rounded-lg bg-accent px-4 py-2.5 font-black text-white disabled:opacity-50">
              Restart trading
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p role="alert" className={`mt-3 rounded-lg px-3 py-2 text-sm font-bold ${msg.ok ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
