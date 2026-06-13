/// Module: vault
/// Core vault contract for VaultMind — AI agent-managed DeFi vaults on Sui.
/// Vaults hold deposits, track shares, distribute performance fees, and
/// link to AI agent strategies stored on Walrus.
module vaultmind::vault {
    use std::string::{Self, String};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock::Clock;
    use sui::event;
    use sui::transfer;
    use sui::object::{Self, ID};

    // ========== Errors ==========
    const ENotAuthorized: u64 = 0;
    const EVaultPaused: u64 = 1;
    const EInsufficientBalance: u64 = 2;
    const EInvalidFeeBps: u64 = 3;
    const EInvalidStrategy: u64 = 4;

    // ========== Shared Objects ==========
    public struct VaultRegistry has key {
        id: UID,
        vault_count: u64,
        protocol_fee_bps: u64,       // e.g. 100 = 1%
        min_deposit: u64,
    }

    public struct Vault has key {
        id: UID,
        vault_id: u64,
        manager: address,
        strategy_walrus_id: String,  // Walrus blob ID for strategy config
        agent_id: String,            // Agent identifier
        total_shares: u64,
        total_deposited: u64,
        performance_fee_bps: u64,    // e.g. 2000 = 20%
        created_at: u64,
        is_paused: bool,
        cumulative_apy_bps: u64,     // Trailing APY in basis points
        rebalance_count: u64,
        balance: Balance<SUI>,       // Actual SUI held by the vault
    }

    public struct VaultShare has key, store {
        id: UID,
        vault_id: u64,
        owner: address,
        shares: u64,
    }

    // ========== Events ==========
    public struct VaultCreated has copy, drop {
        vault_id: u64,
        vault_object_id: ID,
        manager: address,
        strategy_walrus_id: String,
        agent_id: String,
    }

    public struct Deposited has copy, drop {
        vault_id: u64,
        depositor: address,
        amount: u64,
        shares_minted: u64,
    }

    public struct Withdrawn has copy, drop {
        vault_id: u64,
        withdrawer: address,
        amount: u64,
        shares_burned: u64,
    }

    public struct PerformanceRecorded has copy, drop {
        vault_id: u64,
        gross_yield: u64,
        net_yield: u64,
        protocol_fee: u64,
        manager_fee: u64,
    }

    public struct VaultRebalanced has copy, drop {
        vault_id: u64,
        agent_id: String,
        walrus_audit_id: String,
        new_total: u64,
    }

    // ========== Init ==========
    fun init(ctx: &mut TxContext) {
        let registry = VaultRegistry {
            id: object::new(ctx),
            vault_count: 0,
            protocol_fee_bps: 100,  // 1% protocol fee
            min_deposit: 1_000_000, // 0.001 SUI (in MIST)
        };
        transfer::share_object(registry);
        event::emit(VaultCreated {
            vault_id: 0,
            vault_object_id: object::id(&registry),
            manager: ctx.sender(),
            strategy_walrus_id: string::utf8(b"init"),
            agent_id: string::utf8(b"system"),
        });
    }

    // ========== Vault Creation ==========
    public fun create_vault(
        registry: &mut VaultRegistry,
        strategy_walrus_id: String,
        agent_id: String,
        performance_fee_bps: u64,
        ctx: &mut TxContext,
    ) {
        assert!(performance_fee_bps <= 5000, EInvalidFeeBps); // max 50%
        assert!(!string::is_empty(&strategy_walrus_id), EInvalidStrategy);
        assert!(!string::is_empty(&agent_id), EInvalidStrategy);

        let vault_id = registry.vault_count;
        registry.vault_count = vault_id + 1;

        let vault = Vault {
            id: object::new(ctx),
            vault_id,
            manager: ctx.sender(),
            strategy_walrus_id,
            agent_id,
            total_shares: 0,
            total_deposited: 0,
            performance_fee_bps,
            created_at: 0,
            is_paused: false,
            cumulative_apy_bps: 0,
            rebalance_count: 0,
            balance: balance::zero(),
        };

        transfer::share_object(vault);

        event::emit(VaultCreated {
            vault_id,
            vault_object_id: object::id(&vault),
            manager: ctx.sender(),
            strategy_walrus_id,
            agent_id,
        });
    }

    // ========== Deposit ==========
    public fun deposit(
        vault: &mut Vault,
        payment: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext,
    ): VaultShare {
        assert!(!vault.is_paused, EVaultPaused);
        let amount = coin::value(&payment);
        assert!(amount > 0, EInsufficientBalance);

        // Calculate shares: if first deposit, 1:1 ratio. Otherwise proportional.
        let shares = if (vault.total_shares == 0) {
            amount
        } else {
            let val = (amount as u128) * (vault.total_shares as u128) / (vault.total_deposited as u128);
            (val as u64)
        };

        // Add coin to vault balance
        let payment_balance = coin::into_balance(payment);
        vault.balance = balance::join(vault.balance, payment_balance);

        vault.total_shares = vault.total_shares + shares;
        vault.total_deposited = vault.total_deposited + amount;

        let share = VaultShare {
            id: object::new(ctx),
            vault_id: vault.vault_id,
            owner: ctx.sender(),
            shares,
        };

        // Set created_at on first deposit
        if (vault.created_at == 0) {
            vault.created_at = clock.timestamp_ms();
        };

        event::emit(Deposited {
            vault_id: vault.vault_id,
            depositor: ctx.sender(),
            amount,
            shares_minted: shares,
        });

        share
    }

    // ========== Withdraw ==========
    public fun withdraw(
        vault: &mut Vault,
        share: VaultShare,
        ctx: &mut TxContext,
    ): Coin<SUI> {
        assert!(!vault.is_paused, EVaultPaused);
        assert!(share.owner == ctx.sender(), ENotAuthorized);

        let shares = share.shares;
        let amount = ((shares as u128) * (vault.total_deposited as u128) / (vault.total_shares as u128) as u64);

        vault.total_shares = vault.total_shares - shares;
        vault.total_deposited = vault.total_deposited - amount;

        // Destroy share object
        let VaultShare { id, vault_id: _, owner: _, shares: _ } = share;
        object::delete(id);

        // Withdraw from vault balance
        let withdrawn_balance = balance::withdraw(&mut vault.balance, amount);
        let withdrawal = coin::from_balance(withdrawn_balance, ctx);

        event::emit(Withdrawn {
            vault_id: vault.vault_id,
            withdrawer: ctx.sender(),
            amount,
            shares_burned: shares,
        });

        withdrawal
    }

    // ========== Record Performance (called by agent) ==========
    public fun record_performance(
        vault: &mut Vault,
        gross_yield_bps: u64,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == vault.manager, ENotAuthorized);

        let protocol_fee = ((gross_yield_bps as u128) * (100u128)) / 10000u128; // 1% protocol
        let manager_fee = ((gross_yield_bps as u128) * (vault.performance_fee_bps as u128)) / 10000u128;
        let net_yield = gross_yield_bps - (protocol_fee as u64) - (manager_fee as u64);

        // Update trailing APY (simple moving average)
        vault.cumulative_apy_bps = (vault.cumulative_apy_bps * 9 + net_yield) / 10;

        event::emit(PerformanceRecorded {
            vault_id: vault.vault_id,
            gross_yield: gross_yield_bps,
            net_yield,
            protocol_fee: protocol_fee as u64,
            manager_fee: manager_fee as u64,
        });
    }

    // ========== Record Rebalance (called by agent after Walrus audit) ==========
    public fun record_rebalance(
        vault: &mut Vault,
        walrus_audit_id: String,
        new_total: u64,
    ) {
        // Anyone can trigger a rebalance record (agent or monitor)
        vault.total_deposited = new_total;
        vault.rebalance_count = vault.rebalance_count + 1;

        event::emit(VaultRebalanced {
            vault_id: vault.vault_id,
            agent_id: vault.agent_id,
            walrus_audit_id,
            new_total,
        });
    }

    // ========== Admin ==========
    public fun pause_vault(vault: &mut Vault, ctx: &TxContext) {
        assert!(ctx.sender() == vault.manager, ENotAuthorized);
        vault.is_paused = true;
    }

    public fun unpause_vault(vault: &mut Vault, ctx: &TxContext) {
        assert!(ctx.sender() == vault.manager, ENotAuthorized);
        vault.is_paused = false;
    }

    // ========== View Functions ==========
    public fun vault_id(vault: &Vault): u64 { vault.vault_id }
    public fun total_deposited(vault: &Vault): u64 { vault.total_deposited }
    public fun total_shares(vault: &Vault): u64 { vault.total_shares }
    public fun is_paused(vault: &Vault): bool { vault.is_paused }
    public fun performance_fee_bps(vault: &Vault): u64 { vault.performance_fee_bps }
    public fun cumulative_apy_bps(vault: &Vault): u64 { vault.cumulative_apy_bps }
    public fun rebalance_count(vault: &Vault): u64 { vault.rebalance_count }
    public fun share_value(vault: &Vault): u128 {
        if (vault.total_shares == 0) { 1000000 } // 1:1
        else { (vault.total_deposited as u128) * 1000000 / (vault.total_shares as u128) }
    }
    public fun vault_balance(vault: &Vault): u64 { balance::value(&vault.balance) }
}