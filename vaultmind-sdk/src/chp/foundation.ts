/**
 * VaultMind SDK — CHP deterministic adversary foundation pass.
 *
 * Port of the erp-control-plane `ChpPromotionGate.assess_foundation`:
 * a deterministic adversary scores the foundation of a vault action out of
 * 100 — 40 for guardrails (the Profile B policy gate passed), 30 for a
 * bounded result (a simulated post-action vault state exists and is finite),
 * and 30 for golden parity. The blockchain/DeFi domain gates at 85, so
 * guardrails + bounded result alone (70) can never self-certify: either the
 * pinned parity evidence passes or a named human confirmer is required.
 * A parity MISMATCH is fatal — an action contradicting pinned vault truth
 * must not execute, and no confirmer can wave it through.
 *
 * Parity design (documented divergence from the ERP reference): there the
 * executed answer is compared against a dbt-pinned scalar in golden_qa.yaml.
 * A vault action has no single comparable scalar — its notional is chosen at
 * runtime — so golden parity here is parity vs the *vault state*: the
 * simulated post-action snapshot is checked against the pinned invariant
 * case set (value conservation, non-negative balances). Where the state
 * assertions cannot run (no pre/post snapshot), parity evidence is
 * unavailable and the action cannot self-certify, mirroring the reference's
 * "no golden-set case matches" path.
 */

import type { PositionSnapshot } from "../walrus";

export const GUARDRAIL_POINTS = 40;
export const BOUNDED_RESULT_POINTS = 30;
export const PARITY_POINTS = 30;
export const FULL_SCORE = GUARDRAIL_POINTS + BOUNDED_RESULT_POINTS + PARITY_POINTS;

/** Governance floor for the blockchain/DeFi domain (spec: 85). */
export const DEFI_FLOOR = 85;

export type FoundationVerdict = "PASS" | "REFRAIN";

/** One pinned vault-state invariant case (the golden-set analogue). */
export interface GoldenInvariant {
  id: string;
  metric: string;
  unit: string;
  /** Pinned expected value for this metric. */
  expected: number;
  /** Absolute tolerance around the expected value. */
  tolerance: number;
  /**
   * How `actual` is compared to `expected`:
   *   abs — |actual − expected| ≤ tolerance (two-sided parity)
   *   gte — actual ≥ expected − tolerance (one-sided floor, e.g. ≥ 0)
   */
  mode: "abs" | "gte";
  /** Pure assertion over the pre/post vault state (deterministic). */
  evaluate(
    pre: PositionSnapshot,
    post: PositionSnapshot,
  ): { actual: number | null; detail: string };
}

/** Evidence that a post-action state did or did not match a pinned case. */
export interface ParityEvidence {
  invariantId: string;
  metric: string;
  unit: string;
  expected: number;
  tolerance: number;
  actual: number | null;
  withinTolerance: boolean | null;
}

export interface FoundationAssessment {
  score: number;
  domain: "defi";
  verdict: FoundationVerdict;
  findings: string[];
  /** Evidence for the decisive parity case, when one was evaluated. */
  parity: ParityEvidence | null;
  /** Full evidence trail for every invariant that was evaluated. */
  invariantEvidence: ParityEvidence[];
  /** Whether the pinned invariant set was applicable to this state pair. */
  goldenMatched: boolean;
}

/**
 * The pinned vault-state invariant set (the golden set). A trade must not
 * create or destroy value and must never drive a balance negative; these are
 * the vault-world equivalents of a dbt-pinned KPI.
 */
export function defaultGoldenInvariants(): GoldenInvariant[] {
  return [
    {
      id: "value-conserved",
      metric: "total_value_delta_sui",
      unit: "sui",
      expected: 0,
      tolerance: 1e-6,
      mode: "abs",
      evaluate: (pre, post) => {
        const delta = post.totalValueSui - pre.totalValueSui;
        return { actual: delta, detail: `total value delta ${delta} sui` };
      },
    },
    {
      id: "balances-non-negative",
      metric: "min_token_amount",
      unit: "tokens",
      expected: 0,
      tolerance: 0,
      mode: "gte",
      evaluate: (_pre, post) => {
        const amounts = post.tokens.map((t) => t.amount);
        const min = amounts.length > 0 ? Math.min(...amounts) : null;
        return { actual: min, detail: `minimum post-action token amount ${min}` };
      },
    },
  ];
}

function evidenceFor(invariant: GoldenInvariant, actual: number | null): ParityEvidence {
  const withinTolerance =
    actual === null
      ? null
      : invariant.mode === "abs"
        ? Math.abs(actual - invariant.expected) <= invariant.tolerance
        : actual >= invariant.expected - invariant.tolerance;
  return {
    invariantId: invariant.id,
    metric: invariant.metric,
    unit: invariant.unit,
    expected: invariant.expected,
    tolerance: invariant.tolerance,
    actual,
    withinTolerance,
  };
}

function isFiniteSnapshot(snapshot: PositionSnapshot): boolean {
  return (
    Number.isFinite(snapshot.totalValueSui) &&
    snapshot.tokens.length > 0 &&
    snapshot.tokens.every(
      (t) =>
        Number.isFinite(t.amount) &&
        Number.isFinite(t.valueSui) &&
        t.symbol.trim() !== "",
    )
  );
}

export function assessFoundation(input: {
  guardrailsPassed: boolean;
  preState: PositionSnapshot | null;
  postState: PositionSnapshot | null;
  goldenInvariants?: GoldenInvariant[];
}): FoundationAssessment {
  const { guardrailsPassed, preState, postState } = input;
  const invariants = input.goldenInvariants ?? defaultGoldenInvariants();
  const findings: string[] = [];
  const evidence: ParityEvidence[] = [];
  let score = 0;

  if (guardrailsPassed) {
    score += GUARDRAIL_POINTS;
    findings.push(
      "guardrails passed: policy-capped notional, allowed action, bounded daily exposure",
    );
  } else {
    findings.push("guardrails did not pass — no foundation to score");
  }

  if (postState !== null && isFiniteSnapshot(postState)) {
    score += BOUNDED_RESULT_POINTS;
    findings.push(
      `bounded result: simulated post-action state holds ${postState.tokens.length} token position(s), total ${postState.totalValueSui} sui`,
    );
  } else {
    findings.push(
      "no bounded post-action state — the action has no evaluable result evidence",
    );
  }

  // Golden parity vs vault state — feasible only when both snapshots exist.
  const comparable = preState !== null && postState !== null;
  let mismatch: ParityEvidence | null = null;
  let firstPass: ParityEvidence | null = null;
  if (!comparable) {
    findings.push(
      "vault state pair unavailable — golden parity evidence cannot be evaluated",
    );
  } else {
    for (const invariant of invariants) {
      const { actual, detail } = invariant.evaluate(preState, postState);
      const ev = evidenceFor(invariant, actual);
      evidence.push(ev);
      if (ev.withinTolerance === false && mismatch === null) {
        mismatch = ev;
        findings.push(
          `golden parity MISMATCH: ${ev.invariantId} (${ev.metric}) expected ${ev.expected} ± ${ev.tolerance} ${ev.unit}, got ${ev.actual} — ${detail}`,
        );
      } else if (ev.withinTolerance === true) {
        findings.push(`golden parity: ${ev.invariantId} (${ev.metric}) holds — ${detail}`);
      } else {
        findings.push(
          `golden case matched but the metric is not comparable — parity evidence unavailable for ${ev.invariantId}`,
        );
      }
    }
    if (mismatch === null) firstPass = evidence[0] ?? null;
  }

  // Golden parity points are awarded when the pinned invariant set was
  // applicable and at least one invariant verifiably holds — the vault-world
  // equivalent of matching the dbt-pinned scalar.
  if (
    preState !== null &&
    postState !== null &&
    mismatch === null &&
    evidence.some((ev) => ev.withinTolerance === true)
  ) {
    score += PARITY_POINTS;
    findings.push("golden parity points awarded: pinned vault-state invariants hold");
  }

  const scoreCapped = Math.min(score, FULL_SCORE);
  return {
    score: scoreCapped,
    domain: "defi",
    verdict: scoreCapped >= DEFI_FLOOR ? "PASS" : "REFRAIN",
    findings,
    // A mismatch is the decisive evidence; otherwise the first parity pass.
    parity: mismatch ?? firstPass,
    invariantEvidence: evidence,
    goldenMatched: comparable && invariants.length > 0,
  };
}
