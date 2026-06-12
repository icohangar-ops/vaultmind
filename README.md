<p align="center">
  <img src="media/vaultmind-hero.png" alt="VaultMind" width="800" />
</p>

<h1 align="center">VaultMind</h1>

<p align="center">
  <strong>AI Agent-Managed DeFi Vaults on Sui</strong>
</p>

<p align="center">
  Deploy AI trading agents that autonomously manage DeFi vaults — with strategies, backtests, and audit logs stored on Walrus.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#contracts">Smart Contracts</a> ·
  <a href="#walrus-integration">Walrus Integration</a> ·
  <a href="#quick-start">Quick Start</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Sui-Blockchain-4DA2FF?logo=sui&logoColor=white" alt="Sui" />
  <img src="https://img.shields.io/badge/Walrus-Storage-6F42C1?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PC9zdmc+" alt="Walrus" />
  <img src="https://img.shields.io/badge/Move-Lang-3A86FF?style=flat" alt="Move" />
  <img src="https://img.shields.io/badge/Next.js-15-Dashboard-black" alt="Next.js" />
  <img src="https://img.shields.io/badge/Hackathon-Sui_Overflow_2026-F59E0B" alt="Sui Overflow 2026" />
</p>

---

## What is VaultMind?

VaultMind is a decentralized protocol on Sui where **AI trading agents autonomously manage DeFi vaults**. Strategy developers create and upload trading strategies to Walrus, agents execute those strategies on-chain, and users deposit SUI into vaults to earn yield — all without centralized control.

**The core insight:** DeFi vaults today are either passive (lend/borrow) or require manual management. VaultMind introduces the **Agentic Vault** pattern — an on-chain vault controlled by an off-chain AI agent that executes a verifiable strategy stored on Walrus decentralized storage.

## Features

### AI Trading Agents
- Agents run customizable trading strategies (momentum, yield farming, arbitrage, liquid staking)
- On-chain agent registry with reputation scoring
- Execution logs stored on Walrus for full auditability
- Auto-adjusting reputation based on performance

### On-Chain Vaults (Sui Move)
- Shared vault objects with share-based accounting
- Users deposit SUI and receive vault shares
- Performance fees split between protocol, strategy creator, and vault manager
- Pause/unpause functionality for risk management

### Strategy Marketplace
- Developers register strategies with Walrus-stored configs and backtests
- Strategies include risk scores, Sharpe ratios, max drawdown metrics
- One-tx deployment via `AgentFactory` — register strategy + agent + vault in a single transaction

### Walrus Storage Integration
- Strategy configurations stored immutably on Walrus
- Backtest results (daily returns, trade history) on Walrus
- Agent memory/state snapshots persisted to Walrus
- Full audit trails — every rebalance, every fee collection, verifiable

### Dashboard
- Real-time vault performance and AUM tracking
- Agent activity monitoring with live status
- Strategy explorer with backtest visualizations
- Portfolio allocation views

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     VAULTMIND PROTOCOL                        │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │  AI Agent    │  │  Agent       │  │  Strategy          │   │
│  │  Execution   │  │  Registry    │  │  Registry          │   │
│  │  Engine      │  │  (on-chain)  │  │  (on-chain)        │   │
│  │  (off-chain) │  │              │  │                    │   │
│  └──────┬───────┘  └──────▲───────┘  └─────────▲──────────┘   │
│         │                 │                     │              │
│  ═══════╪═════════════════╪═════════════════════╪═════════     │
│         ▼                 ▼                     ▼              │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                 SUI BLOCKCHAIN                            │  │
│  │                                                          │  │
│  │  ┌──────────────┐  ┌────────────┐  ┌─────────────────┐   │  │
│  │  │  Vault       │  │  Fee       │  │  Agent Factory  │   │  │
│  │  │  (deposit/   │  │  Splitter  │  │  (one-tx       │   │  │
│  │  │   withdraw/  │  │            │  │   deploy)       │   │  │
│  │  │   shares)    │  │            │  │                 │   │  │
│  │  └──────────────┘  └────────────┘  └─────────────────┘   │  │
│  └──────────────────────────┬──────────────────────────────┘  │
│                              │                                 │
│  ────────────────────────────┼───────────────────────────────  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   WALRUS STORAGE                          │  │
│  │                                                           │  │
│  │  📦 Strategy Configs    📊 Backtest Results               │  │
│  │  🧠 Agent Memory        📋 Audit Logs                    │  │
│  │  💻 Agent Code          📈 Historical Performance        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                 NEXT.JS DASHBOARD                         │  │
│  │  Vaults · Agents · Strategies · Portfolio · Analytics     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Smart Contracts

### `vault.move` — Core Vault
- Create vaults with strategy and agent bindings
- Deposit SUI → receive share tokens (proportional)
- Withdraw by burning shares
- On-chain performance recording with fee calculation
- Protocol fee (1%) + manager performance fee (configurable)

### `strategy.move` — Strategy Registry
- Register strategies with Walrus blob references
- Store risk scores, Sharpe ratios, max drawdown, backtest periods
- Update strategy files (new config/backtest versions on Walrus)
- Deactivation for deprecated strategies

### `agent.move` — Agent Identity
- On-chain agent registration with execution endpoints
- Reputation system: auto-adjusts based on execution results
- Success rate tracking, profit accumulation
- Walrus-based persistent memory

### `agent_factory.move` — One-Tx Deploy
- Deploy strategy + agent + vault in a single transaction
- Atomic setup ensures consistency

## Walrus Integration

VaultMind uses Walrus as the **immutable, verifiable storage layer** for everything that doesn't belong on-chain:

| Data Type | Why Walrus | Access Pattern |
|-----------|-----------|----------------|
| Strategy Configs | Too large for on-chain, must be immutable | Read by agents and vaults |
| Backtest Results | Historical data, verifiable by depositors | Read by users evaluating strategies |
| Agent Memory | Persistent state across executions | Read/write by agent owner |
| Audit Logs | Full execution history for compliance | Append-only, public verification |
| Agent Code | Strategy implementation for verification | Read by anyone |

The SDK provides `uploadToWalrus()` / `downloadFromWalrus()` wrappers around the Walrus publisher/aggregator APIs, plus structured types for each data category.

## Quick Start

### Prerequisites
- [Sui CLI](https://docs.sui.io/build/install)
- Node.js 18+
- [Walrus testnet access](https://docs.walrus.site/)

### 1. Clone & Install
```bash
git clone https://github.com/icohangar-ops/vaultmind.git
cd vaultmind
npm install
```

### 2. Deploy Contracts (Sui Devnet)
```bash
sui client switch --env devnet
cd packages/contracts
sui move build
sui client publish --gas-budget 100000000
```

### 3. Run Dashboard
```bash
cd web
npm install
npm run dev
```

### 4. Upload a Strategy to Walrus
```typescript
import { uploadStrategyConfig, uploadBacktestResult, generateDemoBacktest } from "@vaultmind/sdk";

const config = {
  name: "Momentum Alpha",
  description: "Identifies momentum patterns in Sui DeFi protocols",
  version: "1.0.0",
  category: "defi_yield",
  parameters: { lookbackWindow: 7, thresholdBps: 200 },
  riskLevel: 6,
  rebalanceIntervalMs: 3600000,
  maxPositionSize: 0.25,
  stopLossBps: 500,
  takeProfitBps: 1500,
};

const { blobId } = await uploadStrategyConfig(config);
console.log("Strategy stored on Walrus:", blobId);
```

## Project Structure

```
vaultmind/
├── packages/
│   └── contracts/
│       ├── Move.toml
│       └── sources/
│           ├── vault.move           # Core vault (deposit/withdraw/fees)
│           ├── strategy.move        # Strategy registry
│           ├── agent.move           # Agent identity & reputation
│           └── agent_factory.move   # One-tx deployment
├── vaultmind-sdk/
│   ├── package.json
│   └── src/
│       ├── index.ts                # SDK exports
│       ├── walrus.ts               # Walrus upload/download + types
│       └── agent-engine.ts         # Agent execution engine + demo
├── web/
│   ├── package.json
│   └── src/
│       ├── app/                    # Next.js App Router pages
│       ├── components/             # React components
│       └── lib/                    # Demo data
├── media/                          # Images & assets
├── docs/                           # Documentation
└── README.md
```

## Roadmap

- [ ] Real Sui DEX integration (Cetus, Turbos, FlowX) via Sui SDK
- [ ] On-chain price feeds (Pyth oracle)
- [ ] Agent-to-agent communication protocol
- [ ] Governance: vault parameter changes via token voting
- [ ] Cross-chain vaults (Sui ↔ Ethereum via Wormhole)
- [ ] zkVM verification of agent execution proofs

## Sui Overflow 2026

**Track:** Core Track (also eligible for DeFi & Payments, Special — Walrus)
**Technologies:** Sui Move, Walrus Storage, AI Agent Execution

Built for [Sui Overflow 2026 — The Agentic Web](https://www.deepsurge.xyz/) ($500K prize pool)

## License

MIT © 2026

---

<p align="center">
  Built for <a href="https://www.deepsurge.xyz/">Sui Overflow 2026</a> ·
  Powered by <a href="https://sui.io">Sui</a> +
  <a href="https://docs.walrus.site/">Walrus</a> +
  <a href="https://move-language.org/">Move</a>
</p>