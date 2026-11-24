// Animated arrows that sit beside status words and price changes.
// Two stacked chevrons, half a beat apart, give a steady "flowing" motion
// that reads well on video. Decorative only: the word next to it carries the meaning.

import type { Tone } from "@/lib/status";

type Props = { tone: Tone | "flat"; size?: number };

export function TrendArrow({ tone, size = 18 }: Props) {
  if (tone === "up" || tone === "down") {
    const up = tone === "up";
    const cls = up ? "arrow-rise" : "arrow-sink";
    const path = up ? "M4 14 L12 6 L20 14" : "M4 10 L12 18 L20 10";
    return (
      <span aria-hidden="true" className="relative inline-block shrink-0" style={{ width: size, height: size }}>
        {[false, true].map((delayed) => (
          <svg
            key={String(delayed)}
            viewBox="0 0 24 24"
            width={size}
            height={size}
            className={`absolute inset-0 ${cls} ${delayed ? "delay" : ""} ${up ? "text-up" : "text-down"}`}
          >
            <path d={path} fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ))}
      </span>
    );
  }
  if (tone === "warn") {
    return (
      <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
        <span className="attention block h-2.5 w-2.5 rounded-full bg-warn" />
      </span>
    );
  }
  // idle / flat: a short steady dash
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center text-muted" style={{ width: size, height: size }}>
      <span className="block h-[3px] w-3 rounded bg-current" />
    </span>
  );
}
