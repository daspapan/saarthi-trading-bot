"use client";

// A term with a plain-language explanation: dotted underline, shown on hover,
// keyboard focus or tap (phones have no hover).
import { useId, useState } from "react";
import { explain } from "@/lib/glossary";

export function Term({ t, children }: { t: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const text = explain(t);
  if (!text) return <>{children ?? t}</>;
  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="cursor-help underline decoration-muted decoration-dotted underline-offset-4 [letter-spacing:inherit] [text-transform:inherit]"
      >
        {children ?? t}
      </button>
      {open && (
        <span role="tooltip" id={id} className="pop-in absolute top-full left-1/2 z-40 mt-1 block w-64 -translate-x-1/2 rounded-lg border border-line bg-panel p-2.5 text-left text-sm font-medium normal-case tracking-normal text-text shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}
