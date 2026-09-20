export { uploadStrategyConfig, uploadBacktestResult, uploadAgentMemory, uploadAuditLog, downloadStrategyConfig, downloadBacktestResult, downloadAgentMemory, downloadAuditLog, generateDemoBacktest, STRATEGY_TEMPLATES } from "./walrus";
export type { StrategyConfig, BacktestResult, AgentMemory, AuditLog, TradeRecord, PositionSnapshot, ExecutionEntry, WalrusUploadResult } from "./walrus";
export { AgentEngine, DEMO_AGENTS, seededSnapshot } from "./agent-engine";
export type { AgentSignal, AgentConfig } from "./agent-engine";

// CHP — Profile B spend/HITL gate (backed by @cubiczan/chp).
export { ChpGate } from "./chp/gate";
export type { ChpAction, ChpState, ProposedAction, ChpDecision, Provenance, RiskPolicy } from "./chp/gate";
export { loadPolicy, defaultPolicy, defaultPolicyBase, defaultPolicyPath, resolvePolicyPath } from "./chp/policy";

// CHP — hardened Profile A pipeline (R0 → foundation → human lock → ledger).
export { HardenedChpGate, deterministicVaultTransition, DEMO_PRICES_USD } from "./chp/hardened-gate";
export type { HardenedOutcome, HardenedStage, VaultTransition, HardenedGateOptions } from "./chp/hardened-gate";
export { R0Evaluator } from "./chp/r0";
export type { R0Result, R0Results, R0Criteria, R0Verdict, R0GateEvaluation } from "./chp/r0";
export { assessFoundation, defaultGoldenInvariants, GUARDRAIL_POINTS, BOUNDED_RESULT_POINTS, PARITY_POINTS, FULL_SCORE, DEFI_FLOOR } from "./chp/foundation";
export type { FoundationVerdict, GoldenInvariant, ParityEvidence, FoundationAssessment } from "./chp/foundation";
export { applyThirdPartyValidation, markProvisionalLock, openCase, requireHumanLockEnabled, HUMAN_LOCK_ENV } from "./chp/session";
export type { SessionStatus, ThirdPartyValidation, HardenedCase } from "./chp/session";
export { DecisionLedger, sealDecision, checkRecord, buildPayloadEnvelope, validatePayloadEnvelope, bodySha256, canonicalJson, defaultLedgerPath, LEDGER_PATH_ENV, PAYLOAD_ROUTE } from "./chp/ledger";
export type { DecisionRecord, DecisionRecordFields, CheckedRecord, ParitySnapshot } from "./chp/ledger";
