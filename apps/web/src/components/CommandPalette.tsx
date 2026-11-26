"use client";

// Cmd/Ctrl + K opens a search over pages and actions. Single-key shortcuts work
// anywhere except while typing: "g" then a letter jumps to a page, "t" switches
// theme, "!" opens the kill switch, "?" lists the shortcuts.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ALL_COMMANDS, type Command, filterCommands, isTypingTarget, matchShortcut } from "@/lib/commands";
import { currentTheme, setTheme } from "./ThemeToggle";

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const pending = useRef("");
  const list = filterCommands(q);

  const run = async (c: Command) => {
    setOpen(false);
    setQ("");
    if (c.href) {
      router.push(c.href);
      return;
    }
    if (c.action === "theme") setTheme(currentTheme() === "dark" ? "light" : "dark");
    if (c.action === "help") setHelp(true);
    if (c.action === "analyse") {
      const res = await fetch("/backend/analyse", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      setNote(body.message ?? body.error ?? "Requested.");
      setTimeout(() => setNote(null), 5000);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setSel(0);
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        setHelp(false);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (open || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(t?.tagName, t?.isContentEditable)) return;
      const r = matchShortcut(pending.current, e.key);
      pending.current = r.pending;
      if (r.command) {
        e.preventDefault();
        void run(r.command);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      {note && <div role="status" className="pop-in fixed top-16 left-1/2 z-[70] -translate-x-1/2 rounded-lg border border-line bg-panel px-4 py-2 font-bold shadow-lg">{note}</div>}
      {open && (
        <div className="fixed inset-0 z-[70] bg-black/40 p-4 pt-[12vh]" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Command palette" className="pop-in mx-auto max-w-lg overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setSel((s) => Math.min(list.length - 1, s + 1));
                if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
                if (e.key === "Enter" && list[sel]) void run(list[sel]!);
              }}
              placeholder="Go to a page or run an action…"
              aria-label="Search commands"
              className="w-full border-b border-line bg-transparent px-4 py-3.5 text-lg font-semibold outline-none"
            />
            <ul role="listbox" className="max-h-80 overflow-y-auto py-1">
              {list.map((c, i) => (
                <li key={c.id} role="option" aria-selected={i === sel}>
                  <button type="button" onMouseEnter={() => setSel(i)} onClick={() => void run(c)} className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left ${i === sel ? "bg-accent/10" : ""}`}>
                    <span>
                      <span className="font-bold">{c.label}</span>
                      {c.hint && <span className="ml-2 text-sm text-muted">{c.hint}</span>}
                    </span>
                    {c.keys && <kbd className="num rounded border border-line px-1.5 text-xs font-bold text-muted">{c.keys}</kbd>}
                  </button>
                </li>
              ))}
              {list.length === 0 && <li className="px-4 py-3 font-semibold text-muted">Nothing matches.</li>}
            </ul>
          </div>
        </div>
      )}
      {help && (
        <div className="fixed inset-0 z-[70] bg-black/40 p-4 pt-[12vh]" onClick={() => setHelp(false)}>
          <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="pop-in mx-auto max-w-md rounded-2xl border border-line bg-panel p-5 shadow-2xl">
            <h2 className="text-xl font-black">Keyboard shortcuts</h2>
            <ul className="mt-3 space-y-1.5">
              <li className="flex justify-between"><span className="font-semibold">Command palette</span><kbd className="num font-bold">⌘K / Ctrl K</kbd></li>
              {ALL_COMMANDS.filter((c) => c.keys).map((c) => (
                <li key={c.id} className="flex justify-between"><span className="font-semibold">{c.label}</span><kbd className="num font-bold">{c.keys}</kbd></li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted">Press Esc to close.</p>
          </div>
        </div>
      )}
    </>
  );
}
