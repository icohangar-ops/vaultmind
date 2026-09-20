/**
 * Tests for Walrus uploads (src/walrus.ts)
 *
 * Proves: the publisher upload URL carries a NUMERIC ?epochs= value so blob
 * retention is actually set — the historical bug passed a content label
 * ("strategy-config", "agent-memory", …) where a number of epochs belongs —
 * and that invalid epoch counts fail fast before any network call.
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  uploadStrategyConfig,
  uploadBacktestResult,
  uploadAgentMemory,
  uploadAuditLog,
  buildPublisherUploadUrl,
} from "../src/walrus";
import type { StrategyConfig, BacktestResult, AgentMemory, AuditLog } from "../src/walrus";

const PUBLISHER = "https://publisher.walrus-testnet.walrus.space";

function makeStrategyConfig(): StrategyConfig {
  return {
    name: "Momentum Alpha",
    description: "Test strategy",
    version: "1.0.0",
    category: "defi_yield",
    parameters: { lookbackWindow: 7 },
    riskLevel: 6,
    rebalanceIntervalMs: 3600000,
    maxPositionSize: 0.25,
    stopLossBps: 500,
    takeProfitBps: 1500,
  };
}

function makeBacktestResult(): BacktestResult {
  return {
    strategyName: "Momentum Alpha",
    periodDays: 30,
    startBalance: 10000,
    endBalance: 10500,
    totalReturnBps: 500,
    sharpeRatio: 1.2,
    maxDrawdownBps: 300,
    winRateBps: 5500,
    totalTrades: 12,
    dailyReturns: [10, -5, 20],
    trades: [],
  };
}

function makeAgentMemory(): AgentMemory {
  return {
    agentId: "agent-1",
    state: "idle",
    lastSignal: null,
    positionSnapshot: null,
    executionLog: [],
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}

function makeAuditLog(): AuditLog {
  return {
    vaultId: "vault-1",
    agentId: "agent-1",
    timestamp: "2026-09-20T00:00:00.000Z",
    beforeBalance: 10000,
    afterBalance: 10100,
    actions: [],
    walrusConfigId: "config-1",
  };
}

interface CapturedRequest {
  url: string;
  body: string;
}

/** Stubs global fetch, runs the upload, restores fetch even on failure. */
async function captureUpload<T>(run: () => Promise<T>): Promise<{ request: CapturedRequest; result: T }> {
  const original = globalThis.fetch;
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: Buffer.from(init?.body as Uint8Array).toString("utf8"),
    });
    return new Response(
      JSON.stringify({ newlyCreated: { blobObject: { blobId: "blob-test-123" } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  let result: T;
  try {
    result = await run();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured.length, 1, "exactly one publisher request was made");
  return { request: captured[0], result };
}

test("uploadStrategyConfig sends a numeric epochs query and never the content label", async () => {
  const { request: { url, body } } = await captureUpload(() => uploadStrategyConfig(makeStrategyConfig()));

  const parsed = new URL(url);
  assert.equal(`${parsed.protocol}//${parsed.host}${parsed.pathname}`, `${PUBLISHER}/v1/blobs`);
  const epochs = parsed.searchParams.get("epochs");
  assert.ok(epochs !== null, "epochs query parameter is present");
  assert.ok(/^\d+$/.test(epochs), `epochs must be a positive integer, got ${epochs}`);
  assert.equal(epochs, "5", "epochs matches the default store-epoch count");
  assert.ok(!url.includes("strategy-config"), "content label leaked into the upload URL");

  const sent = JSON.parse(body) as { type?: string };
  assert.equal(sent.type, "strategy_config");
});

test("every upload path requests numeric store epochs", async () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["strategy-config", () => uploadStrategyConfig(makeStrategyConfig())],
    ["backtest-result", () => uploadBacktestResult(makeBacktestResult())],
    ["agent-memory", () => uploadAgentMemory(makeAgentMemory())],
    ["audit-log", () => uploadAuditLog(makeAuditLog())],
  ];

  for (const [label, run] of cases) {
    const { request } = await captureUpload(run);
    const epochs = new URL(request.url).searchParams.get("epochs");
    assert.ok(
      epochs !== null && /^\d+$/.test(epochs) && Number(epochs) > 0,
      `${label}: epochs must be a positive integer, got ${epochs}`,
    );
    assert.ok(!request.url.includes(label), `${label}: label leaked into the upload URL`);
  }
});

test("upload result reports the publisher blobId and byte size", async () => {
  const { result } = await captureUpload(() => uploadStrategyConfig(makeStrategyConfig()));
  assert.equal(result.blobId, "blob-test-123");
  assert.ok(result.size > 0);
  assert.ok(!Number.isNaN(Date.parse(result.created)));
});

test("buildPublisherUploadUrl rejects invalid epoch counts before any network call", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => buildPublisherUploadUrl(bad), /positive integer/);
  }
  assert.equal(buildPublisherUploadUrl(12), `${PUBLISHER}/v1/blobs?epochs=12`);
});
