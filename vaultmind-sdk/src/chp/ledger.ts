/**
 * VaultMind SDK — CHP decision ledger (append-only JSONL).
 *
 * Port of the erp-control-plane DecisionLedger: every hardened vault decision
 * is sealed into a CHP payload envelope and appended to an append-only JSONL
 * file. The payload envelope validates STRUCTURE ONLY (BEGIN_PAYLOAD /
 * END_PAYLOAD markers with a matching route + payload id), so the ledger adds
 * its own SHA-256 digest over the sealed body — `body_sha256`. Every read
 * re-validates both layers and exposes `envelope_valid` and `integrity_valid`,
 * so a tampered record reads as invalid instead of silently succeeding.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SessionStatus } from "./session";

/** Route tag for vault-action decisions in payload envelopes. */
export const PAYLOAD_ROUTE = "VAULT_EXECUTE";

/** Ledger file override; default: `.chp/decisions.jsonl` under the cwd. */
export const LEDGER_PATH_ENV = "VAULTMIND_CHP_LEDGER_PATH";

export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[LEDGER_PATH_ENV] ?? resolve(process.cwd(), ".chp", "decisions.jsonl");
}

export function bodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Canonical JSON: recursive lexicographic key sort, no whitespace (§3.1). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`);
  return `{${entries.join(",")}}`;
}

/** Port of chp.PayloadEnvelope.render(). */
export function buildPayloadEnvelope(
  body: string,
  route: string = PAYLOAD_ROUTE,
  payloadId: string = randomUUID(),
): string {
  return [
    `BEGIN_PAYLOAD [${route}] [${payloadId}]`,
    body,
    `END_PAYLOAD [${route}] [${payloadId}]`,
  ].join("\n");
}

/**
 * Port of chp.validate_payload_envelope — STRUCTURE ONLY. It checks the
 * BEGIN/END markers and that the bracketed route + payload id match; it never
 * verifies the body (integrity is the ledger's `body_sha256` job).
 */
export function validatePayloadEnvelope(rendered: string | null | undefined): boolean {
  if (rendered === null || rendered === undefined) return false;
  const lines = rendered
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  if (lines.length < 3) return false;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first.startsWith("BEGIN_PAYLOAD [") || !last.startsWith("END_PAYLOAD [")) {
    return false;
  }
  return (
    first.replace("BEGIN_PAYLOAD", "").trim() ===
    last.replace("END_PAYLOAD", "").trim()
  );
}

/** The fields the ledger seals (body is canonical JSON over these). */
export type DecisionRecordFields = {
  decision_id: string;
  created_at: string;
  decision_kind: "vault_action";
  vault_id: string;
  action: string;
  asset: string;
  notional_usd: number;
  session_status: SessionStatus;
  r0_verdict: string;
  foundation_verdict: string;
  foundation_score: number;
  adversary_findings: string[];
  parity: ParitySnapshot | null;
  confirmed_by: string | null;
};

export interface ParitySnapshot {
  invariantId: string;
  metric: string;
  unit: string;
  expected: number;
  tolerance: number;
  actual: number | null;
  withinTolerance: boolean | null;
}

export interface DecisionRecord extends DecisionRecordFields {
  body: string;
  body_sha256: string;
  envelope: string;
}

/** A record as returned by a read: integrity re-checked. */
export type CheckedRecord = DecisionRecord & {
  envelope_valid: boolean;
  integrity_valid: boolean;
};

/** Seal a decision: canonical body → SHA-256 digest → payload envelope. */
export function sealDecision(fields: DecisionRecordFields): DecisionRecord {
  const body = canonicalJson(fields);
  return {
    ...fields,
    body,
    body_sha256: bodySha256(body),
    envelope: buildPayloadEnvelope(body),
  };
}

/** Re-validate a record: envelope structure + body digest (used on every read). */
export function checkRecord(record: DecisionRecord): CheckedRecord {
  return {
    ...record,
    envelope_valid: validatePayloadEnvelope(record.envelope),
    integrity_valid: bodySha256(record.body) === record.body_sha256,
  };
}

export class DecisionLedger {
  readonly path: string;

  constructor(path: string = defaultLedgerPath()) {
    this.path = path;
  }

  append(record: DecisionRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
  }

  /** Newest-first records with envelope + body integrity re-validated. */
  list(limit: number = 100): CheckedRecord[] {
    return this.readAll()
      .slice(-limit)
      .map(checkRecord)
      .reverse();
  }

  get(decisionId: string): CheckedRecord | null {
    for (const record of this.readAll().reverse()) {
      if (record.decision_id === decisionId) return checkRecord(record);
    }
    return null;
  }

  private readAll(): DecisionRecord[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split(/\r?\n/);
    // A torn or corrupt line is surfaced loudly, never swallowed.
    return lines
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as DecisionRecord);
  }
}
