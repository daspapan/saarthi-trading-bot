"use client";

// Light (default) or dark. Remembered in this browser; applied before the page
// paints by the small script in layout.tsx, so there's no flash.
import { useEffect, useState } from "react";

export const THEME_KEY = "saarthi-theme";

export function setTheme(t: "light" | "dark") {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  window.dispatchEvent(new Event("saarthi-theme"));
}

export const currentTheme = (): "light" | "dark" => (typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function ThemeToggle() {
  const [theme, set] = useState<"light" | "dark">("light");
  useEffect(() => {
    set(currentTheme());
    const on = () => set(currentTheme());
    window.addEventListener("saarthi-theme", on);
    return () => window.removeEventListener("saarthi-theme", on);
  }, []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" onClick={() => setTheme(next)} aria-label={`Switch to the ${next} theme`} title={`Switch to the ${next} theme (t)`} className="rounded-lg border border-line px-2.5 py-1.5 text-sm font-bold">
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
