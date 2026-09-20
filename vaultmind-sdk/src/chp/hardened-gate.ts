/**
 * VaultMind SDK — hardened CHP gate (gate-only Profile A port).
 *
 * Port of the erp-control-plane `ChpPromotionGate` pipeline onto the vault
 * loop. Every consequential vault action (allocate / rebalance / sell) runs:
 *
 *   1. R0 gate — before the engine: is the action solvable from the vault's
 *      current state (holdings/cash cover it), scoped (finite positive
 *      notional), valid (known vocabulary + well-formed, priced asset), and
 *      worth it (stated rationale + confidence)? HALT is fatal: nothing is
 *      executed or persisted.
 *   2. Profile B spend gate (the existing ChpGate, backed by @cubiczan/chp):
 *      policy caps, HITL threshold, adversarial sanity claims.
 *   3. Deterministic adversary foundation pass: the action's post-state is
 *      simulated from the current vault state and scored 40 + 30 + 30 against
 *      the pinned invariant set; the DeFi floor is 85; a parity mismatch is
 *      fatal.
 *   4. Human lock: the hardened case opens PROVISIONAL_LOCK; a named
 *      confirmer (`confirmed_by`) applies third-party validation and locks
 *      it. `VAULTMIND_CHP_REQUIRE_HUMAN_LOCK` (default ON) makes the
 *      confirmer mandatory for every action.
 *   5. Decision record: the case, verdicts, parity evidence, and applied
 *      state are sealed and appended to the decision ledger. Refusals before
 *      the case opens (R0 HALT, spend BLOCKED/HITL, parity mismatch) are
 *      surfaced through the vault's execution log, mirroring the reference's
 *      audit-vs-ledger split.
 */

import { randomUUID } from "node:crypto";
import type { ChpGate, ChpDecision, ProposedAction } from "./gate";
import { assessFoundation, DEFI_FLOOR, type FoundationAssessment } from "./foundation";
import { R0Evaluator, type R0GateEvaluation } from "./r0";
import {
  applyThirdPartyValidation,
  markProvisionalLock,
  openCase,
  requireHumanLockEnabled,
  type HardenedCase,
  type SessionStatus,
} from "./session";
import { sealDecision, checkRecord } from "./ledger";
import type { DecisionLedger, CheckedRecord } from "./ledger";
import type { PositionSnapshot } from "../walrus";

/** Stages, for provenance in refusals surfaced via the execution log. */
export type HardenedStage = "R0" | "SPEND" | "FOUNDATION" | "LOCK" | "RECORD";

export interface HardenedOutcome {
  allowed: boolean;
  state: SessionStatus;
  reason: string;
  stage: HardenedStage;
  r0?: R0GateEvaluation;
  spend?: ChpDecision;
  assessment?: FoundationAssessment;
  chpCase?: HardenedCase;
  record?: CheckedRecord;
  /** The parity-verified post-action state to apply on execution. */
  post?: PositionSnapshot;
}

/**
 * Deterministically simulates the post-action vault state from the pre-state.
 * `ok: false` means the action is NOT solvable from the current state (R0
 * Solvable fails): insufficient cash/holdings, an unknown asset price, or a
 * malformed position snapshot.
 */
export type VaultTransition = (
  pre: PositionSnapshot,
  proposed: ProposedAction,
) => { ok: true; post: PositionSnapshot } | { ok: false; reason: string };

/** Demo-grade price feed, consistent with the demo snapshot math (1 SUI = 1.85 USD). */
export const DEMO_PRICES_USD: Record<string, number> = { SUI: 1.85, USDC: 1 };

function rebuildSnapshot(
  amounts: Map<string, number>,
  prices: Record<string, number>,
): PositionSnapshot {
  const tokens = [...amounts.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([symbol, amount]) => ({
      symbol,
      amount,
      valueSui: amount * (prices[symbol] ?? 0) / DEMO_PRICES_USD.SUI,
    }));
  const totalValueSui = tokens.reduce((sum, t) => sum + t.valueSui, 0);
  return { tokens, totalValueSui: Math.round(totalValueSui * 1e9) / 1e9, unrealizedPnlBps: 0 };
}

function shift(
  pre: PositionSnapshot,
  proposed: ProposedAction,
  prices: Record<string, number>,
): { ok: true; post: PositionSnapshot } | { ok: false; reason: string } {
  const price = prices[proposed.asset];
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: `no usable price for asset ${proposed.asset}` };
  }
  // Buying or selling the cash asset itself would double-write the USDC leg
  // (target credit + cash debit land on the same token) and destroy value on
  // paper. Rotating into/out of USDC is what rebalance is for.
  if (proposed.action !== "rebalance" && proposed.asset === "USDC") {
    return {
      ok: false,
      reason: "cannot buy or sell the cash asset itself in this two-leg universe — use rebalance to rotate into USDC",
    };
  }
  const amounts = new Map<string, number>(
    pre.tokens.map((t): [string, number] => [t.symbol, t.amount]),
  );
  const cash = amounts.get("USDC") ?? 0;
  const held = amounts.get(proposed.asset) ?? 0;
  const notional = proposed.notionalUsd;

  if (proposed.action === "buy") {
    if (cash < notional) {
      return { ok: false, reason: `cash ${cash} cannot cover notional ${notional}` };
    }
    amounts.set("USDC", cash - notional);
    amounts.set(proposed.asset, held + notional / price);
  } else if (proposed.action === "sell") {
    const sellAmount = notional / price;
    if (held < sellAmount) {
      return { ok: false, reason: `holding ${held} ${proposed.asset} cannot sell ${sellAmount}` };
    }
    amounts.set(proposed.asset, held - sellAmount);
    amounts.set("USDC", cash + notional);
  } else {
    // rebalance: rotate INTO the target token from the other leg of the
    // SUI/USDC pair (the demo vault's two-leg universe).
    if (proposed.asset !== "SUI" && proposed.asset !== "USDC") {
      return { ok: false, reason: `rebalance target ${proposed.asset} is outside the SUI/USDC pair` };
    }
    const source = proposed.asset === "SUI" ? "USDC" : "SUI";
    const sourcePrice = prices[source];
    if (sourcePrice === undefined || sourcePrice <= 0) {
      return { ok: false, reason: `no usable price for asset ${source}` };
    }
    const sourceHeld = amounts.get(source) ?? 0;
    if (sourceHeld < notional / sourcePrice) {
      return { ok: false, reason: `holding ${sourceHeld} ${source} cannot rebalance ${notional}` };
    }
    amounts.set(source, sourceHeld - notional / sourcePrice);
    amounts.set(proposed.asset, (amounts.get(proposed.asset) ?? 0) + notional / price);
  }
  return { ok: true, post: rebuildSnapshot(amounts, prices) };
}

/** Deterministic demo-grade transition over the vault's token balances. */
export function deterministicVaultTransition(
  pre: PositionSnapshot,
  proposed: ProposedAction,
  prices: Record<string, number> = DEMO_PRICES_USD,
): ReturnType<VaultTransition> {
  if (pre.tokens.some((t) => !Number.isFinite(t.amount))) {
    return { ok: false, reason: "vault state has non-finite balances" };
  }
  return shift(pre, proposed, prices);
}

export interface HardenedGateOptions {
  /** The Profile B spend/HITL gate (backed by @cubiczan/chp). */
  spend: ChpGate;
  /** Append-only decision ledger (JSONL, tamper-checked on read). */
  ledger: DecisionLedger;
  /** Default: VAULTMIND_CHP_REQUIRE_HUMAN_LOCK, default ON. */
  requireHumanLock?: boolean;
  /** Foundation floor; default DEFI_FLOOR (85). */
  floor?: number;
  /** Post-state simulator; default deterministicVaultTransition. */
  transition?: VaultTransition;
}

export class HardenedChpGate {
  private readonly spend: ChpGate;
  private readonly ledger: DecisionLedger;
  private readonly floor: number;
  private readonly requireHumanLock: boolean;
  private readonly transition: VaultTransition;
  private readonly r0 = new R0Evaluator();

  constructor(options: HardenedGateOptions) {
    this.spend = options.spend;
    this.ledger = options.ledger;
    this.floor = options.floor ?? DEFI_FLOOR;
    this.requireHumanLock = options.requireHumanLock ?? requireHumanLockEnabled();
    this.transition = options.transition ?? deterministicVaultTransition;
  }

  getDecisionLedger(): DecisionLedger {
    return this.ledger;
  }

  /**
   * Run a proposed vault action through R0 → spend → foundation → lock →
   * record. Returns the outcome; when `allowed`, the caller may apply
   * `post` to the vault state.
   */
  evaluateHardened(
    proposed: ProposedAction & { vaultId?: string },
    preState: PositionSnapshot | null,
    confirmedBy?: string,
  ): HardenedOutcome {
    // ── 1. R0 — before the engine ──────────────────────────────
    const transitioned =
      preState === null
        ? ({ ok: false, reason: "vault has no position state to act from" } as const)
        : this.transition(preState, proposed);
    const solvable = transitioned.ok;
    const scoped =
      Number.isFinite(proposed.notionalUsd) && proposed.notionalUsd > 0;
    const valid =
      /^[A-Z0-9_]{1,24}$/.test(proposed.asset) &&
      (proposed.action === "buy" ||
        proposed.action === "sell" ||
        proposed.action === "rebalance");
    const worthIt =
      proposed.rationale !== undefined &&
      proposed.rationale.trim().length >= 4 &&
      proposed.confidence !== undefined &&
      Number.isFinite(proposed.confidence);

    const r0 = this.r0.evaluate({ solvable, scoped, valid, worthIt });
    if (r0.verdict === "HALT") {
      return {
        allowed: false,
        state: "HALT",
        stage: "R0",
        reason: `CHP R0 gate: the vault action failed ${r0.failures.join(", ")}`,
        r0,
      };
    }
    const post = transitioned.ok ? transitioned.post : undefined;

    // ── 2. Profile B spend gate ────────────────────────────────
    const spend = this.spend.evaluate(proposed);
    if (!spend.allowed) {
      return {
        allowed: false,
        state: "EXPLORING",
        stage: "SPEND",
        reason: spend.reason,
        r0,
        spend,
      };
    }

    // ── 3. Deterministic adversary foundation pass ─────────────
    const assessment = assessFoundation({
      guardrailsPassed: true,
      preState,
      postState: post ?? null,
    });
    if (assessment.parity !== null && assessment.parity.withinTolerance === false) {
      return {
        allowed: false,
        state: "HALT",
        stage: "FOUNDATION",
        reason: `CHP foundation: ${assessment.findings[assessment.findings.length - 1]} — an action contradicting the vault's pinned state must not execute.`,
        r0,
        spend,
        assessment,
      };
    }

    // ── 4. Human lock ──────────────────────────────────────────
    const chpCase = openCase({
      decisionId: `vault-${randomUUID()}`,
      title: `${proposed.action} ${proposed.asset} (${proposed.notionalUsd} USD)`,
      owner: proposed.vaultId ?? "vaultmind-agent",
    });
    chpCase.foundationScore = assessment.score;
    markProvisionalLock(chpCase);

    const provisional: HardenedOutcome = {
      allowed: false,
      state: "PROVISIONAL_LOCK",
      stage: "LOCK",
      reason: "provisional lock — pending third-party validation",
      r0,
      spend,
      assessment,
      chpCase,
      post,
    };
    if (this.requireHumanLock && !confirmedBy) {
      return {
        ...provisional,
        reason:
          "CHP human lock: VAULTMIND_CHP_REQUIRE_HUMAN_LOCK is on — every consequential vault action needs a named confirmer (confirmed_by).",
      };
    }
    if (assessment.verdict !== "PASS" && !confirmedBy) {
      return {
        ...provisional,
        reason: `CHP foundation: REFRAIN (score ${assessment.score}, ${assessment.domain} domain) — the action cannot self-certify; retry with a named confirmer (confirmed_by).`,
      };
    }

    let state: SessionStatus = "PROVISIONAL_LOCK";
    if (confirmedBy) {
      state = applyThirdPartyValidation(chpCase, {
        validator: confirmedBy,
        item: chpCase.decisionId,
        challenge: "Confirm the vault action is solvable from the vault's state and within policy",
        result: "CONFIRM",
        rationale: "Named confirmer approved the vault action via the VaultMind SDK",
      });
    }

    // ── 5. Decision record ─────────────────────────────────────
    const record = sealDecision({
      decision_id: chpCase.decisionId,
      created_at: chpCase.createdAt,
      decision_kind: "vault_action",
      vault_id: proposed.vaultId ?? "vaultmind-agent",
      action: proposed.action,
      asset: proposed.asset,
      notional_usd: proposed.notionalUsd,
      session_status: state,
      r0_verdict: r0.verdict,
      foundation_verdict: assessment.verdict,
      foundation_score: assessment.score,
      adversary_findings: assessment.findings,
      parity: assessment.parity
        ? {
            invariantId: assessment.parity.invariantId,
            metric: assessment.parity.metric,
            unit: assessment.parity.unit,
            expected: assessment.parity.expected,
            tolerance: assessment.parity.tolerance,
            actual: assessment.parity.actual,
            withinTolerance: assessment.parity.withinTolerance,
          }
        : null,
      confirmed_by: confirmedBy ?? null,
    });
    this.ledger.append(record);

    return {
      allowed: true,
      state,
      stage: "RECORD",
      reason:
        state === "LOCKED"
          ? `locked by ${confirmedBy}`
          : "self-certified under CHP thresholds (provisional)",
      r0,
      spend,
      assessment,
      chpCase,
      post,
      record: checkRecord(record),
    };
  }
}
