"use client";

// A number that rolls from its old value to the new one (0.6 s, easing out).
// Reduced motion: it just changes.
import { useEffect, useRef, useState } from "react";
import { tween } from "@/lib/ticker";
import { useReducedMotion } from "@/lib/useReducedMotion";

export function NumberTicker({ value, format, className }: { value: number; format: (v: number) => string; className?: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduced || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const p = (t - start) / 600;
      setShown(tween(a, value, p));
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, reduced]);
  return <span className={`num ${className ?? ""}`}>{format(shown)}</span>;
}
