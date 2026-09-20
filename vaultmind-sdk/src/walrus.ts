/**
 * VaultMind — Walrus Storage SDK
 * Handles uploading/downloading strategy configs, backtests,
 * agent memory, and audit logs to Walrus decentralized storage.
 */

const WALRUS_PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space";
const WALRUS_AGGREGATOR_URL = "https://aggregator.walrus-testnet.walrus.space";

export interface WalrusUploadResult {
  blobId: string;
  size: number;
  created: string;
}

export interface StrategyConfig {
  name: string;
  description: string;
  version: string;
  category: "defi_yield" | "arbitrage" | "market_making" | "yield_farming" | "liquid_staking";
  parameters: Record<string, number | string | boolean>;
  riskLevel: number; // 1-10
  rebalanceIntervalMs: number;
  maxPositionSize: number;
  stopLossBps: number;
  takeProfitBps: number;
}

export interface BacktestResult {
  strategyName: string;
  periodDays: number;
  startBalance: number;
  endBalance: number;
  totalReturnBps: number;
  sharpeRatio: number;
  maxDrawdownBps: number;
  winRateBps: number;
  totalTrades: number;
  dailyReturns: number[];
  trades: TradeRecord[];
}

export interface TradeRecord {
  timestamp: string;
  action: "buy" | "sell" | "rebalance";
  token: string;
  amount: number;
  price: number;
  profitBps: number;
  reason: string;
}

export interface AgentMemory {
  agentId: string;
  state: "idle" | "analyzing" | "executing" | "waiting";
  lastSignal: string | null;
  positionSnapshot: PositionSnapshot | null;
  executionLog: ExecutionEntry[];
  updatedAt: string;
}

export interface PositionSnapshot {
  tokens: { symbol: string; amount: number; valueSui: number }[];
  totalValueSui: number;
  unrealizedPnlBps: number;
}

export interface ExecutionEntry {
  timestamp: string;
  action: string;
  vaultId: string;
  result: "success" | "failure";
  details: string;
  profitDelta: number;
  /** Decision-ledger id when the action was recorded through the CHP gate. */
  chpDecisionId?: string;
}

export interface AuditLog {
  vaultId: string;
  agentId: string;
  timestamp: string;
  beforeBalance: number;
  afterBalance: number;
  actions: AuditAction[];
  walrusConfigId: string;
}

export interface AuditAction {
  type: "rebalance" | "deposit_yield" | "fee_collection" | "strategy_update";
  description: string;
  amount?: number;
}

// ========== Upload Functions ==========

export async function uploadStrategyConfig(config: StrategyConfig): Promise<WalrusUploadResult> {
  const payload = JSON.stringify({
    type: "strategy_config",
    ...config,
    uploadedAt: new Date().toISOString(),
  });

  return uploadToWalrus(payload, "strategy-config");
}

export async function uploadBacktestResult(result: BacktestResult): Promise<WalrusUploadResult> {
  const payload = JSON.stringify({
    type: "backtest_result",
    version: "1.0",
    ...result,
    uploadedAt: new Date().toISOString(),
  });

  return uploadToWalrus(payload, "backtest-result");
}

export async function uploadAgentMemory(memory: AgentMemory): Promise<WalrusUploadResult> {
  const payload = JSON.stringify({
    type: "agent_memory",
    version: "1.0",
    ...memory,
  });

  return uploadToWalrus(payload, "agent-memory");
}

export async function uploadAuditLog(log: AuditLog): Promise<WalrusUploadResult> {
  const payload = JSON.stringify({
    type: "audit_log",
    version: "1.0",
    ...log,
  });

  return uploadToWalrus(payload, "audit-log");
}

// ========== Download Functions ==========

export async function downloadStrategyConfig(blobId: string): Promise<StrategyConfig> {
  const data = await downloadFromWalrus(blobId);
  return JSON.parse(data) as StrategyConfig;
}

export async function downloadBacktestResult(blobId: string): Promise<BacktestResult> {
  const data = await downloadFromWalrus(blobId);
  return JSON.parse(data) as BacktestResult;
}

export async function downloadAgentMemory(blobId: string): Promise<AgentMemory> {
  const data = await downloadFromWalrus(blobId);
  return JSON.parse(data) as AgentMemory;
}

export async function downloadAuditLog(blobId: string): Promise<AuditLog> {
  const data = await downloadFromWalrus(blobId);
  return JSON.parse(data) as AuditLog;
}

// ========== Low-level Walrus Operations ==========

/** Shape of the Walrus publisher's blob-registration response. */
interface WalrusUploadResponse {
  newlyCreated?: { blobObject?: { blobId?: string } };
  existingBlobObject?: { blobId?: string };
  blobId?: string;
}

async function uploadToWalrus(content: string, epoch?: string): Promise<WalrusUploadResult> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);

  const response = await fetch(`${WALRUS_PUBLISHER_URL}/v1/blobs?epochs=${epoch || "5"}`, {
    method: "PUT",
    body: bytes,
    headers: {
      "Content-Type": "application/octet-stream",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walrus upload failed: ${response.status} ${text}`);
  }

  const result = (await response.json()) as WalrusUploadResponse;

  const blobId =
    result.newlyCreated?.blobObject?.blobId ||
    result.existingBlobObject?.blobId ||
    result.blobId;
  if (!blobId) {
    throw new Error("Walrus upload response did not include a blobId");
  }

  return {
    blobId,
    size: bytes.length,
    created: new Date().toISOString(),
  };
}

async function downloadFromWalrus(blobId: string): Promise<string> {
  const response = await fetch(`${WALRUS_AGGREGATOR_URL}/v1/blobs/${blobId}`, {
    method: "GET",
    headers: {
      "Accept": "application/octet-stream",
    },
  });

  if (!response.ok) {
    throw new Error(`Walrus download failed: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
}

// ========== Utility: Generate Demo Backtest Data ==========

export function generateDemoBacktest(name: string, days: number, seed: number): BacktestResult {
  const dailyReturns: number[] = [];
  const trades: TradeRecord[] = [];
  let balance = 10000;
  let maxBalance = balance;
  let maxDrawdown = 0;
  let wins = 0;

  // Seeded pseudo-random
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  for (let d = 0; d < days; d++) {
    const dailyReturn = (rand() * 0.04 - 0.01); // -1% to +3% daily
    balance *= (1 + dailyReturn);
    dailyReturns.push(Math.round(dailyReturn * 10000));

    if (balance > maxBalance) maxBalance = balance;
    const dd = ((maxBalance - balance) / maxBalance) * 10000;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Simulate trades
    if (rand() > 0.6) {
      const isBuy = rand() > 0.5;
      const profit = (rand() * 0.06 - 0.02) * 10000;
      if (profit > 0) wins++;
      trades.push({
        timestamp: new Date(Date.now() - (days - d) * 86400000).toISOString(),
        action: isBuy ? "buy" : "sell",
        token: rand() > 0.5 ? "SUI" : "USDC",
        amount: Math.round(rand() * 1000 * 1e9) / 1e9,
        price: Math.round(rand() * 2 * 1e4) / 1e4,
        profitBps: Math.round(profit),
        reason: isBuy ? "momentum_signal" : "take_profit",
      });
    }
  }

  // Calculate Sharpe (annualized, simplified)
  const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const stdReturn = Math.sqrt(
    dailyReturns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / dailyReturns.length
  );
  const sharpe = stdReturn > 0 ? Math.round((avgReturn / stdReturn) * Math.sqrt(365) * 100) : 0;

  return {
    strategyName: name,
    periodDays: days,
    startBalance: 10000,
    endBalance: Math.round(balance * 100) / 100,
    totalReturnBps: Math.round(((balance - 10000) / 10000) * 10000),
    sharpeRatio: sharpe / 100,
    maxDrawdownBps: Math.round(maxDrawdown),
    winRateBps: trades.length > 0 ? Math.round((wins / trades.length) * 10000) : 0,
    totalTrades: trades.length,
    dailyReturns,
    trades,
  };
}

// ========== Strategy Templates ==========

export const STRATEGY_TEMPLATES: StrategyConfig[] = [
  {
    name: "Momentum Alpha",
    description: "Identifies momentum patterns in Sui DeFi protocols and rotates into trending assets.",
    version: "1.0.0",
    category: "defi_yield",
    parameters: { lookbackWindow: 7, thresholdBps: 200, maxPositions: 5 },
    riskLevel: 6,
    rebalanceIntervalMs: 3600000, // 1 hour
    maxPositionSize: 0.25,
    stopLossBps: 500,
    takeProfitBps: 1500,
  },
  {
    name: "Yield Harvester",
    description: "Aggregates yields across Sui lending protocols (Turbos, Cetus, FlowX) and auto-compounds.",
    version: "1.2.0",
    category: "yield_farming",
    parameters: { minApyBps: 800, compoundIntervalHrs: 24, maxProtocols: 4 },
    riskLevel: 3,
    rebalanceIntervalMs: 86400000, // 24 hours
    maxPositionSize: 0.4,
    stopLossBps: 200,
    takeProfitBps: 0,
  },
  {
    name: "Arb Sprinter",
    description: "Cross-protocol arbitrage for SUI/USDC across Cetus, Turbos, and DOLA.",
    version: "2.0.0",
    category: "arbitrage",
    parameters: { minSpreadBps: 50, maxSlippageBps: 20, gasBudget: 10000 },
    riskLevel: 2,
    rebalanceIntervalMs: 5000, // 5 seconds
    maxPositionSize: 1.0,
    stopLossBps: 100,
    takeProfitBps: 0,
  },
  {
    name: "Stable Vault",
    description: "Conservative strategy focused on stablecoin yields and minimal drawdown.",
    version: "1.0.0",
    category: "defi_yield",
    parameters: { targetApyBps: 400, maxDrawdownBps: 100, reserveRatio: 0.1 },
    riskLevel: 1,
    rebalanceIntervalMs: 86400000,
    maxPositionSize: 0.3,
    stopLossBps: 50,
    takeProfitBps: 0,
  },
];