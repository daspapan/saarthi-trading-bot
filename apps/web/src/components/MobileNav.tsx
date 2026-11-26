"use client";

// Phone layout: a bottom bar with the main pages and a red STOP button in the
// middle that opens the kill switch from any page (scene 10).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { RiskView } from "@/lib/risk";
import { KillSwitch } from "./cockpit/KillSwitch";

const LEFT = [
  { href: "/", label: "Cockpit" },
  { href: "/orders", label: "Orders" },
];
const RIGHT = [
  { href: "/analyst", label: "AI" },
  { href: "/performance", label: "Results" },
];

function Tab({ href, label, path }: { href: string; label: string; path: string }) {
  const active = href === "/" ? path === "/" : path.startsWith(href);
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={`flex flex-1 flex-col items-center py-2 text-xs font-black ${active ? "text-accent" : "text-muted"}`}>
      <span aria-hidden="true" className={`mb-1 block h-1 w-6 rounded ${active ? "bg-accent" : "bg-transparent"}`} />
      {label}
    </Link>
  );
}

export function MobileNav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const { data, mutate } = useSWR<RiskView>(open ? "/backend/risk" : null, fetcher, { refreshInterval: 2000 });
  return (
    <>
      <nav aria-label="Main (phone)" className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] sm:hidden">
        {LEFT.map((l) => <Tab key={l.href} {...l} path={path} />)}
        <div className="flex flex-1 justify-center">
          <button type="button" onClick={() => setOpen(true)} aria-label="Open the kill switch" className="-mt-5 h-16 w-16 rounded-full border-4 border-panel bg-[#be123c] text-sm font-black text-white shadow-lg">
            STOP
          </button>
        </div>
        {RIGHT.map((l) => <Tab key={l.href} {...l} path={path} />)}
      </nav>
      {open && (
        <div className="fixed inset-0 z-[65] bg-black/40 sm:hidden" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Kill switch" className="sheet-up absolute inset-x-0 bottom-0 max-h-[90vh] overflow-y-auto rounded-t-3xl bg-ink p-3 pb-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex justify-end">
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1 font-black text-muted">Close</button>
            </div>
            {data ? <KillSwitch v={data} onChange={() => void mutate()} /> : <div className="h-64 animate-pulse rounded-2xl bg-panel" />}
          </div>
        </div>
      )}
    </>
  );
}
