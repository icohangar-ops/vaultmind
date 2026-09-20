/**
 * VaultMind SDK — CHP R0 gate (consensus-hardening-protocol).
 *
 * Faithful port of `chp.gates.evaluate_r0_gate` (Profile A): a pre-execution
 * gate that asks "is this action solvable from the vault's current state?"
 * before any capital moves. Result keys are capitalized (Solvable / Scoped /
 * Valid / Worth_it) and every failure is FATAL — the verdict HALTs and the
 * action is refused with nothing executed or persisted.
 */

export type R0Result = "PASS" | "FATAL";

/** Capitalized keys mirror the normative CHP R0 vocabulary (§R0). */
export interface R0Results {
  Solvable: R0Result;
  Scoped: R0Result;
  Valid: R0Result;
  Worth_it: R0Result;
}

export interface R0Criteria {
  /** Executable from the vault's current state (holdings/cash cover it). */
  solvable: boolean;
  /** Bounded: finite, positive, evaluable notional. */
  scoped: boolean;
  /** Well-formed: known action vocabulary, well-formed asset symbol. */
  valid: boolean;
  /** A stated, non-trivial rationale and confidence exist for acting. */
  worthIt: boolean;
}

export type R0Verdict = "PASS" | "HALT";

export interface R0GateEvaluation {
  verdict: R0Verdict;
  results: R0Results;
  /** Names of the failed criteria (sorted), for refusal messages. */
  failures: string[];
}

export class R0Evaluator {
  evaluate(criteria: R0Criteria): R0GateEvaluation {
    const results: R0Results = {
      Solvable: criteria.solvable ? "PASS" : "FATAL",
      Scoped: criteria.scoped ? "PASS" : "FATAL",
      Valid: criteria.valid ? "PASS" : "FATAL",
      Worth_it: criteria.worthIt ? "PASS" : "FATAL",
    };
    const failures = (Object.keys(results) as (keyof R0Results)[])
      .filter((key) => results[key] !== "PASS")
      .sort();
    return {
      verdict: failures.length === 0 ? "PASS" : "HALT",
      results,
      failures,
    };
  }
}
