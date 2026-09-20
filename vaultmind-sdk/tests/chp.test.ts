/**
 * VaultMind CHP tests — mirrors the erp-control-plane CHP suite
 * (R0 refusal, foundation floor + parity mismatch, human lock flow,
 * ledger round trip + tamper detection, Profile B spend gate,
 * vault-loop integration).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChpGate, type RiskPolicy } from "../src/chp/gate";
import { defaultPolicy } from "../src/chp/policy";
import { R0Evaluator } from "../src/chp/r0";
import {
  assessFoundation,
  defaultGoldenInvariants,
  DEFI_FLOOR,
  FULL_SCORE,
  GUARDRAIL_POINTS,
  BOUNDED_RESULT_POINTS,
  PARITY_POINTS,
} from "../src/chp/foundation";
import {
  openCase,
  applyThirdPartyValidation,
  markProvisionalLock,
  requireHumanLockEnabled,
  HUMAN_LOCK_ENV,
} from "../src/chp/session";
import {
  DecisionLedger,
  sealDecision,
  checkRecord,
  buildPayloadEnvelope,
  validatePayloadEnvelope,
  canonicalJson,
} from "../src/chp/ledger";
import {
  HardenedChpGate,
  deterministicVaultTransition,
  DEMO_PRICES_USD,
  type HardenedGateOptions,
} from "../src/chp/hardened-gate";
import { AgentEngine, DEMO_AGENTS, seededSnapshot, type PositionSnapshot } from "../src/agent-engine";

// ── Helpers ──────────────────────────────────────────────────

function tmpLedger(): DecisionLedger {
  return new DecisionLedger(join(mkdtempSync(join(tmpdir(), "chp-test-")), "decisions.jsonl"));
}

function tightPolicy(): RiskPolicy {
  return {
    version: "test",
    maxNotionalUsd: 1000,
    dailyNotionalCapUsd: 5000,
    hitlThresholdUsd: 100000,
    minConfidence: 0.55,
    allowedActions: ["buy", "sell", "rebalance"],
    perAssetLimits: {},
  };
}

function makeHardenedGate(options?: Partial<HardenedGateOptions>): HardenedChpGate {
  return new HardenedChpGate({
    spend: new ChpGate(),
    ledger: tmpLedger(),
    ...options,
  });
}

/** Post state simulating value creation — violates the pinned invariant set. */
function valueCreatingTransition(): HardenedGateOptions["transition"] {
  return (_pre) => {
    const post = seededSnapshot();
    return {
      ok: true,
      post: { ...post, totalValueSui: post.totalValueSui + 10 },
    };
  };
}

// ── R0 solvability gate ──────────────────────────────────────

test("R0: capitalized result keys, PASS verdict when all criteria hold", () => {
  const evaluation = new R0Evaluator().evaluate({ solvable: true, scoped: true, valid: true, worthIt: true });
  assert.deepEqual(Object.keys(evaluation.results), ["Solvable", "Scoped", "Valid", "Worth_it"]);
  for (const value of Object.values(evaluation.results)) {
    assert.equal(value, "PASS");
  }
  assert.equal(evaluation.verdict, "PASS");
  assert.deepEqual(evaluation.failures, []);
});

test("R0: failures are FATAL and the verdict HALTs", () => {
  const evaluation = new R0Evaluator().evaluate({ solvable: false, scoped: true, valid: false, worthIt: true });
  assert.equal(evaluation.results.Solvable, "FATAL");
  assert.equal(evaluation.results.Valid, "FATAL");
  assert.equal(evaluation.results.Scoped, "PASS");
  assert.equal(evaluation.verdict, "HALT");
  assert.deepEqual(evaluation.failures, ["Solvable", "Valid"]);
});

test("R0: an unsolvable vault action HALTs before the spend gate", () => {
  // Seeded vault holds 2,000 SUI; selling 5,000 USD worth (2,702 SUI) is
  // unsolvable from current state.
  const gate = makeHardenedGate();
  const outcome = gate.evaluateHardened(
    { action: "sell", asset: "SUI", notionalUsd: 5000, confidence: 0.9, rationale: "overdrawn", vaultId: "vault-1" },
    seededSnapshot(),
  );
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stage, "R0");
  assert.equal(outcome.state, "HALT");
  assert.equal(outcome.r0?.results.Solvable, "FATAL");
  assert.equal(outcome.record, undefined);
});

test("R0: acting from an empty vault (null state) is fatal", () => {
  const gate = makeHardenedGate();
  const outcome = gate.evaluateHardened(
    { action: "buy", asset: "SUI", notionalUsd: 10, confidence: 0.9, rationale: "nothing", vaultId: "vault-1" },
    null,
  );
  assert.equal(outcome.stage, "R0");
  assert.equal(outcome.state, "HALT");
  assert.match(outcome.reason, /failed Solvable/);
});

// ── Deterministic adversary foundation pass ──────────────────

test("Foundation: clean 40+30+30 assessment scores 100 and passes the DeFi floor", () => {
  const assessment = assessFoundation({
    guardrailsPassed: true,
    preState: seededSnapshot(),
    postState: seededSnapshot(),
  });
  assert.equal(assessment.score, FULL_SCORE);
  assert.equal(GUARDRAIL_POINTS + BOUNDED_RESULT_POINTS + PARITY_POINTS, FULL_SCORE);
  assert.equal(assessment.domain, "defi");
  assert.equal(assessment.floor === undefined, true, "floor is enforced by the gate");
  assert.ok(DEFI_FLOOR <= assessment.score);
  assert.equal(assessment.verdict, "PASS");
  assert.equal(assessment.goldenMatched, true);
  assert.equal(assessment.parity?.withinTolerance, true);
});

test("Foundation: score below the 85 DeFi floor refrains from self-certifying", () => {
  // Guardrails failed: 0 + 30 + 30 = 60 < 85.
  const assessment = assessFoundation({
    guardrailsPassed: false,
    preState: seededSnapshot(),
    postState: seededSnapshot(),
  });
  assert.equal(assessment.score, 60);
  assert.equal(assessment.verdict, "REFRAIN");
});

test("Foundation: a value-creating post state is a golden parity MISMATCH", () => {
  const pre = seededSnapshot();
  const post = { ...pre, totalValueSui: pre.totalValueSui + 10 };
  const assessment = assessFoundation({ guardrailsPassed: true, preState: pre, postState: post });
  assert.equal(assessment.parity?.withinTolerance, false);
  assert.ok(assessment.findings.some((finding) => finding.includes("MISMATCH")));
});

test("Golden invariants pin value conservation and non-negative balances", () => {
  const invariants = defaultGoldenInvariants();
  assert.equal(invariants.length, 2);
  assert.equal(invariants[0].id, "value-conserved");
  assert.equal(invariants[1].id, "balances-non-negative");
});

// ── Human lock lifecycle ─────────────────────────────────────

test("Human lock: sessions start EXPLORING; confirmation requires PROVISIONAL_LOCK first", () => {
  const chpCase = openCase({ decisionId: "d-1", title: "buy SUI" });
  assert.equal(chpCase.status, "EXPLORING");

  assert.throws(
    () =>
      applyThirdPartyValidation(chpCase, {
        validator: "sam@cubiczan.com",
        item: "d-1",
        challenge: "confirm",
        result: "CONFIRM",
        rationale: "premature",
      }),
    /requires PROVISIONAL_LOCK/,
  );
  assert.equal(chpCase.status, "EXPLORING");
});

test("Human lock: named confirmer promotes PROVISIONAL_LOCK to LOCKED", () => {
  const chpCase = openCase({ decisionId: "d-2", title: "buy SUI" });
  assert.equal(markProvisionalLock(chpCase), "PROVISIONAL_LOCK");

  const status = applyThirdPartyValidation(chpCase, {
    validator: "sam@cubiczan.com",
    item: "d-2",
    challenge: "confirm the vault action is solvable and within policy",
    result: "CONFIRM",
    rationale: "reviewed",
  });
  assert.equal(status, "LOCKED");
  assert.equal(chpCase.status, "LOCKED");
  assert.deepEqual(chpCase.lockedDecisions, ["d-2"]);
});

test("Human lock: a rejected validation returns the case to EXPLORING", () => {
  const chpCase = openCase({ decisionId: "d-3", title: "sell SUI" });
  markProvisionalLock(chpCase);
  const status = applyThirdPartyValidation(chpCase, {
    validator: "sam@cubiczan.com",
    item: "d-3",
    challenge: "confirm",
    result: "REJECT",
    rationale: "not convinced",
  });
  assert.equal(status, "EXPLORING");
  assert.equal(chpCase.status, "EXPLORING");
  assert.equal(chpCase.flipCriteria.length, 1);
});

test("Human lock: env flag defaults ON and honors VAULTMIND_CHP_REQUIRE_HUMAN_LOCK=0", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(requireHumanLockEnabled(env), true);
  env[HUMAN_LOCK_ENV] = "0";
  assert.equal(requireHumanLockEnabled(env), false);
  env[HUMAN_LOCK_ENV] = "false";
  assert.equal(requireHumanLockEnabled(env), false);
  env[HUMAN_LOCK_ENV] = "1";
  assert.equal(requireHumanLockEnabled(env), true);
});

// ── Decision ledger (JSONL, tamper-evident) ──────────────────

test("Ledger: canonical JSON sorts keys recursively", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test("Ledger: payload envelope validates structure (markers + route/id match)", () => {
  const envelope = buildPayloadEnvelope(canonicalJson({ hello: "world" }));
  assert.equal(validatePayloadEnvelope(envelope), true);
  // Mismatched route between BEGIN and END markers is invalid.
  const mismatched = envelope.replace("END_PAYLOAD [VAULT_EXECUTE]", "END_PAYLOAD [OTHER]");
  assert.equal(validatePayloadEnvelope(mismatched), false);
  assert.equal(validatePayloadEnvelope(null), false);
});

function sealedFixture(decisionId: string) {
  return sealDecision({
    decision_id: decisionId,
    created_at: new Date().toISOString(),
    decision_kind: "vault_action",
    vault_id: "vault-1",
    action: "buy",
    asset: "SUI",
    notional_usd: 185,
    session_status: "LOCKED",
    r0_verdict: "PASS",
    foundation_verdict: "PASS",
    foundation_score: 100,
    adversary_findings: [],
    parity: null,
    confirmed_by: "sam@cubiczan.com",
  });
}

test("Ledger: sealed records round trip with integrity_valid true, newest first", () => {
  const ledger = tmpLedger();
  ledger.append(sealedFixture("d-1"));
  ledger.append(sealedFixture("d-2"));

  const records = ledger.list();
  assert.equal(records.length, 2);
  assert.equal(records[0].decision_id, "d-2");
  assert.equal(records[1].decision_id, "d-1");
  for (const record of records) {
    assert.equal(record.envelope_valid, true);
    assert.equal(record.integrity_valid, true);
  }
  assert.equal(ledger.get("d-1")?.decision_id, "d-1");
  assert.equal(ledger.get("missing"), null);
});

test("Ledger: tampering the sealed body is detected on read", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chp-test-")), "decisions.jsonl");
  const ledger = new DecisionLedger(path);
  const record = sealedFixture("d-1");
  ledger.append(record);

  // Flip a byte inside the sealed body (digest stays the original).
  const tamperedBody = record.body.replace('"notional_usd":185', '"notional_usd":999');
  assert.notEqual(tamperedBody, record.body);
  writeFileSync(path, JSON.stringify({ ...record, body: tamperedBody }) + "\n", "utf8");

  const reloaded = new DecisionLedger(path).list();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].integrity_valid, false);
});

test("Ledger: checkRecord exposes integrity for fresh records", () => {
  const checked = checkRecord(sealedFixture("d-9"));
  assert.equal(checked.envelope_valid, true);
  assert.equal(checked.integrity_valid, true);
});

// ── Profile B spend gate (@cubiczan/chp) ─────────────────────

test("Profile B: under-threshold action locks automatically with a content hash", () => {
  const gate = new ChpGate(tightPolicy());
  const decision = gate.evaluate({ action: "buy", asset: "SUI", notionalUsd: 400, confidence: 0.8, rationale: "test" });
  assert.equal(decision.state, "LOCKED");
  assert.equal(decision.allowed, true);
  assert.match(decision.provenance.contentHash, /^[a-f0-9]{64}$/);
});

test("Profile B: over-max notional blocks even with a confirmer available", () => {
  const gate = new ChpGate(tightPolicy());
  const decision = gate.evaluate({ action: "buy", asset: "SUI", notionalUsd: 5000, confidence: 0.9, rationale: "test" });
  assert.equal(decision.state, "BLOCKED");
  assert.equal(decision.allowed, false);
});

test("Profile B: HITL threshold requires human approval; approval promotes to LOCKED", () => {
  const gate = new ChpGate({ ...tightPolicy(), hitlThresholdUsd: 500 });
  const proposed = { action: "buy" as const, asset: "SUI", notionalUsd: 600, confidence: 0.8, rationale: "test" };
  const held = gate.evaluate(proposed);
  assert.equal(held.state, "HITL_REQUIRED");
  assert.equal(held.requiresHuman, true);
  assert.equal(held.allowed, false);

  const approved = gate.approveHuman(proposed, "sam@cubiczan.com");
  assert.equal(approved.state, "LOCKED");
  assert.equal(approved.allowed, true);
});

test("Profile B: daily notional cap blocks the run that would exceed it", () => {
  const gate = new ChpGate({ ...tightPolicy(), dailyNotionalCapUsd: 700 });
  assert.equal(gate.evaluate({ action: "buy", asset: "SUI", notionalUsd: 300, confidence: 0.8, rationale: "1" }).state, "LOCKED");
  assert.equal(gate.evaluate({ action: "buy", asset: "SUI", notionalUsd: 300, confidence: 0.8, rationale: "2" }).state, "LOCKED");
  const third = gate.evaluate({ action: "buy", asset: "SUI", notionalUsd: 300, confidence: 0.8, rationale: "3" });
  assert.equal(third.state, "BLOCKED");
});

// ── Hardened gate pipeline ordering ──────────────────────────

test("Hardened gate: spend policy block fires only after R0 passes", () => {
  // R0 passes (2,500 USD is solvable against 10,000 USDC cash), but the
  // tight spend policy caps notional at 1,000.
  const gate = new HardenedChpGate({
    spend: new ChpGate(tightPolicy()),
    ledger: tmpLedger(),
  });
  const outcome = gate.evaluateHardened(
    { action: "buy", asset: "SUI", notionalUsd: 2500, confidence: 0.9, rationale: "over cap", vaultId: "vault-1" },
    seededSnapshot(),
  );
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stage, "SPEND");
  assert.equal(outcome.state, "EXPLORING");
  assert.equal(outcome.r0?.verdict, "PASS");
  assert.equal(outcome.spend?.state, "BLOCKED");
});

test("Hardened gate: a golden parity mismatch is fatal — no confirmer can wave it through", () => {
  const gate = makeHardenedGate({ transition: valueCreatingTransition() });
  const outcome = gate.evaluateHardened(
    { action: "buy", asset: "SUI", notionalUsd: 185, confidence: 0.9, rationale: "parity check", vaultId: "vault-1" },
    seededSnapshot(),
    "sam@cubiczan.com",
  );
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stage, "FOUNDATION");
  assert.equal(outcome.state, "HALT");
  assert.match(outcome.reason, /parity/i);
});

test("Hardened gate: human lock holds every action without a named confirmer", () => {
  const gate = makeHardenedGate();
  const outcome = gate.evaluateHardened(
    { action: "buy", asset: "SUI", notionalUsd: 185, confidence: 0.9, rationale: "locked", vaultId: "vault-1" },
    seededSnapshot(),
  );
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stage, "LOCK");
  assert.equal(outcome.state, "PROVISIONAL_LOCK");
  assert.equal(outcome.chpCase?.status, "PROVISIONAL_LOCK");
  assert.equal(outcome.post !== undefined, true, "post state is computed but not applied");
});

test("Hardened gate: a named confirmer locks the case and seals a ledger record", () => {
  const ledger = tmpLedger();
  const gate = new HardenedChpGate({ spend: new ChpGate(), ledger });
  const outcome = gate.evaluateHardened(
    { action: "buy", asset: "SUI", notionalUsd: 185, confidence: 0.9, rationale: "confirmed", vaultId: "vault-1" },
    seededSnapshot(),
    "sam@cubiczan.com",
  );
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.state, "LOCKED");
  assert.equal(outcome.stage, "RECORD");
  assert.equal(outcome.chpCase?.status, "LOCKED");
  // Parity-verified post state: 185 USD of SUI bought at 1.85.
  const sui = outcome.post?.tokens.find((t) => t.symbol === "SUI");
  const usdc = outcome.post?.tokens.find((t) => t.symbol === "USDC");
  assert.equal(sui?.amount, 2100);
  assert.equal(usdc?.amount, 10000 - 185);

  const records = ledger.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision_id, outcome.record?.decision_id);
  assert.equal(records[0].integrity_valid, true);
  assert.equal(records[0].session_status, "LOCKED");
  assert.equal(records[0].confirmed_by, "sam@cubiczan.com");
  assert.equal(records[0].r0_verdict, "PASS");
  assert.equal(records[0].foundation_score, 100);
});

test("Hardened gate: with the human lock disabled an action self-certifies as PROVISIONAL_LOCK", () => {
  const gate = makeHardenedGate({ requireHumanLock: false });
  const outcome = gate.evaluateHardened(
    { action: "buy", asset: "SUI", notionalUsd: 185, confidence: 0.9, rationale: "autonomous", vaultId: "vault-1" },
    seededSnapshot(),
  );
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.state, "PROVISIONAL_LOCK");
  assert.equal(outcome.record?.session_status, "PROVISIONAL_LOCK");
  assert.equal(outcome.record?.confirmed_by, null);
});

// ── Deterministic transition + vault-loop integration ────────

test("Deterministic transition: value is conserved across a buy and a sell", () => {
  const value = (s: PositionSnapshot) =>
    s.tokens.reduce((sum, t) => sum + t.amount * DEMO_PRICES_USD[t.symbol], 0);
  const before = seededSnapshot();

  const bought = deterministicVaultTransition(before, { action: "buy", asset: "SUI", notionalUsd: 1000, confidence: 0.9, rationale: "x", vaultId: "v" });
  assert.ok(bought.ok, "buy transition should succeed");
  assert.ok(Math.abs(value(before) - value(bought.post)) < 1e-6);

  const sold = deterministicVaultTransition(before, { action: "sell", asset: "SUI", notionalUsd: 370, confidence: 0.9, rationale: "x", vaultId: "v" });
  assert.ok(sold.ok, "sell transition should succeed");
  assert.ok(Math.abs(value(before) - value(sold.post)) < 1e-6);
});

test("Deterministic transition: rebalance rotates into the target leg", () => {
  const before = seededSnapshot();
  const result = deterministicVaultTransition(before, { action: "rebalance", asset: "USDC", notionalUsd: 370, confidence: 0.9, rationale: "to stables", vaultId: "v" });
  assert.ok(result.ok, "rebalance transition should succeed");
  // Selling 370 USD of SUI (the source leg) into USDC.
  const sui = result.post.tokens.find((t) => t.symbol === "SUI");
  const usdc = result.post.tokens.find((t) => t.symbol === "USDC");
  assert.ok(Math.abs((sui?.amount ?? 0) - (2000 - 370 / DEMO_PRICES_USD.SUI)) < 1e-9);
  assert.ok(Math.abs((usdc?.amount ?? 0) - (10000 + 370)) < 1e-9);
});

test("Deterministic transition: an unknown rebalance target is refused", () => {
  const result = deterministicVaultTransition(seededSnapshot(), { action: "rebalance", asset: "DEEP", notionalUsd: 100, confidence: 0.9, rationale: "x", vaultId: "v" });
  assert.ok(!result.ok, "unknown rebalance target should be refused");
  assert.match(result.reason, /no usable price for asset DEEP/);
});

test("Agent loop: R0 refusal records a failed execution and applies nothing", () => {
  const ledger = tmpLedger();
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, ledger);
  const entry = engine.executeSignal(
    { action: "sell", token: "SUI", amount: 5000, confidence: 0.9, reasoning: "overdrawn" },
    "vault-1",
  );
  assert.equal(entry.result, "failure");
  assert.match(entry.details, /R0/);
  const sui = engine.getMemory().positionSnapshot?.tokens.find((t) => t.symbol === "SUI");
  assert.equal(sui?.amount, 2000);
  assert.equal(ledger.list().length, 0);
});

test("Agent loop: spend policy block is surfaced as a CHP gate failure", () => {
  const ledger = tmpLedger();
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, new ChpGate(tightPolicy()), ledger);
  const entry = engine.executeSignal(
    { action: "buy", token: "SUI", amount: 2500, confidence: 0.9, reasoning: "over max" },
    "vault-1",
  );
  assert.equal(entry.result, "failure");
  assert.match(entry.details, /CHP gate/);
  assert.match(entry.details, /SPEND/);
  assert.equal(ledger.list().length, 0);
});

test("Agent loop: confirmed action applies the parity-verified post state and seals a record", () => {
  const ledger = tmpLedger();
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, ledger);
  const entry = engine.executeSignal(
    { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "momentum entry" },
    "vault-1",
    "sam@cubiczan.com",
  );
  assert.equal(entry.result, "success");
  assert.ok(entry.chpDecisionId);

  const snapshot = engine.getMemory().positionSnapshot;
  const sui = snapshot?.tokens.find((t) => t.symbol === "SUI");
  const usdc = snapshot?.tokens.find((t) => t.symbol === "USDC");
  assert.equal(sui?.amount, 2100);
  assert.equal(usdc?.amount, 9815);

  const records = ledger.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision_id, entry.chpDecisionId);
  assert.equal(records[0].integrity_valid, true);
  assert.equal(records[0].state === undefined, true, "ledger stores field-style records");
  assert.equal(records[0].session_status, "LOCKED");
  // The Profile B spend gate also logged the decision.
  assert.equal(engine.getChpGate().getLedger().length, 1);
});

test("Agent loop: consequential action without a named confirmer is refused (default lock ON)", () => {
  const ledger = tmpLedger();
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, ledger);
  const entry = engine.executeSignal(
    { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "no human" },
    "vault-1",
  );
  assert.equal(entry.result, "failure");
  assert.match(entry.details, /human lock/i);
  assert.equal(ledger.list().length, 0);
});

test("Agent loop: human lock can be disabled via env for autonomous operation", () => {
  process.env[HUMAN_LOCK_ENV] = "0";
  try {
    const ledger = tmpLedger();
    const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, ledger);
    const entry = engine.executeSignal(
      { action: "buy", token: "SUI", amount: 185, confidence: 0.8, reasoning: "autonomous" },
      "vault-1",
    );
    assert.equal(entry.result, "success");
    const records = ledger.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].session_status, "PROVISIONAL_LOCK");
  } finally {
    delete process.env[HUMAN_LOCK_ENV];
  }
});

test("Agent loop: hold signals bypass the gate entirely", () => {
  const ledger = tmpLedger();
  const engine = new AgentEngine(DEMO_AGENTS[0], undefined, undefined, ledger);
  const entry = engine.executeSignal(
    { action: "hold", token: "SUI", amount: 0, confidence: 0.5, reasoning: "no signal" },
    "vault-1",
  );
  assert.equal(entry.result, "success");
  assert.equal(entry.chpDecisionId, undefined);
  assert.equal(engine.getChpGate().getLedger().length, 0);
  assert.equal(ledger.list().length, 0);
});

// ── Policy loading ───────────────────────────────────────────

test("Policy: missing file falls back to the conservative default", () => {
  const policy = defaultPolicy();
  assert.equal(policy.version, "1.0-default");
  assert.ok(policy.maxNotionalUsd > 0);
  assert.ok(policy.dailyNotionalCapUsd >= policy.maxNotionalUsd);
  assert.ok(policy.minConfidence > 0 && policy.minConfidence < 1);
});
