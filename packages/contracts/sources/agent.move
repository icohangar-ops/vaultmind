/// Module: agent
/// Agent identity and governance — agents register on-chain, link to
/// off-chain execution infrastructure, and maintain reputation scores.
module vaultmind::agent {
    use std::string::{Self, String};
    use sui::clock::Clock;
    use sui::event;
    use sui::transfer;

    const ENotAuthorized: u64 = 0;

    public struct AgentRegistry has key {
        id: UID,
        agent_count: u64,
    }

    public struct Agent has key, store {
        id: UID,
        agent_id: u64,
        owner: address,
        name: String,
        description: String,
        endpoint: String,           // Off-chain agent execution URL
        walrus_memory_id: String,   // Walrus blob for agent state/memory
        reputation_bps: u64,        // 0-10000 (0-100%)
        total_executions: u64,
        successful_executions: u64,
        failed_executions: u64,
        total_profit_generated: u64,
        total_fees_earned: u64,
        is_active: bool,
        created_at: u64,
        last_execution_at: u64,
    }

    // ========== Events ==========
    public struct AgentRegistered has copy, drop {
        agent_id: u64,
        owner: address,
        name: String,
    }

    public struct AgentExecuted has copy, drop {
        agent_id: u64,
        vault_id: u64,
        success: bool,
        profit_delta: u64,
        walrus_audit_id: String,
    }

    public struct ReputationUpdated has copy, drop {
        agent_id: u64,
        old_reputation: u64,
        new_reputation: u64,
        reason: String,
    }

    // ========== Init ==========
    fun init(ctx: &mut TxContext) {
        let registry = AgentRegistry {
            id: object::new(ctx),
            agent_count: 0,
        };
        transfer::share_object(registry);
    }

    // ========== Register Agent ==========
    public fun register_agent(
        registry: &mut AgentRegistry,
        name: String,
        description: String,
        endpoint: String,
        walrus_memory_id: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Agent {
        let agent_id = registry.agent_count;
        registry.agent_count = agent_id + 1;
        let now = clock.timestamp_ms();

        let agent = Agent {
            id: object::new(ctx),
            agent_id,
            owner: ctx.sender(),
            name,
            description,
            endpoint,
            walrus_memory_id,
            reputation_bps: 5000, // Start at 50%
            total_executions: 0,
            successful_executions: 0,
            failed_executions: 0,
            total_profit_generated: 0,
            total_fees_earned: 0,
            is_active: true,
            created_at: now,
            last_execution_at: 0,
        };

        event::emit(AgentRegistered {
            agent_id,
            owner: ctx.sender(),
            name: agent.name,
        });

        agent
    }

    // ========== Record Execution ==========
    public fun record_execution(
        agent: &mut Agent,
        vault_id: u64,
        success: bool,
        profit_delta: u64,
        walrus_audit_id: String,
        clock: &Clock,
    ) {
        agent.total_executions = agent.total_executions + 1;
        if (success) {
            agent.successful_executions = agent.successful_executions + 1;
            agent.total_profit_generated = agent.total_profit_generated + profit_delta;
        } else {
            agent.failed_executions = agent.failed_executions + 1;
        };
        agent.last_execution_at = clock.timestamp_ms();

        // Auto-adjust reputation
        let old_rep = agent.reputation_bps;
        if (success && (profit_delta > 0)) {
            // Boost reputation by up to 50 bps per good execution
            let boost = if (profit_delta > 1_000_000_000) { 50u64 }
                        else if (profit_delta > 100_000_000) { 25u64 }
                        else { 10u64 };
            agent.reputation_bps = if (agent.reputation_bps + boost > 10000) { 10000 }
                                  else { agent.reputation_bps + boost };
        } else if (!success) {
            // Reduce reputation
            agent.reputation_bps = if (agent.reputation_bps < 100) { 0 }
                                  else { agent.reputation_bps - 100 };
        };

        event::emit(AgentExecuted {
            agent_id: agent.agent_id,
            vault_id,
            success,
            profit_delta,
            walrus_audit_id,
        });

        if (agent.reputation_bps != old_rep) {
            event::emit(ReputationUpdated {
                agent_id: agent.agent_id,
                old_reputation: old_rep,
                new_reputation: agent.reputation_bps,
                reason: if (success) { string::utf8(b"successful_execution") }
                        else { string::utf8(b"failed_execution") },
            });
        }
    }

    // ========== Update Memory ==========
    public fun update_memory(
        agent: &mut Agent,
        walrus_memory_id: String,
        ctx: &TxContext,
    ) {
        assert!(agent.owner == ctx.sender(), ENotAuthorized);
        agent.walrus_memory_id = walrus_memory_id;
    }

    // ========== Deactivate ==========
    public fun deactivate(agent: &mut Agent, ctx: &TxContext) {
        assert!(agent.owner == ctx.sender(), ENotAuthorized);
        agent.is_active = false;
    }

    // ========== View Functions ==========
    public fun name(a: &Agent): &String { &a.name }
    public fun reputation_bps(a: &Agent): u64 { a.reputation_bps }
    public fun success_rate_bps(a: &Agent): u64 {
        if (a.total_executions == 0) { 0 }
        else { ((a.successful_executions as u128) * 10000 / (a.total_executions as u128) as u64) }
    }
    public fun total_profit_generated(a: &Agent): u64 { a.total_profit_generated }
    public fun is_active(a: &Agent): bool { a.is_active }
    public fun total_executions(a: &Agent): u64 { a.total_executions }
}