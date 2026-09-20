/**
 * VaultMind — Agent Execution Engine
 * Simulates AI agent trading logic for demo purposes.
 * In production, this would connect to real DEXes via Sui SDK.
 *
 * Every consequential vault action (buy / sell / rebalance) runs through the
 * hardened CHP gate before it is applied:
 *   R0 solvability -> Profile B spend gate -> deterministic adversary
 *   foundation pass -> human lock -> sealed decision ledger record.
 */

import type { AgentMemory, PositionSnapshot, ExecutionEntry } from "./walrus";
import { ChpGate, type ChpAction } from "./chp/gate";
import { HardenedChpGate, type HardenedOutcome } from "./chp/hardened-gate";
import { DecisionLedger, defaultLedgerPath } from "./chp/ledger";
import {
  RECEIPT_TTL_MS,
  hashVaultActionArgs,
  issueVaultActionReceipt,
  resolveReceiptKey,
  vaultActionReceiptArgs,
  verifyExecutionReceipt,
} from "./chp/receipt";
import { FileReplayStore, defaultReplayLogPath, type ReplayStore } from "./chp/replay";

export interface AgentSignal {
  action: "buy" | "sell" | "hold" | "rebalance";
  token: string;
  amount: number;
  confidence: number; // 0-1
  reasoning: string;
}

export interface AgentConfig {
  agentId: string;
  name: string;
  strategyType: string;
  riskTolerance: number; // 1-10
  maxPositions: number;
  rebalanceIntervalMs: number;
}

/** Deterministic seeded demo vault: 2,000 SUI + 10,000 USDC of cash. */
export function seededSnapshot(): PositionSnapshot {
  const tokens = [
    { symbol: "SUI", amount: 2000, valueSui: 2000 },
    { symbol: "USDC", amount: 10000, valueSui: 10000 / 1.85 },
  ];
  const totalValueSui = tokens.reduce((sum, t) => sum + t.valueSui, 0);
  return { tokens, totalValueSui, unrealizedPnlBps: 0 };
}

function defaultMemory(config: AgentConfig): AgentMemory {
  return {
    agentId: config.agentId,
    state: "idle",
    lastSignal: null,
    // Seed a funded snapshot so the R0 solvability gate evaluates against
    // real vault state instead of refusing everything from nothing.
    positionSnapshot: seededSnapshot(),
    executionLog: [],
    updatedAt: new Date().toISOString(),
  };
}

export class AgentEngine {
  private config: AgentConfig;
  private memory: AgentMemory;
  private signalCount = 0;
  private chpGate: ChpGate;
  private hardened: HardenedChpGate;
  private readonly receiptKeyOverride?: string;
  private readonly receiptReplay: ReplayStore;

  constructor(
    config: AgentConfig,
    initialMemory?: AgentMemory,
    chpGate?: ChpGate,
    ledger: DecisionLedger = new DecisionLedger(defaultLedgerPath()),
    receipts?: { key?: string; replay?: ReplayStore },
  ) {
    this.config = config;
    this.memory = initialMemory ?? defaultMemory(config);
    // Decision-governance gate. Loads config/policy.yaml (conservative
    // default if missing). Every capital-moving signal passes through it.
    this.chpGate = chpGate ?? new ChpGate();
    this.hardened = new HardenedChpGate({ spend: this.chpGate, ledger });
    this.receiptKeyOverride = receipts?.key;
    // Pass the receipt TTL so entries past it are pruned on startup and the
    // log compacted — a nonce older than the TTL cannot be replayed by a
    // valid receipt, so this bounds growth with no security regression.
    this.receiptReplay = receipts?.replay ?? new FileReplayStore(defaultReplayLogPath(), RECEIPT_TTL_MS);
  }

  /** Expose the Profile B spend gate for provenance inspection. */
  getChpGate(): ChpGate {
    return this.chpGate;
  }

  /** Expose the hardened CHP gate (R0 → spend → foundation → lock → record). */
  getHardenedGate(): HardenedChpGate {
    return this.hardened;
  }

  /** The sealed decision ledger (JSONL, integrity-checked on read). */
  getDecisionLedger(): DecisionLedger {
    return this.hardened.getDecisionLedger();
  }

  getMemory(): AgentMemory {
    return { ...this.memory };
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  /**
   * Generate a trading signal based on simulated market analysis.
   * In production, this would call an actual LLM or on-chain oracle.
   */
  generateSignal(marketData: { suiPrice: number; suiChange24h: number; tvl: number }): AgentSignal {
    this.memory.state = "analyzing";
    this.signalCount++;

    // Simulated signal generation based on strategy type
    let signal: AgentSignal;

    switch (this.config.strategyType) {
      case "momentum":
        signal = this.momentumSignal(marketData);
        break;
      case "yield":
        signal = this.yieldSignal(marketData);
        break;
      case "arbitrage":
        signal = this.arbitrageSignal(marketData);
        break;
      default:
        signal = { action: "hold", token: "SUI", amount: 0, confidence: 0.5, reasoning: "No clear signal" };
    }

    this.memory.lastSignal = `${signal.action} ${signal.token} (${(signal.confidence * 100).toFixed(0)}%)`;
    this.memory.state = signal.action === "hold" ? "idle" : "executing";
    this.memory.updatedAt = new Date().toISOString();

    return signal;
  }

  /**
   * Execute a signal and record the result.
   *
   * `confirmedBy` is the named human confirmer: with
   * VAULTMIND_CHP_REQUIRE_HUMAN_LOCK on (the default) a consequential action
   * without one is refused while its case stays PROVISIONAL_LOCK.
   */
  executeSignal(signal: AgentSignal, vaultId: string, confirmedBy?: string): ExecutionEntry {
    this.memory.state = "executing";

    // ─── Hardened CHP pipeline (governance) ───────────────────
    // "hold" is not a capital-moving action; everything else runs through
    // R0 -> spend gate -> foundation -> human lock -> ledger. Refused
    // signals are recorded as failed executions and NOT applied.
    if (signal.action !== "hold") {
      const outcome = this.hardened.evaluateHardened(
        {
          action: signal.action as ChpAction,
          asset: signal.token,
          notionalUsd: signal.amount,
          confidence: signal.confidence,
          rationale: signal.reasoning,
          vaultId,
        },
        this.memory.positionSnapshot,
        confirmedBy,
      );
      if (!outcome.allowed) {
        return this.record(this.refusalEntry(signal, vaultId, outcome));
      }

      // ─── Row-22 tool-approval receipt ──────────────────────────
      // A gate verdict — even LOCKED — is an allowlist answer, not
      // authorization. Issue a receipt binding actor/tool/resource/exact
      // action args/policy/risk/expiry/nonce, then verify it at the
      // execution boundary. Fail-closed: resolveReceiptKey throws when
      // VAULTMIND_CHP_RECEIPT_KEY is unset, and a failed verification or
      // an unresolvable key refuses the action before the post-state is
      // applied.
      let receiptActor: string;
      let receiptNonce: string;
      try {
        const receiptKey = resolveReceiptKey(this.receiptKeyOverride);
        const args = vaultActionReceiptArgs(
          signal.action as "buy" | "sell" | "rebalance",
          signal.token,
          signal.amount,
          vaultId,
        );
        const argsHash = hashVaultActionArgs(args);
        const receipt = issueVaultActionReceipt(
          {
            actor: confirmedBy ?? "chp:policy-engine",
            resource: `vaultmind:execute:${vaultId}:${signal.token}`,
            args_hash: argsHash,
            policy_version: this.chpGate.getPolicy().version,
            risk: this.receiptRiskFor(signal.amount),
            decision: "allow",
            ttlMs: RECEIPT_TTL_MS,
          },
          receiptKey,
        );
        const receiptCheck = verifyExecutionReceipt(
          receipt,
          // Expected policy version comes from the LIVE gate policy, not
          // from the receipt's self-report — comparing the field against
          // itself would make the check vacuous and let a receipt signed
          // under a rotated/deprecated policy pass verification.
          { argsHash, policyVersion: this.chpGate.getPolicy().version, key: receiptKey },
          this.receiptReplay,
        );
        if (!receiptCheck.ok) {
          return this.record({
            timestamp: new Date().toISOString(),
            action: `${signal.action} ${signal.token}`,
            vaultId,
            result: "failure",
            details: `CHP receipt verification failed: ${receiptCheck.reason}`,
            profitDelta: 0,
            chpDecisionId: outcome.record?.decision_id,
          });
        }
        receiptActor = receiptCheck.receipt.actor;
        receiptNonce = receiptCheck.receipt.nonce;
      } catch (error) {
        // Fail-closed throws from the receipt layer: a missing/blank key
        // (resolveReceiptKey) and a replay-log persistence failure (the
        // store refuses to degrade to in-memory-only protection).
        return this.record({
          timestamp: new Date().toISOString(),
          action: `${signal.action} ${signal.token}`,
          vaultId,
          result: "failure",
          details: `CHP receipt: ${(error as Error).message}`,
          profitDelta: 0,
          chpDecisionId: outcome.record?.decision_id,
        });
      }

      // The post-action state was parity-verified by the foundation pass —
      // apply it deterministically instead of sampling a random snapshot.
      if (outcome.post) {
        this.memory.positionSnapshot = outcome.post;
      }
      const profitDelta = signal.action === "sell" ? Math.random() * 0.05 * 1e9 : 0;
      return this.record({
        timestamp: new Date().toISOString(),
        action: `${signal.action} ${signal.token}`,
        vaultId,
        result: "success",
        details: signal.reasoning,
        profitDelta: Math.round(profitDelta),
        chpDecisionId: outcome.record?.decision_id,
        receiptActor,
        receiptNonce,
      });
    }

    // Hold bypass: `hold` moves no capital and mutates no vault state —
    // the gate and receipt layers are bypassed by design. If hold semantics
    // ever expand (fee accrual, snapshot commits, any auditable write),
    // this exemption must be revisited.
    return this.record({
      timestamp: new Date().toISOString(),
      action: `${signal.action} ${signal.token}`,
      vaultId,
      result: "success",
      details: signal.reasoning,
      profitDelta: 0,
    });
  }

  // ── Internals ──────────────────────────────────────────────

  /**
   * Deterministic row-22 receipt risk tier from the action amount: at or
   * above 1000 units the approval is high risk, any positive amount is
   * medium, and a zero-amount action is low.
   *
   * Units are the raw signal amount (token units in this engine), NOT a
   * USD-equivalent: anchoring tiers to real financial exposure needs a
   * price feed the engine deliberately does not have (same reasoning as
   * the row-5 reversal, see README). Until such a feed exists the tier is
   * a relative, unit-denominated label — under the policy spend caps
   * "high" may be unreachable in production.
   */
  private receiptRiskFor(amount: number): "low" | "medium" | "high" {
    if (amount >= 1000) return "high";
    if (amount > 0) return "medium";
    return "low";
  }

  private refusalEntry(signal: AgentSignal, vaultId: string, outcome: HardenedOutcome): ExecutionEntry {
    return {
      timestamp: new Date().toISOString(),
      action: `${signal.action} ${signal.token}`,
      vaultId,
      result: "failure",
      details: `CHP gate (${outcome.stage}/${outcome.state}): ${outcome.reason}`,
      profitDelta: 0,
    };
  }

  private record(entry: ExecutionEntry): ExecutionEntry {
    this.memory.executionLog.unshift(entry);
    if (this.memory.executionLog.length > 100) {
      this.memory.executionLog = this.memory.executionLog.slice(0, 100);
    }
    this.memory.state = "waiting";
    this.memory.updatedAt = new Date().toISOString();
    return entry;
  }

  private momentumSignal(data: { suiPrice: number; suiChange24h: number }): AgentSignal {
    if (data.suiChange24h > 3) {
      return {
        action: "buy", token: "SUI",
        amount: 1000, confidence: 0.75,
        reasoning: `Strong momentum detected: ${data.suiChange24h.toFixed(1)}% 24h change. Entering long position.`,
      };
    } else if (data.suiChange24h < -2) {
      return {
        action: "sell", token: "SUI",
        amount: 500, confidence: 0.65,
        reasoning: `Bearish momentum: ${data.suiChange24h.toFixed(1)}% 24h. Reducing exposure.`,
      };
    }
    return { action: "hold", token: "SUI", amount: 0, confidence: 0.5, reasoning: "No significant momentum signal" };
  }

  private yieldSignal(data: { tvl: number }): AgentSignal {
    if (data.tvl > 100_000_000) {
      return {
        action: "rebalance", token: "USDC",
        amount: 2000, confidence: 0.8,
        reasoning: `High TVL detected (${(data.tvl / 1e6).toFixed(0)}M). Reallocating to stablecoin yields.`,
      };
    }
    return { action: "hold", token: "USDC", amount: 0, confidence: 0.6, reasoning: "Yield conditions stable" };
  }

  private arbitrageSignal(_data: { suiPrice: number }): AgentSignal {
    // Simulate detecting a spread
    const spread = Math.random() * 100; // 0-100 bps
    if (spread > 50) {
      return {
        action: "buy", token: "SUI",
        amount: 5000, confidence: 0.9,
        reasoning: `Cross-protocol spread: ${spread.toFixed(0)} bps. Executing arb.`,
      };
    }
    return { action: "hold", token: "SUI", amount: 0, confidence: 0.4, reasoning: "No profitable spread detected" };
  }
}

// ========== Demo Agent Configs ==========

export const DEMO_AGENTS: AgentConfig[] = [
  {
    agentId: "agent-momentum-01",
    name: "Momentum Alpha",
    strategyType: "momentum",
    riskTolerance: 6,
    maxPositions: 5,
    rebalanceIntervalMs: 3600000,
  },
  {
    agentId: "agent-yield-01",
    name: "Yield Harvester",
    strategyType: "yield",
    riskTolerance: 3,
    maxPositions: 4,
    rebalanceIntervalMs: 86400000,
  },
  {
    agentId: "agent-arb-01",
    name: "Arb Sprinter",
    strategyType: "arbitrage",
    riskTolerance: 2,
    maxPositions: 2,
    rebalanceIntervalMs: 5000,
  },
  {
    agentId: "agent-stable-01",
    name: "Stable Guardian",
    strategyType: "yield",
    riskTolerance: 1,
    maxPositions: 3,
    rebalanceIntervalMs: 86400000,
  },
];
