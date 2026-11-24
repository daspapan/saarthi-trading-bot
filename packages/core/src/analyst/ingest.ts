// The API's side of "POST /signals": check what the analyst sent, run the
// guardrails on every signal, and store everything, including rejections and
// their reasons (GR-11). Every stored signal also gets an audit row (rule 8).
//
// The analyst can't write to the database itself; this is its only way in.

import { z } from "zod";
import { appendAudit } from "../audit.ts";
import { type Db, nowIso } from "../db/db.ts";
import { checkSignal } from "./guardrails.ts";
import { type Snapshot, snapshotHash, storeSnapshot } from "./snapshot.ts";

export const submissionSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  trigger: z.enum(["schedule", "manual"]),
  snapshot: z.looseObject({
    version: z.literal(1),
    createdAt: z.string(),
    pairs: z.array(z.looseObject({ pair: z.string() })),
    candidates: z.array(z.looseObject({ id: z.string() })),
    facts: z.array(z.strictObject({ name: z.string(), value: z.number() })),
  }),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.enum(["ollama", "fail-closed", "skipped"]),
  output: z.unknown(),
  rawText: z.string().max(50_000).nullable(),
  note: z.string().max(500).nullable(),
  model: z.string().max(100),
  latencyMs: z.number().int().nonnegative().nullable(),
  attempts: z.number().int().min(0).max(5),
});

export type StoredSignal = { id: number; pair: string; direction: string; passed: boolean; reasons: string[] };
export type IngestResult = { ok: true; runId: string; snapshotHash: string; signals: StoredSignal[] } | { ok: false; error: string };

const MAX_DIRECTION_CHARS = 16;

export function ingestAnalysis(db: Db, body: unknown): IngestResult {
  const parsed = submissionSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return { ok: false, error: `Invalid submission: ${i.path.join(".") || "body"}: ${i.message}` };
  }
  const sub = parsed.data;
  const snapshot = sub.snapshot as unknown as Snapshot;
  if (snapshotHash(snapshot) !== sub.snapshotHash) {
    return { ok: false, error: "The snapshot's hash doesn't match its contents." };
  }

  const createdAt = nowIso();
  const stored: StoredSignal[] = [];
  // IMMEDIATE: take the write lock now, so the audit rows chain safely inside this transaction.
  db.exec("BEGIN IMMEDIATE");
  try {
    storeSnapshot(db, snapshot);
    const insertSignal = db.prepare(
      `INSERT INTO signals (snapshot_hash, pair, direction, candidate_id, confidence, raw_json, source, created_at, run_id, note, model, latency_ms, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertResult = db.prepare("INSERT INTO guardrail_results (signal_id, passed, reasons_json, created_at) VALUES (?, ?, ?, ?)");

    const save = (pair: string, direction: string, candidateId: string | null, confidence: string | null, raw: unknown, note: string | null, passed: boolean, reasons: string[]) => {
      const info = insertSignal.run(
        sub.snapshotHash,
        pair,
        direction,
        candidateId,
        confidence,
        JSON.stringify(raw ?? null),
        sub.source,
        createdAt,
        sub.runId,
        note,
        sub.model,
        sub.latencyMs,
        sub.trigger,
      );
      const id = Number(info.lastInsertRowid);
      insertResult.run(id, passed ? 1 : 0, JSON.stringify(reasons), createdAt);
      stored.push({ id, pair, direction, passed, reasons });
    };

    const pairs = snapshot.pairs.map((p) => p.pair);
    if (sub.source !== "ollama") {
      // System-made neutral signals: the AI was skipped or unavailable. Nothing to check.
      for (const pair of pairs) save(pair, "neutral", null, null, null, sub.note, true, []);
    } else {
      const items = Array.isArray((sub.output as { signals?: unknown })?.signals) ? ((sub.output as { signals: unknown[] }).signals) : [];
      const used = new Set<number>();
      for (const pair of pairs) {
        const idx = items.findIndex((it, i) => !used.has(i) && (it as { pair?: unknown })?.pair === pair);
        if (idx === -1) {
          save(pair, "neutral", null, null, null, "The model returned no signal for this pair.", false, ["No signal returned for this pair."]);
          continue;
        }
        used.add(idx);
        const raw = items[idx];
        const result = checkSignal(raw, snapshot);
        const r = raw as Record<string, unknown>;
        const direction = result.signal?.direction ?? (typeof r.direction === "string" ? r.direction.slice(0, MAX_DIRECTION_CHARS) : "invalid");
        const candidateId = result.signal?.candidateId ?? (typeof r.candidateId === "string" ? r.candidateId.slice(0, 120) : null);
        const confidence = result.signal?.confidence ?? (typeof r.confidence === "string" ? r.confidence.slice(0, 16) : null);
        save(pair, direction, candidateId, confidence, raw, null, result.passed, result.reasons);
      }
      // Anything else the model sent (unknown pairs, duplicates) is stored as rejected too.
      items.forEach((raw, i) => {
        if (used.has(i)) return;
        const p = (raw as { pair?: unknown })?.pair;
        save(typeof p === "string" ? p.slice(0, 20) : "unknown", "invalid", null, null, raw, null, false, [
          typeof p === "string" && pairs.includes(p) ? `A second signal for ${p}: only one per pair is allowed.` : `Signal for a pair that isn't in the snapshot: ${String(p)}.`,
        ]);
      });
    }

    for (const s of stored) {
      appendAudit(db, "signal", "analyst", {
        signalId: s.id,
        runId: sub.runId,
        pair: s.pair,
        direction: s.direction,
        source: sub.source,
        guardrailsPassed: s.passed,
        reasons: s.reasons,
        snapshotHash: sub.snapshotHash,
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { ok: true, runId: sub.runId, snapshotHash: sub.snapshotHash, signals: stored };
}

// ---------- reading signals back for the AI Analyst page ----------

export type EvidenceRow = { name: string; aiValue: unknown; snapshotValue: number | null; match: boolean };

export type SignalCard = {
  id: number;
  runId: string | null;
  createdAt: string;
  pair: string;
  direction: string;
  confidence: string | null;
  source: string;
  trigger: string | null;
  note: string | null;
  model: string | null;
  latencyMs: number | null;
  snapshotHash: string | null;
  rationale: string | null;
  triggerText: string | null;
  invalidation: string | null;
  candidate: Snapshot["candidates"][number] | null;
  evidence: EvidenceRow[];
  guardrails: { passed: boolean; reasons: string[] };
};

type Row = {
  id: number;
  run_id: string | null;
  created_at: string;
  pair: string;
  direction: string;
  confidence: string | null;
  source: string;
  trigger: string | null;
  note: string | null;
  model: string | null;
  latency_ms: number | null;
  snapshot_hash: string | null;
  candidate_id: string | null;
  raw_json: string;
  passed: number | null;
  reasons_json: string | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

export function listSignalCards(db: Db, limit = 60): SignalCard[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.run_id, s.created_at, s.pair, s.direction, s.confidence, s.source, s.trigger, s.note, s.model, s.latency_ms,
              s.snapshot_hash, s.candidate_id, s.raw_json, g.passed, g.reasons_json
       FROM signals s LEFT JOIN guardrail_results g ON g.signal_id = s.id
       ORDER BY s.id DESC LIMIT ?`,
    )
    .all(limit) as Row[];

  const snapshots = new Map<string, Snapshot | null>();
  const snapshotFor = (hash: string | null) => {
    if (!hash) return null;
    if (!snapshots.has(hash)) {
      const r = db.prepare("SELECT json FROM snapshots WHERE hash = ?").get(hash) as { json: string } | undefined;
      snapshots.set(hash, r ? (JSON.parse(r.json) as Snapshot) : null);
    }
    return snapshots.get(hash)!;
  };

  return rows.map((r) => {
    const raw = JSON.parse(r.raw_json) as Record<string, unknown> | null;
    const snap = snapshotFor(r.snapshot_hash);
    const facts = new Map((snap?.facts ?? []).map((f) => [f.name, f.value]));
    const points = Array.isArray(raw?.dataPoints) ? (raw!.dataPoints as { name?: unknown; value?: unknown }[]) : [];
    const evidence = points.slice(0, 10).map((p) => {
      const name = typeof p?.name === "string" ? p.name : String(p?.name);
      const truth = facts.get(name) ?? null;
      return { name, aiValue: p?.value ?? null, snapshotValue: truth, match: truth !== null && typeof p?.value === "number" && Math.abs(truth - p.value) < 1e-9 };
    });
    return {
      id: r.id,
      runId: r.run_id,
      createdAt: r.created_at,
      pair: r.pair,
      direction: r.direction,
      confidence: r.confidence,
      source: r.source,
      trigger: r.trigger,
      note: r.note,
      model: r.model,
      latencyMs: r.latency_ms,
      snapshotHash: r.snapshot_hash,
      rationale: str(raw?.rationale),
      triggerText: str(raw?.trigger),
      invalidation: str(raw?.invalidation),
      candidate: (r.candidate_id && snap?.candidates.find((c) => c.id === r.candidate_id)) || null,
      evidence,
      guardrails: { passed: r.passed === 1, reasons: r.reasons_json ? (JSON.parse(r.reasons_json) as string[]) : [] },
    };
  });
}

/** Queues an "Analyse now" request for the analyst process to pick up. */
export function requestAnalysis(db: Db): number {
  const info = db.prepare("INSERT INTO analysis_requests (requested_at) VALUES (?)").run(nowIso());
  return Number(info.lastInsertRowid);
}

/** Newest request ID (read-only query; the analyst runs once per new ID). */
export function latestAnalysisRequest(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM analysis_requests").get() as { id: number }).id;
}
