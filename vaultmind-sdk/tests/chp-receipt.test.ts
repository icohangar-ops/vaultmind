/**
 * VaultMind row-22 receipt tests — mirrors the merged cognitrader-bsc /
 * deepbook-trading-agent receipt suites. The contract under test: a CHP
 * gate verdict — even LOCKED — is an allowlist answer, not authorization.
 * A vault action applies only when a signed receipt binds the exact action
 * arguments, the policy version, an expiry window, and a single-use nonce;
 * any mismatch, replay, or missing key refuses the action fail-closed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentEngine, DEMO_AGENTS } from "../src/agent-engine";
import { DecisionLedger } from "../src/chp/ledger";
import { HUMAN_LOCK_ENV } from "../src/chp/session";
import {
  RECEIPT_KEY_ENV,
  hashVaultActionArgs,
  issueVaultActionReceipt,
  parseVaultActionReceipt,
  resolveReceiptKey,
  verifyExecutionReceipt,
  type VaultActionReceipt,
  type VaultActionReceiptArgs,
} from "../src/chp/receipt";
import { FileReplayStore, InMemoryReplayStore } from "../src/chp/replay";

const KEY = "test-receipt-key-0189ac1e";

const args: VaultActionReceiptArgs = {
  action: "buy",
  asset: "SUI",
  amount: 185,
  vaultId: "vault-1",
};

function issueAllow(overrides?: Partial<Parameters<typeof issueVaultActionReceipt>[0]>) {
  return issueVaultActionReceipt(
    {
      actor: "sam@cubiczan.com",
      resource: "vaultmind:execute:vault-1:SUI",
      args_hash: hashVaultActionArgs(args),
      policy_version: "1.0-default",
      risk: "medium",
      decision: "allow",
      ttlMs: 300_000,
      ...overrides,
    },
    KEY,
  );
}

function tmpLedger(): DecisionLedger {
  return new DecisionLedger(
    join(mkdtempSync(join(tmpdir(), "vaultmind-receipt-")), "decisions.jsonl"),
  );
}

test("resolveReceiptKey: fails closed when the env var is unset or blank", () => {
  delete process.env[RECEIPT_KEY_ENV];
  assert.throws(() => resolveReceiptKey(), new RegExp(RECEIPT_KEY_ENV));
  process.env[RECEIPT_KEY_ENV] = "   ";
  try {
    assert.throws(() => resolveReceiptKey(), new RegExp(RECEIPT_KEY_ENV));
  } finally {
    delete process.env[RECEIPT_KEY_ENV];
  }
});

test("resolveReceiptKey: uses the env var when set and the override when given", () => {
  process.env[RECEIPT_KEY_ENV] = "env-key";
  try {
    assert.equal(resolveReceiptKey(), "env-key");
    assert.equal(resolveReceiptKey("explicit-key"), "explicit-key");
  } finally {
    delete process.env[RECEIPT_KEY_ENV];
  }
});

test("hashVaultActionArgs: canonical — key order stable, value changes differ", () => {
  const reordered: VaultActionReceiptArgs = {
    action: "buy",
    asset: "SUI",
    vaultId: "vault-1",
    amount: 185,
  };
  // Object literal key order differs from the canonical fixture; the
  // digest must not.
  assert.equal(hashVaultActionArgs(reordered), hashVaultActionArgs(args));
  const changed: VaultActionReceiptArgs = { ...args, amount: 186 };
  assert.notEqual(hashVaultActionArgs(changed), hashVaultActionArgs(args));
});

test("verifyExecutionReceipt: accepts a freshly issued receipt", () => {
  const receipt = issueAllow();
  const verdict = verifyExecutionReceipt(
    receipt,
    { argsHash: receipt.args_hash, policyVersion: receipt.policy_version, key: KEY },
    new InMemoryReplayStore(),
  );
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.receipt.actor, "sam@cubiczan.com");
    assert.equal(verdict.receipt.tool, "vault_execute");
  }
});

test("verifyExecutionReceipt: rejects a tampered signature", () => {
  const receipt = issueAllow();
  const tampered: VaultActionReceipt = {
    ...receipt,
    signature: receipt.signature.slice(0, 62) + (receipt.signature.endsWith("a") ? "b" : "a"),
  };
  const verdict = verifyExecutionReceipt(
    tampered,
    { argsHash: receipt.args_hash, policyVersion: receipt.policy_version, key: KEY },
    new InMemoryReplayStore(),
  );
  assert.deepEqual(verdict, { ok: false, reason: "receipt signature verification failed" });
});

test("verifyExecutionReceipt: rejects a receipt whose args hash does not match", () => {
  const receipt = issueAllow();
  const verdict = verifyExecutionReceipt(
    receipt,
    {
      argsHash: hashVaultActionArgs({ ...args, amount: 186 }),
      policyVersion: receipt.policy_version,
      key: KEY,
    },
    new InMemoryReplayStore(),
  );
  assert.deepEqual(verdict, {
    ok: false,
    reason: "receipt args_hash does not match the vault-action args",
  });
});

test("verifyExecutionReceipt: rejects an expired receipt", () => {
  const receipt = issueAllow({ ttlMs: -1_000 });
  const verdict = verifyExecutionReceipt(
    receipt,
    { argsHash: receipt.args_hash, policyVersion: receipt.policy_version, key: KEY },
    new InMemoryReplayStore(),
    Date.parse(receipt.expiry) + 1,
  );
  assert.deepEqual(verdict, { ok: false, reason: "receipt expired" });
});

test("verifyExecutionReceipt: rejects a policy-version mismatch", () => {
  const receipt = issueAllow();
  const verdict = verifyExecutionReceipt(
    receipt,
    { argsHash: receipt.args_hash, policyVersion: "2.0-other", key: KEY },
    new InMemoryReplayStore(),
  );
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /policy_version/);
});

test("verifyExecutionReceipt: consumes the nonce exactly once — replay is a deny", () => {
  const replay = new InMemoryReplayStore();
  const receipt = issueAllow();
  const expected = { argsHash: receipt.args_hash, policyVersion: receipt.policy_version, key: KEY };
  assert.equal(verifyExecutionReceipt(receipt, expected, replay).ok, true);
  const second = verifyExecutionReceipt(receipt, expected, replay);
  assert.deepEqual(second, { ok: false, reason: "receipt nonce already consumed (replay)" });
});

test("parseVaultActionReceipt: rejects unknown extra keys and ambiguous bindings", () => {
  const extra = issueAllow() as unknown as Record<string, unknown>;
  extra["sneaky"] = "injection";
  assert.equal(parseVaultActionReceipt(extra), undefined);

  for (const actor of ["*", "", "any", null]) {
    const receipt = issueAllow({ actor: actor as string }) as unknown as Record<string, unknown>;
    if (actor === null) receipt["actor"] = null;
    assert.equal(parseVaultActionReceipt(receipt), undefined, `actor=${String(actor)}`);
  }
});

test("verifyExecutionReceipt: rejects a deny-decision receipt", () => {
  const deny = issueVaultActionReceipt(
    {
      actor: "sam@cubiczan.com",
      resource: "vaultmind:execute:vault-1:SUI",
      args_hash: hashVaultActionArgs(args),
      policy_version: "1.0-default",
      risk: "medium",
      decision: "deny",
      ttlMs: 300_000,
    },
    KEY,
  );
  const verdict = verifyExecutionReceipt(
    deny,
    { argsHash: deny.args_hash, policyVersion: deny.policy_version, key: KEY },
    new InMemoryReplayStore(),
  );
  assert.deepEqual(verdict, { ok: false, reason: "receipt decision is deny" });
});

test("FileReplayStore: persists consumed nonces across instances and skips corrupt lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultmind-replay-"));
  try {
    const logPath = join(dir, "state", "replay-nonces.jsonl");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(logPath, '{"nonce":"broken-line",\n', "utf-8");
    const first = new FileReplayStore(logPath);
    first.consume({ nonce: "n-1", consumedAt: "t", argsHash: "h", tool: "t", resource: "r" });
    const second = new FileReplayStore(logPath);
    assert.equal(second.seen("n-1"), true);
    assert.equal(second.seen("n-2"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileReplayStore: persistence failure fails closed — consume throws, nonce stays burned", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultmind-replay-broken-"));
  try {
    // A file where the log's parent directory should be: mkdir/append fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf-8");
    const store = new FileReplayStore(join(blocker, "child", "replay-nonces.jsonl"));
    const record = { nonce: "n-1", consumedAt: "t", argsHash: "h", tool: "t", resource: "r" };
    assert.throws(() => store.consume(record), /fail-closed/);
    // The nonce is still burned in-memory: the same receipt cannot be
    // honored twice in-process even though persistence failed.
    assert.equal(store.seen("n-1"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Agent loop: a replay-log write failure refuses the action before the post state lands", () => {
  const dir = mkdtempSync(join(tmpdir(), "vaultmind-replay-engine-"));
  try {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf-8");
    const brokenReplay = new FileReplayStore(join(blocker, "child", "replay-nonces.jsonl"));
    const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, tmpLedger(), {
      key: KEY,
      replay: brokenReplay,
    });
    const entry = engine.executeSignal(
      { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "broken log" },
      "vault-1",
      "sam@cubiczan.com",
    );
    assert.equal(entry.result, "failure");
    assert.match(entry.details, /replay-log persistence failed/);
    // Nothing applied: the R0/parity-verified post state must not land.
    const sui = engine.getMemory().positionSnapshot?.tokens.find((t) => t.symbol === "SUI");
    assert.equal(sui?.amount, 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AgentEngine wiring at the execution boundary ─────────────────────

test("Agent loop: refuses the action fail-closed when no receipt key is configured", () => {
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, tmpLedger());
  const entry = engine.executeSignal(
    { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "no key" },
    "vault-1",
    "sam@cubiczan.com",
  );
  assert.equal(entry.result, "failure");
  assert.match(entry.details, /VAULTMIND_CHP_RECEIPT_KEY/);
  // Nothing applied: the R0/parity-verified post state must not land.
  const sui = engine.getMemory().positionSnapshot?.tokens.find((t) => t.symbol === "SUI");
  assert.equal(sui?.amount, 2000);
});

test("Agent loop: a confirmed action applies the post state and records the receipt", () => {
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, tmpLedger(), {
    key: KEY,
    replay: new InMemoryReplayStore(),
  });
  const entry = engine.executeSignal(
    { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "momentum entry" },
    "vault-1",
    "sam@cubiczan.com",
  );
  assert.equal(entry.result, "success");
  assert.equal(entry.receiptActor, "sam@cubiczan.com");
  assert.ok(entry.receiptNonce && entry.receiptNonce.length > 0);
});

test("Agent loop: autonomous execution records the policy-engine actor", () => {
  // The human lock defaults ON; autonomous operation disables it via env
  // (same pattern as tests/chp.test.ts).
  process.env[HUMAN_LOCK_ENV] = "0";
  try {
    const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, tmpLedger(), {
      key: KEY,
      replay: new InMemoryReplayStore(),
    });
    const entry = engine.executeSignal(
      { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "autonomous" },
      "vault-1",
    );
    assert.equal(entry.result, "success");
    assert.equal(entry.receiptActor, "chp:policy-engine");
  } finally {
    delete process.env[HUMAN_LOCK_ENV];
  }
});

test("Agent loop: each approval mints a fresh nonce", () => {
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, tmpLedger(), {
    key: KEY,
    replay: new InMemoryReplayStore(),
  });
  const first = engine.executeSignal(
    { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "first" },
    "vault-1",
    "sam@cubiczan.com",
  );
  const second = engine.executeSignal(
    { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "second" },
    "vault-1",
    "sam@cubiczan.com",
  );
  assert.ok(first.receiptNonce);
  assert.ok(second.receiptNonce);
  assert.notEqual(first.receiptNonce, second.receiptNonce);
});

test("Agent loop: hold signals still bypass the gate and receipt entirely", () => {
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, tmpLedger());
  const entry = engine.executeSignal(
    { action: "hold", token: "SUI", amount: 0, confidence: 0.5, reasoning: "no signal" },
    "vault-1",
  );
  assert.equal(entry.result, "success");
  assert.equal(entry.chpDecisionId, undefined);
  assert.equal(entry.receiptNonce, undefined);
});
