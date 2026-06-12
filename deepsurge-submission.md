# VaultMind — DeepSurge Submission Content

## Project Name
VaultMind

## Track
Core Track

## Deployment Network
Sui Devnet

## Short Description
AI agent-managed DeFi vaults on Sui. Deploy trading strategies stored on Walrus, let AI agents execute them autonomously, and earn yield — all verifiable on-chain.

## Project Story

### Inspiration
The DeFi vault landscape on Sui is growing rapidly with protocols like Turbos, Cetus, and FlowX, but yield optimization is still manual. Users must constantly research, switch between protocols, and time their moves. Meanwhile, AI agents are transforming every industry — but they haven't been meaningfully integrated into on-chain DeFi vaults. We asked: what if AI agents could autonomously manage DeFi vaults, with their strategies, backtests, and audit logs stored verifiably on decentralized storage?

### What it does
VaultMind is a protocol where AI trading agents autonomously manage DeFi vaults on Sui. Strategy developers create trading strategies, upload their configurations and backtest results to Walrus decentralized storage, and register them on-chain. AI agents execute these strategies off-chain, recording every action on-chain and storing full audit logs on Walrus. Users deposit SUI into vaults, receive share tokens, and earn yield from successful agent execution — all with transparent, verifiable performance data.

The system has four on-chain Move modules: Vaults handle deposits, withdrawals, and share accounting; Strategies store metadata and Walrus references; Agents maintain identity, reputation, and execution history; and AgentFactory enables one-transaction deployment of a complete strategy-agent-vault stack.

### How we built it
We built VaultMind with four layers. The on-chain layer uses Sui Move with four modules: vault.move for share-based vault management with fee splitting, strategy.move for strategy registration with Walrus blob references, agent.move for agent identity and auto-adjusting reputation, and agent_factory.move for atomic one-tx deployment. The storage layer integrates Walrus for strategy configs, backtest results, agent memory persistence, and audit logs — all data that's too large or too frequent for on-chain storage but must be verifiable. The agent execution layer is a TypeScript engine that generates trading signals, executes them, and persists state to Walrus. The dashboard layer is a Next.js app with real-time vault monitoring, agent activity feeds, strategy exploration with backtest visualizations, and portfolio analytics.

### Challenges we ran into
The biggest challenge was designing the data boundary between on-chain and Walrus storage. We needed to keep on-chain state minimal (for gas efficiency) while ensuring everything is verifiable. Our solution: store only references (Walrus blob IDs) and aggregated metrics on-chain, with full data on Walrus. Another challenge was the reputation system — we needed it to be tamper-proof and auto-adjusting without requiring oracle inputs. We solved this by computing reputation delta directly from execution results within the Move contract.

### Accomplishments that we're proud of
We're proud of the one-tx AgentFactory that deploys a complete strategy-agent-vault stack atomically. We're also proud of the Walrus integration pattern — using it as a verifiable off-chain storage layer for audit logs creates a trust model where users don't need to trust the vault manager. Every rebalance, every fee collection, every agent decision is recorded on Walrus with an on-chain reference. The dashboard's real-time agent monitoring and backtest visualization make the complex system accessible to non-technical users.

### What we learned
We learned that Move's object model is uniquely suited for vault management — shared objects with capabilities make the access control pattern natural. We also learned that Walrus's blob storage model maps well to verifiable data requirements in DeFi. The key insight was that the combination of on-chain state + off-chain Walrus storage creates a more trustless system than either alone.

### What's next for VaultMind
The immediate next step is connecting agents to real Sui DEXes (Cetus, Turbos, FlowX) via the Sui TypeScript SDK for actual trade execution. Beyond that, we plan to integrate Pyth price feeds for on-chain oracle data, implement agent-to-agent communication for portfolio-level strategies, add governance for vault parameter changes, and explore cross-chain vaults via Wormhole.

## Links
- GitHub: https://github.com/icohangar-ops/vaultmind
- Website: (dashboard URL)