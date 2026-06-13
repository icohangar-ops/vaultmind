/// Module: strategy
/// Strategy registry — developers register AI trading strategies, link to
/// Walrus-stored config/backtests, and earn performance fees.
module vaultmind::strategy {
    use std::string::{Self, String};
    use sui::clock::Clock;
    use sui::event;
    use sui::transfer;

    const ENotAuthorized: u64 = 0;
    const EInvalidScore: u64 = 2;

    // ========== Shared Objects ==========
    public struct StrategyRegistry has key {
        id: UID,
        strategy_count: u64,
    }

    public struct Strategy has key, store {
        id: UID,
        strategy_id: u64,
        creator: address,
        name: String,
        description: String,
        category: u8,              // 0=DeFi, 1=Arb, 2=MarketMaking, 3=Yield, 4=LiquidStaking
        walrus_config_id: String,  // Walrus blob ID for full strategy config
        walrus_backtest_id: String,// Walrus blob ID for backtest results
        walrus_code_id: String,    // Walrus blob ID for agent code
        risk_score: u8,            // 1-10
        sharpe_ratio_bps: u64,     // Sharpe * 100
        max_drawdown_bps: u64,     // Max DD in bps
        backtest_period_days: u64,
        total_vaults: u64,
        total_aum: u64,
        is_active: bool,
        created_at: u64,
        updated_at: u64,
    }

    // ========== Events ==========
    public struct StrategyRegistered has copy, drop {
        strategy_id: u64,
        creator: address,
        name: String,
        walrus_config_id: String,
    }

    public struct StrategyUpdated has copy, drop {
        strategy_id: u64,
        field: String,
        walrus_id: String,
    }

    public struct StrategyDeactivated has copy, drop {
        strategy_id: u64,
        creator: address,
    }

    // ========== Init ==========
    fun init(ctx: &mut TxContext) {
        let registry = StrategyRegistry {
            id: object::new(ctx),
            strategy_count: 0,
        };
        transfer::share_object(registry);
    }

    // ========== Register Strategy ==========
    public fun register_strategy(
        registry: &mut StrategyRegistry,
        name: String,
        description: String,
        category: u8,
        walrus_config_id: String,
        walrus_backtest_id: String,
        walrus_code_id: String,
        risk_score: u8,
        sharpe_ratio_bps: u64,
        max_drawdown_bps: u64,
        backtest_period_days: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Strategy {
        assert!(risk_score >= 1 && risk_score <= 10, EInvalidScore);

        let strategy_id = registry.strategy_count;
        registry.strategy_count = strategy_id + 1;

        let now = clock.timestamp_ms();

        let strategy = Strategy {
            id: object::new(ctx),
            strategy_id,
            creator: ctx.sender(),
            name,
            description,
            category,
            walrus_config_id,
            walrus_backtest_id,
            walrus_code_id,
            risk_score,
            sharpe_ratio_bps,
            max_drawdown_bps,
            backtest_period_days,
            total_vaults: 0,
            total_aum: 0,
            is_active: true,
            created_at: now,
            updated_at: now,
        };

        event::emit(StrategyRegistered {
            strategy_id,
            creator: ctx.sender(),
            name: strategy.name,
            walrus_config_id: strategy.walrus_config_id,
        });

        strategy
    }

    // ========== Update Strategy Files ==========
    public fun update_strategy_files(
        strategy: &mut Strategy,
        walrus_config_id: String,
        walrus_backtest_id: String,
        walrus_code_id: String,
        clock: &Clock,
    ) {
        strategy.walrus_config_id = walrus_config_id;
        strategy.walrus_backtest_id = walrus_backtest_id;
        strategy.walrus_code_id = walrus_code_id;
        strategy.updated_at = clock.timestamp_ms();

        event::emit(StrategyUpdated {
            strategy_id: strategy.strategy_id,
            field: string::utf8(b"files"),
            walrus_id: walrus_config_id,
        });
    }

    // ========== Update Metrics ==========
    public fun update_metrics(
        strategy: &mut Strategy,
        sharpe_ratio_bps: u64,
        max_drawdown_bps: u64,
        total_vaults: u64,
        total_aum: u64,
        clock: &Clock,
    ) {
        strategy.sharpe_ratio_bps = sharpe_ratio_bps;
        strategy.max_drawdown_bps = max_drawdown_bps;
        strategy.total_vaults = total_vaults;
        strategy.total_aum = total_aum;
        strategy.updated_at = clock.timestamp_ms();
    }

    // ========== Deactivate ==========
    public fun deactivate(strategy: &mut Strategy, ctx: &TxContext) {
        assert!(strategy.creator == ctx.sender(), ENotAuthorized);
        strategy.is_active = false;

        event::emit(StrategyDeactivated {
            strategy_id: strategy.strategy_id,
            creator: ctx.sender(),
        });
    }

    // ========== View Functions ==========
    public fun name(s: &Strategy): &String { &s.name }
    public fun description(s: &Strategy): &String { &s.description }
    public fun category(s: &Strategy): u8 { s.category }
    public fun risk_score(s: &Strategy): u8 { s.risk_score }
    public fun sharpe_ratio_bps(s: &Strategy): u64 { s.sharpe_ratio_bps }
    public fun max_drawdown_bps(s: &Strategy): u64 { s.max_drawdown_bps }
    public fun is_active(s: &Strategy): bool { s.is_active }
    public fun total_aum(s: &Strategy): u64 { s.total_aum }
    public fun total_vaults(s: &Strategy): u64 { s.total_vaults }
    public fun walrus_config_id(s: &Strategy): &String { &s.walrus_config_id }
    public fun walrus_backtest_id(s: &Strategy): &String { &s.walrus_backtest_id }
    public fun walrus_code_id(s: &Strategy): &String { &s.walrus_code_id }

    // Category name helper
    public fun category_name(cat: u8): String {
        if (cat == 0) { string::utf8(b"DeFi Yield") }
        else if (cat == 1) { string::utf8(b"Arbitrage") }
        else if (cat == 2) { string::utf8(b"Market Making") }
        else if (cat == 3) { string::utf8(b"Yield Farming") }
        else if (cat == 4) { string::utf8(b"Liquid Staking") }
        else { string::utf8(b"Other") }
    }
}