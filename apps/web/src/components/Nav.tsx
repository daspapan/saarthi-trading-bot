"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "Cockpit" },
  { href: "/analyst", label: "AI Analyst" },
  { href: "/orders", label: "Orders" },
  { href: "/performance", label: "Performance" },
  { href: "/backtest", label: "Backtest Lab" },
  { href: "/settings", label: "Strategy & Risk" },
  { href: "/audit", label: "Audit" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 sm:gap-6">
        <Link href="/" className="py-3 text-xl font-black tracking-tight">
          Saarthi<span className="text-accent">.</span>
        </Link>
        <ul className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto whitespace-nowrap">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`block border-b-[3px] px-2.5 py-3 text-sm font-bold ${
                    active ? "border-accent text-accent" : "border-transparent text-muted hover:text-text"
                  }`}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="hidden shrink-0 items-center gap-2 md:flex">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="rounded-lg border border-line px-2.5 py-1.5 text-sm font-bold text-muted"
            aria-label="Open the command palette"
          >
            <kbd className="num">⌘K</kbd>
          </button>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
