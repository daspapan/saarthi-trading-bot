"use client";

// Toasts for new alerts (fills, stops, targets, daily limit, health, kill switch),
// on every page. Optionally also a browser notification. Critical toasts stay until
// closed; others fade after 8 seconds.

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { type Alert, newAlerts } from "@/lib/risk";

const STYLE = { info: "border-accent bg-panel", warn: "border-warn bg-[#fff7ea]", critical: "border-down bg-[#fff0f2]" } as const;
const WORD = { info: "Info", warn: "Warning", critical: "Critical" } as const;

export function AlertToaster() {
  const { data } = useSWR<{ latestId: number; alerts: Alert[] }>("/backend/alerts?limit=20", fetcher, { refreshInterval: 3000 });
  const seen = useRef<number | null>(null);
  const [toasts, setToasts] = useState<Alert[]>([]);

  useEffect(() => {
    if (!data) return;
    const r = newAlerts(data.alerts, seen.current);
    seen.current = r.lastSeenId;
    if (r.show.length === 0) return;
    setToasts((t) => [...t, ...r.show].slice(-5));
    for (const a of r.show) {
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
        new Notification(`Saarthi: ${WORD[a.level]}`, { body: a.message, tag: String(a.id) });
      }
      if (a.level !== "critical") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== a.id)), 8_000);
    }
  }, [data]);

  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((a) => (
        <div key={a.id} role={a.level === "critical" ? "alert" : "status"} className={`slide-in pointer-events-auto rounded-xl border-l-[6px] p-3 shadow-lg ${STYLE[a.level]}`}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm">
              <span className={`mr-1 font-black ${a.level === "critical" ? "text-down" : a.level === "warn" ? "text-warn" : "text-accent"}`}>{WORD[a.level]}:</span>
              <span className="font-semibold">{a.message}</span>
            </p>
            <button type="button" onClick={() => setToasts((t) => t.filter((x) => x.id !== a.id))} aria-label="Dismiss" className="text-lg font-black text-muted">
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A small button to allow browser notifications (the browser only asks after a click). */
export function EnableNotifications() {
  const [state, setState] = useState<string>("unknown");
  useEffect(() => setState(typeof Notification === "undefined" ? "unsupported" : Notification.permission), []);
  if (state === "granted" || state === "unsupported" || state === "unknown") return null;
  return (
    <button
      type="button"
      onClick={async () => setState(await Notification.requestPermission())}
      className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm font-bold"
    >
      {state === "denied" ? "Notifications blocked in browser settings" : "Enable browser notifications"}
    </button>
  );
}
