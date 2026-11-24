// CFG-10: a static check over the source. Every environment variable any code
// reads must be documented in .env.example, and .env.local must be gitignored.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCAN_DIRS = ["packages", "apps", "scripts"];
const SKIP = new Set(["node_modules", ".next", "test"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Matches process.env.X, env.X and env["X"] where X is UPPER_SNAKE. */
const ENV_READ = /\b(?:process\.env|env)(?:\.([A-Z][A-Z0-9_]+)|\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\])/g;

function varsReadInCode(): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      for (const m of readFileSync(file, "utf8").matchAll(ENV_READ)) {
        const name = m[1] ?? m[2];
        if (name && name !== "NODE_ENV") found.set(name, file.replace(ROOT, ""));
      }
    }
  }
  return found;
}

function varsInEnvExample(): Set<string> {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  // Commented lines count too: secrets are listed as "# BINANCE_API_KEY=" on purpose.
  return new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));
}

describe("CFG-10 environment files", () => {
  it("CFG-10 every environment variable the code reads is listed in .env.example", () => {
    const documented = varsInEnvExample();
    const read = varsReadInCode();
    expect(read.size).toBeGreaterThan(10); // sanity: the scan actually found things
    const missing = [...read].filter(([name]) => !documented.has(name)).map(([n, f]) => `${n} (${f})`);
    expect(missing).toEqual([]);
  });

  it("CFG-10 .env and .env.local are gitignored", () => {
    const lines = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain(".env.local");
    expect(lines).toContain(".env");
  });
});
