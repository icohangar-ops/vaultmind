// ============================================================
// VaultMind SDK — Receipt Nonce Replay Store
// Port of cubiczan-chp-mcp `src/replay.ts` (via the cognitrader-bsc
// and deepbook-trading-agent merged ports, including their JSONL
// persistence): a receipt is single-use. Replaying the same nonce —
// even with a valid MAC and unexpired window — is a deny.
// ============================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const REPLAY_LOG_ENV = "VAULTMIND_CHP_REPLAY_LOG";

export interface ReplayRecord {
  nonce: string;
  consumedAt: string;
  argsHash: string;
  tool: string;
  resource: string;
}

export interface ReplayStore {
  seen(nonce: string): boolean;
  consume(record: ReplayRecord): void;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly used = new Map<string, ReplayRecord>();

  seen(nonce: string): boolean {
    return this.used.has(nonce);
  }

  consume(record: ReplayRecord): void {
    this.used.set(record.nonce, record);
  }

  get(nonce: string): ReplayRecord | undefined {
    return this.used.get(nonce);
  }

  get size(): number {
    return this.used.size;
  }
}

/**
 * JSONL-backed replay store: consumed nonces survive a process restart, so
 * a receipt issued before a restart cannot be replayed within its TTL (the
 * in-memory store forgets them — the same review finding cognitrader-bsc
 * fixed). Append-only, one JSON record per line, stored under `state/`.
 * A missing or corrupt file starts empty (worst case: a stale nonce is
 * forgotten — never a false deny); entries past a receipt TTL are harmless
 * to keep.
 */
export class FileReplayStore implements ReplayStore {
  private readonly used = new Map<string, ReplayRecord>();

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) return;
    try {
      for (const line of readFileSync(filePath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const record = JSON.parse(trimmed) as ReplayRecord;
          if (typeof record.nonce === "string" && record.nonce.trim() !== "") {
            this.used.set(record.nonce, record);
          }
        } catch {
          console.warn(`[chp] replay log ${this.filePath}: skipping corrupt line`);
        }
      }
    } catch (error) {
      console.warn(
        `[chp] replay log ${this.filePath} unreadable, starting empty: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  seen(nonce: string): boolean {
    return this.used.has(nonce);
  }

  consume(record: ReplayRecord): void {
    this.used.set(record.nonce, record);
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
    } catch (error) {
      // Fail closed (CHP R0): if the nonce cannot be persisted, the caller
      // must NOT apply the action — in-memory-only consumption would leave
      // a cross-restart replay window inside the receipt TTL. The in-memory
      // set is still updated, so this receipt cannot be honored twice
      // in-process either; callers surface the throw as a refusal recorded
      // in the decision ledger, which is the operator signal.
      console.error(
        `[chp] replay log ${this.filePath} write failed (refusing the action): ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        `replay-log persistence failed for nonce ${record.nonce}: refusing the action fail-closed`,
      );
    }
  }
}

/** Default replay-log path, overridable via $VAULTMIND_CHP_REPLAY_LOG. */
export function defaultReplayLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[REPLAY_LOG_ENV] ?? path.join("state", "replay-nonces.jsonl");
}
