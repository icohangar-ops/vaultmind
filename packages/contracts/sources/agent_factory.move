/// Module: agent_factory
/// Convenience factory for creating vaults linked to agents and strategies
/// in a single transaction.
module vaultmind::agent_factory {
    use std::string::String;
    use sui::clock::Clock;
    use sui::event;

    // ========== Events ==========
    public struct AgentVaultDeployed has copy, drop {
        agent_id: u64,
        strategy_id: u64,
        vault_id: u64,
        deployer: address,
    }

    // ========== Deploy Full Agent Stack ==========
    /// One-tx deployment: register strategy + agent + create vault
    public fun deploy_agent_vault(
        strategy_registry: &mut vaultmind::strategy::StrategyRegistry,
        agent_registry: &mut vaultmind::agent::AgentRegistry,
        vault_registry: &mut vaultmind::vault::VaultRegistry,
        // Strategy params
        strategy_name: String,
        strategy_desc: String,
        category: u8,
        walrus_config_id: String,
        walrus_backtest_id: String,
        walrus_code_id: String,
        risk_score: u8,
        sharpe_bps: u64,
        max_dd_bps: u64,
        backtest_days: u64,
        // Agent params
        agent_name: String,
        agent_desc: String,
        agent_endpoint: String,
        walrus_memory_id: String,
        // Vault params
        performance_fee_bps: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // 1. Register strategy
        let _strategy = vaultmind::strategy::register_strategy(
            strategy_registry,
            strategy_name,
            strategy_desc,
            category,
            walrus_config_id,
            walrus_backtest_id,
            walrus_code_id,
            risk_score,
            sharpe_bps,
            max_dd_bps,
            backtest_days,
            clock,
            ctx,
        );
        // Note: strategy is transferred to the caller (not shared)

        // 2. Register agent
        let _agent = vaultmind::agent::register_agent(
            agent_registry,
            agent_name,
            agent_desc,
            agent_endpoint,
            walrus_memory_id,
            clock,
            ctx,
        );

        // 3. Create vault linked to strategy
        vaultmind::vault::create_vault(
            vault_registry,
            walrus_config_id,
            agent_name,
            performance_fee_bps,
            ctx,
        );

        event::emit(AgentVaultDeployed {
            agent_id: 0,
            strategy_id: 0,
            vault_id: 0,
            deployer: ctx.sender(),
        });
    }
}