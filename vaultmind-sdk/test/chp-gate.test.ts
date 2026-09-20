/**
 * Tests for the CHP decision gate (src/chp/gate.ts)
 *
 * Proves: under-threshold signals LOCK and are allowed; at/over the HITL
 * threshold they require human approval; over the hard / per-token / daily
 * caps they are BLOCKED. Also covers the AgentEngine.executeSignal wiring.
 *
 * Run with: npm test  (Node's native TypeScript support, no build step).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChpGate } from "../src/chp/gate";
import type { RiskPolicy } from "../src/chp/policy";
import { AgentEngine } from "../src/agent-engine";
import type { AgentConfig, AgentSignal } from "../src/agent-engine";

function makePolicy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    version: "test",
    maxNotionalUsd: 10000,
    dailyNotionalCapUsd: 50000,
    hitlThresholdUsd: 3000,
    allowedActions: ["buy", "sell", "rebalance"],
    perAssetLimits: { SUI: 8000 },
    minConfidence: 0.55,
    ...overrides,
  };
}

test("under-threshold signal is LOCKED and allowed", () => {
  const gate = new ChpGate(makePolicy());
  const d = gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 1000, confidence: 0.8 });
  assert.equal(d.allowed, true);
  assert.equal(d.requiresHuman, false);
  assert.equal(d.state, "LOCKED");
});

test("signal at/over the HITL threshold requires human approval", () => {
  const gate = new ChpGate(makePolicy({ hitlThresholdUsd: 3000 }));
  const d = gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 5000, confidence: 0.8 });
  assert.equal(d.allowed, false);
  assert.equal(d.requiresHuman, true);
  assert.equal(d.state, "HITL_REQUIRED");
});

test("signal over the hard max notional is BLOCKED", () => {
  const gate = new ChpGate(makePolicy({ maxNotionalUsd: 10000 }));
  const d = gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 12000, confidence: 0.9 });
  assert.equal(d.allowed, false);
  assert.equal(d.state, "BLOCKED");
});

test("per-token cap blocks even an under-max signal", () => {
  const gate = new ChpGate(makePolicy());
  const d = gate.evaluate({ action: "buy", asset: "SUI", notionalUsd: 9000, confidence: 0.9 });
  assert.equal(d.allowed, false);
  assert.ok(d.provenance.claims.some((c) => c.rule === "per-asset-cap" && !c.passed));
});

test("low-confidence signal fails the adversarial check", () => {
  const gate = new ChpGate(makePolicy({ minConfidence: 0.6 }));
  const d = gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 100, confidence: 0.2 });
  assert.equal(d.allowed, false);
  assert.ok(d.provenance.claims.some((c) => c.rule === "min-confidence" && !c.passed));
});

test("daily cap blocks once cumulative notional is exceeded", () => {
  const gate = new ChpGate(makePolicy({ dailyNotionalCapUsd: 2000, hitlThresholdUsd: 100000 }));
  assert.equal(gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 800, confidence: 0.9 }).allowed, true);
  assert.equal(gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 800, confidence: 0.9 }).allowed, true);
  const third = gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 800, confidence: 0.9 });
  assert.equal(third.allowed, false);
  assert.equal(third.state, "BLOCKED");
});

test("human approval promotes a HITL signal to LOCKED", () => {
  const gate = new ChpGate(makePolicy());
  const first = gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 5000, confidence: 0.9 });
  assert.equal(first.requiresHuman, true);
  const approved = gate.approveHuman({ action: "buy", asset: "USDC", notionalUsd: 5000, confidence: 0.9 }, "ops@cubiczan");
  assert.equal(approved.allowed, true);
  assert.equal(approved.state, "LOCKED");
});

test("provenance ledger records a content hash per decision", () => {
  const gate = new ChpGate(makePolicy());
  gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 1000, confidence: 0.8 });
  gate.evaluate({ action: "buy", asset: "USDC", notionalUsd: 99999, confidence: 0.8 });
  const ledger = gate.getLedger();
  assert.equal(ledger.length, 2);
  for (const e of ledger) {
    assert.ok(e.decisionId.length > 0);
    assert.match(e.contentHash, /^[a-f0-9]{64}$/);
  }
});

// ─── AgentEngine wiring ─────────────────────────────────────

function makeAgentConfig(): AgentConfig {
  return {
    agentId: "agent-test-01",
    name: "Test Agent",
    strategyType: "momentum",
    riskTolerance: 5,
    maxPositions: 3,
    rebalanceIntervalMs: 60000,
  };
}

test("executeSignal blocks an over-max signal and records a failure", () => {
  const gate = new ChpGate(makePolicy({ maxNotionalUsd: 1000, perAssetLimits: {} }));
  const engine = new AgentEngine(makeAgentConfig(), undefined, gate);
  const signal: AgentSignal = { action: "buy", token: "SUI", amount: 5000, confidence: 0.9, reasoning: "oversized" };
  const entry = engine.executeSignal(signal, "vault-1");
  assert.equal(entry.result, "failure");
  assert.match(entry.details, /CHP gate/);
});

test("executeSignal lets an under-threshold signal through the gate", () => {
  const gate = new ChpGate(makePolicy({ maxNotionalUsd: 100000, hitlThresholdUsd: 100000, perAssetLimits: {} }));
  const engine = new AgentEngine(makeAgentConfig(), undefined, gate);
  const signal: AgentSignal = { action: "buy", token: "SUI", amount: 100, confidence: 0.9, reasoning: "small buy" };
  // The hardened pipeline requires a named human confirmer for any
  // capital-moving action (VAULTMIND_CHP_REQUIRE_HUMAN_LOCK defaults on).
  const entry = engine.executeSignal(signal, "vault-1", "ops@cubiczan");
  // Details should be the reasoning, not a CHP rejection.
  assert.doesNotMatch(entry.details, /CHP gate/);
  assert.ok(engine.getChpGate().getLedger().some((e) => e.state === "LOCKED"));
});

test("a hold signal bypasses the gate entirely", () => {
  const gate = new ChpGate(makePolicy());
  const engine = new AgentEngine(makeAgentConfig(), undefined, gate);
  const entry = engine.executeSignal({ action: "hold", token: "SUI", amount: 0, confidence: 0.5, reasoning: "no signal" }, "vault-1");
  assert.doesNotMatch(entry.details, /CHP gate/);
  assert.equal(engine.getChpGate().getLedger().length, 0);
});
