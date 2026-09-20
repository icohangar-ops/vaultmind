/**
 * VaultMind SDK — CHP human-lock session lifecycle.
 *
 * Port of the normative chp.models vocabulary the gate uses: sessions start
 * EXPLORING, a hardened case opens PROVISIONAL_LOCK, and a named confirmer
 * promotes it to LOCKED via third-party validation (a REJECT returns the
 * case to EXPLORING). `VAULTMIND_CHP_REQUIRE_HUMAN_LOCK` makes the named
 * confirmer mandatory for every consequential vault action — default ON.
 */

export type SessionStatus = "EXPLORING" | "PROVISIONAL_LOCK" | "LOCKED" | "HALT";

/** Environment flag; default ON (unset = require the confirmer). */
export const HUMAN_LOCK_ENV = "VAULTMIND_CHP_REQUIRE_HUMAN_LOCK";

export function requireHumanLockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[HUMAN_LOCK_ENV];
  if (raw === undefined || raw.trim() === "") return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/** Port of chp.models.ThirdPartyValidation. */
export interface ThirdPartyValidation {
  /** The named human confirmer. */
  validator: string;
  /** The decision item being confirmed (the decision id). */
  item: string;
  challenge: string;
  result: "CONFIRM" | "REJECT";
  rationale: string;
}

/**
 * A CHP decision case for a vault action. The protocol registry in the
 * reference library is in-memory state; the decision ledger is the durable
 * record, so the case here is the gate's working carrier.
 */
export interface HardenedCase {
  decisionId: string;
  title: string;
  domain: "defi";
  createdAt: string;
  owner: string;
  highStakes: boolean;
  status: SessionStatus;
  lockedDecisions: string[];
  thirdPartyLog: ThirdPartyValidation[];
  flipCriteria: string[];
  foundationScore: number | null;
}

export function openCase(input: {
  decisionId: string;
  title: string;
  owner?: string;
}): HardenedCase {
  return {
    decisionId: input.decisionId,
    title: input.title,
    domain: "defi",
    createdAt: new Date().toISOString(),
    owner: input.owner ?? "vaultmind-agent",
    highStakes: true,
    // Sessions start EXPLORING.
    status: "EXPLORING",
    lockedDecisions: [],
    thirdPartyLog: [],
    flipCriteria: [],
    foundationScore: null,
  };
}

/** A hardened case opens as a provisional decision pending confirmation. */
export function markProvisionalLock(chpCase: HardenedCase): SessionStatus {
  chpCase.status = "PROVISIONAL_LOCK";
  return chpCase.status;
}

/**
 * Port of chp.apply_third_party_validation: requires PROVISIONAL_LOCK;
 * CONFIRM locks the case (and records the item), REJECT sends it back to
 * EXPLORING with a flip note.
 */
export function applyThirdPartyValidation(
  chpCase: HardenedCase,
  validation: ThirdPartyValidation,
): SessionStatus {
  if (chpCase.status !== "PROVISIONAL_LOCK") {
    throw new Error("third-party validation requires PROVISIONAL_LOCK status");
  }
  chpCase.thirdPartyLog.push(validation);
  if (validation.result === "CONFIRM") {
    chpCase.status = "LOCKED";
    if (!chpCase.lockedDecisions.includes(validation.item)) {
      chpCase.lockedDecisions.push(validation.item);
    }
  } else {
    chpCase.status = "EXPLORING";
    chpCase.flipCriteria.push(`Validation rejected: ${validation.item}`);
  }
  return chpCase.status;
}
