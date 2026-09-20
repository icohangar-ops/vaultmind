/**
 * VaultMind SDK — CHP Decision Gate (Profile B, spend/HITL)
 *
 * The spend/HITL layer of the vault decision gate, evaluated by the published
 * `@cubiczan/chp` package (spec §6.3/§6.5 — the same library chp-examples'
 * clearance-gate consumes):
 *   - loads a risk policy (config/policy.yaml, conservative default fallback)
 *   - drives a proposed action through decision states
 *       LOCKED / HITL_REQUIRED / BLOCKED
 *   - collects hard violations first (allowed action, per-asset + max
 *     notional, daily cap, min confidence), then applies the inclusive HITL
 *     threshold test
 *   - records per-decision provenance (an append-only in-memory ledger with
 *     the package's canonical content hash)
 *
 * Capital-moving signals must pass gate.evaluate(action) before execution.
 * The hardened Profile A pipeline (R0 solvability → foundation → human lock →
 * JSONL decision ledger) lives in ./hardened-gate.
 */

import { randomUUID } from "node:crypto";
import {
  approveHuman as chpApproveHuman,
  evaluateGate as chpEvaluateGate,
  type GatePolicy,
  type GateResult,
} from "@cubiczan/chp";
import { loadPolicy, defaultPolicyPath, type RiskPolicy, type ChpAction } from "./policy";

export type { ChpAction, RiskPolicy } from "./policy";

/** Lifecycle states the Profile B gate emits for a proposed action. */
export type ChpState = "LOCKED" | "HITL_REQUIRED" | "BLOCKED";

/** A capital-moving action proposed to the gate. */
export interface ProposedAction {
  /** Vault action (buy / sell / rebalance). */
  action: ChpAction;
  /** Token symbol the action targets (per-token caps + provenance). */
  asset: string;
  /** Notional value of the action (USD-equivalent). */
  notionalUsd: number;
  /** Signal confidence 0..1 (adversarial input). */
  confidence?: number;
  /** Free-form rationale carried into provenance. */
  rationale?: string;
}

export interface Provenance {
  decisionId: string;
  timestamp: string;
  action: ProposedAction;
  state: ChpState;
  contentHash: string;
  claims: { rule: string; passed: boolean; detail: string }[];
}

export interface ChpDecision {
  allowed: boolean;
  requiresHuman: boolean;
  state: ChpState;
  reason: string;
  provenance: Provenance;
}

function toGatePolicy(policy: RiskPolicy): GatePolicy {
  return {
    version: policy.version,
    max_notional: policy.maxNotionalUsd,
    daily_cap: policy.dailyNotionalCapUsd,
    hitl_threshold: policy.hitlThresholdUsd,
    min_confidence: policy.minConfidence,
    allowed_actions: policy.allowedActions,
    per_asset_limits: policy.perAssetLimits,
  };
}

export class ChpGate {
  private policy: RiskPolicy;
  private ledger: Provenance[] = [];
  private dailyNotionalUsd = 0;
  private dailyWindowStart = Date.now();

  constructor(policy?: RiskPolicy, policyPath: string = defaultPolicyPath()) {
    this.policy = policy ?? loadPolicy(policyPath);
  }

  getPolicy(): RiskPolicy {
    return this.policy;
  }

  /** Append-only provenance ledger (per-decision records). */
  getLedger(): readonly Provenance[] {
    return this.ledger;
  }

  /**
   * Evaluate a proposed capital-moving action through the @cubiczan/chp
   * Profile B gate (spec §6.3).
   *
   *   - any hard violation          => BLOCKED        (allowed=false)
   *   - notional >= hitl threshold  => HITL_REQUIRED  (allowed=false, requiresHuman)
   *   - otherwise                   => LOCKED         (allowed=true)
   */
  evaluate(proposed: ProposedAction): ChpDecision {
    this.rollDailyWindow();
    const result = chpEvaluateGate(
      {
        action: proposed.action,
        asset: proposed.asset,
        notional: proposed.notionalUsd,
        confidence: proposed.confidence ?? null,
        rationale: proposed.rationale,
      },
      toGatePolicy(this.policy),
      this.dailyNotionalUsd,
    );
    if (result.allowed) {
      this.dailyNotionalUsd += result.committed_delta;
    }
    return this.finalize(proposed, result);
  }

  /**
   * Register an explicit human approval for a HITL-gated action, promoting it
   * to LOCKED. Re-runs the full evaluation — approval may cross the HITL
   * threshold, never the hard rules (spec §6.5).
   */
  approveHuman(proposed: ProposedAction, approver: string): ChpDecision {
    this.rollDailyWindow();
    const result = chpApproveHuman(
      {
        action: proposed.action,
        asset: proposed.asset,
        notional: proposed.notionalUsd,
        confidence: proposed.confidence ?? null,
        rationale: proposed.rationale,
      },
      toGatePolicy(this.policy),
      approver,
      this.dailyNotionalUsd,
    );
    if (result.allowed) {
      this.dailyNotionalUsd += result.committed_delta;
    }
    return this.finalize(proposed, result);
  }

  // ── Internals ──────────────────────────────────────────────

  private rollDailyWindow(): void {
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - this.dailyWindowStart >= DAY_MS) {
      this.dailyWindowStart = Date.now();
      this.dailyNotionalUsd = 0;
    }
  }

  private finalize(action: ProposedAction, result: GateResult): ChpDecision {
    const provenance: Provenance = {
      decisionId: randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      state: result.state,
      contentHash: result.content_hash,
      claims: result.claims,
    };
    this.ledger.push(provenance);
    return {
      allowed: result.allowed,
      requiresHuman: result.requires_human,
      state: result.state,
      reason: result.reason,
      provenance,
    };
  }
}
