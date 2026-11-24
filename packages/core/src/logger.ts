// One logger factory for every process, with two layers of secret protection:
// 1. pino `redact` removes known secret fields from logged objects.
// 2. A scrub hook replaces any known secret VALUE wherever it appears, including
//    inside error messages and stack traces (exchange libraries love to echo
//    request details back in errors).

import pino, { type DestinationStream, type Logger } from "pino";
import pretty from "pino-pretty";

const REDACT_PATHS = [
  "apiKey",
  "secret",
  "password",
  "pin",
  "*.apiKey",
  "*.secret",
  "*.password",
  "*.pin",
  "headers.authorization",
  'headers["x-mbx-apikey"]',
  'headers["X-MBX-APIKEY"]',
  "env.BINANCE_API_KEY",
  "env.BINANCE_API_SECRET",
  "env.BYBIT_API_KEY",
  "env.BYBIT_API_SECRET",
];

export const REDACTED = "[REDACTED]";

/** Replaces every occurrence of each secret in `text`. Ignores very short values. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join(REDACTED);
  }
  return out;
}

function scrubValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 5) return value;
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (value instanceof Error) {
    const copy = new Error(scrubSecrets(value.message, secrets));
    copy.name = value.name;
    copy.stack = value.stack ? scrubSecrets(value.stack, secrets) : undefined;
    return copy;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, secrets, depth + 1);
    return out;
  }
  return value;
}

export type LoggerOptions = {
  level?: string;
  /** Secret values to scrub from every log line (the executor passes its keys). */
  secrets?: readonly string[];
  /** For tests: write to this stream instead of stdout. */
  destination?: DestinationStream;
  /**
   * Human-readable coloured output (pino-pretty) instead of JSON lines.
   * Defaults to LOG_PRETTY=true. Redaction and scrubbing happen BEFORE
   * formatting, so pretty logs are just as safe as JSON logs.
   */
  pretty?: boolean;
};

function prettyStream(): DestinationStream {
  // sync: true so a fatal startup message is printed before process.exit().
  return pretty({ colorize: true, sync: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" });
}

export function createLogger(name: string, opts: LoggerOptions = {}): Logger {
  const secrets = opts.secrets ?? [];
  return pino(
    {
      name,
      level: opts.level ?? "info",
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      hooks: {
        logMethod(args, method) {
          const clean = secrets.length ? args.map((a) => scrubValue(a, secrets)) : args;
          return method.apply(this, clean as Parameters<typeof method>);
        },
      },
    },
    opts.destination ?? ((opts.pretty ?? process.env.LOG_PRETTY === "true") ? prettyStream() : undefined),
  );
}
