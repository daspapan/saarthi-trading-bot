"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Live" },
  { href: "/analyst", label: "AI Analyst" },
  { href: "/orders", label: "Orders" },
  { href: "/backtest", label: "Backtest Lab" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="py-3 text-xl font-black tracking-tight">
          Saarthi<span className="text-accent">.</span>
        </Link>
        <ul className="flex gap-1">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={active ? "page" : undefined}
                  className={`block border-b-[3px] px-3 py-3 text-sm font-bold ${
                    active ? "border-accent text-accent" : "border-transparent text-muted hover:text-text"
                  }`}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
