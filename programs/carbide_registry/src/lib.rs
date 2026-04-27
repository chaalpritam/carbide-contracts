//! Carbide on-chain provider registry.
//!
//! One PDA per provider, seeded by the provider's signing pubkey. Anyone
//! can self-register; registration is permissionless. The indexer in the
//! discovery service mirrors these accounts via account-change subscriptions
//! plus emitted events. Treat the chain as authoritative — the discovery
//! service is just a fast read cache.

use anchor_lang::prelude::*;

declare_id!("5rAsbS4ApXNyNqrSUXqC7ju24kpEudHxfU1Q5khmAZHD");

pub const ENDPOINT_MAX_LEN: usize = 128;
pub const REGION_MAX_LEN: usize = 32;

#[program]
pub mod carbide_registry {
    use super::*;

    /// Self-register the signing wallet as a provider. Fails if the
    /// provider already has an entry — use `update` instead.
    pub fn register(
        ctx: Context<Register>,
        endpoint: String,
        region: String,
        tier: u8,
        capacity_gb: u64,
        price_per_gb_month: u64,
    ) -> Result<()> {
        validate_inputs(&endpoint, &region, tier, capacity_gb)?;

        let now = Clock::get()?.unix_timestamp;
        let provider = &mut ctx.accounts.provider;
        provider.owner = ctx.accounts.owner.key();
        provider.endpoint = endpoint.clone();
        provider.region = region.clone();
        provider.tier = tier;
        provider.capacity_gb = capacity_gb;
        provider.price_per_gb_month = price_per_gb_month;
        provider.registered_at = now;
        provider.updated_at = now;
        provider.active = true;
        provider.bump = ctx.bumps.provider;

        emit!(ProviderRegistered {
            owner: provider.owner,
            endpoint,
            region,
            tier,
            capacity_gb,
            price_per_gb_month,
        });
        Ok(())
    }

    /// Refresh the provider's advertised attributes. Only the original
    /// owner can update; verified by the PDA seeds matching `owner`.
    pub fn update(
        ctx: Context<Update>,
        endpoint: String,
        region: String,
        tier: u8,
        capacity_gb: u64,
        price_per_gb_month: u64,
    ) -> Result<()> {
        validate_inputs(&endpoint, &region, tier, capacity_gb)?;

        let provider = &mut ctx.accounts.provider;
        provider.endpoint = endpoint.clone();
        provider.region = region.clone();
        provider.tier = tier;
        provider.capacity_gb = capacity_gb;
        provider.price_per_gb_month = price_per_gb_month;
        provider.updated_at = Clock::get()?.unix_timestamp;

        emit!(ProviderUpdated {
            owner: provider.owner,
            endpoint,
            region,
            tier,
            capacity_gb,
            price_per_gb_month,
        });
        Ok(())
    }

    /// Toggle the active flag. Inactive providers stay in the registry
    /// but should be excluded from client-side selection.
    pub fn set_active(ctx: Context<SetActive>, active: bool) -> Result<()> {
        let provider = &mut ctx.accounts.provider;
        if provider.active == active {
            return Ok(());
        }
        provider.active = active;
        provider.updated_at = Clock::get()?.unix_timestamp;
        emit!(ProviderActiveChanged {
            owner: provider.owner,
            active,
        });
        Ok(())
    }

    /// Close the provider's record and return the rent to the owner.
    pub fn deregister(ctx: Context<Deregister>) -> Result<()> {
        emit!(ProviderDeregistered {
            owner: ctx.accounts.provider.owner,
        });
        Ok(())
    }
}

fn validate_inputs(endpoint: &str, region: &str, tier: u8, capacity_gb: u64) -> Result<()> {
    require!(!endpoint.is_empty(), RegistryError::EmptyEndpoint);
    require!(
        endpoint.len() <= ENDPOINT_MAX_LEN,
        RegistryError::EndpointTooLong
    );
    require!(!region.is_empty(), RegistryError::EmptyRegion);
    require!(region.len() <= REGION_MAX_LEN, RegistryError::RegionTooLong);
    require!(tier <= 3, RegistryError::InvalidTier);
    require!(capacity_gb > 0, RegistryError::ZeroCapacity);
    Ok(())
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + ProviderAccount::INIT_SPACE,
        seeds = [b"provider", owner.key().as_ref()],
        bump,
    )]
    pub provider: Account<'info, ProviderAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"provider", owner.key().as_ref()],
        bump = provider.bump,
        has_one = owner,
    )]
    pub provider: Account<'info, ProviderAccount>,
}

#[derive(Accounts)]
pub struct SetActive<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"provider", owner.key().as_ref()],
        bump = provider.bump,
        has_one = owner,
    )]
    pub provider: Account<'info, ProviderAccount>,
}

#[derive(Accounts)]
pub struct Deregister<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        seeds = [b"provider", owner.key().as_ref()],
        bump = provider.bump,
        has_one = owner,
    )]
    pub provider: Account<'info, ProviderAccount>,
}

#[account]
#[derive(InitSpace)]
pub struct ProviderAccount {
    pub owner: Pubkey,
    #[max_len(ENDPOINT_MAX_LEN)]
    pub endpoint: String,
    #[max_len(REGION_MAX_LEN)]
    pub region: String,
    pub price_per_gb_month: u64,
    pub capacity_gb: u64,
    pub registered_at: i64,
    pub updated_at: i64,
    pub tier: u8,
    pub active: bool,
    pub bump: u8,
}

#[event]
pub struct ProviderRegistered {
    pub owner: Pubkey,
    pub endpoint: String,
    pub region: String,
    pub tier: u8,
    pub capacity_gb: u64,
    pub price_per_gb_month: u64,
}

#[event]
pub struct ProviderUpdated {
    pub owner: Pubkey,
    pub endpoint: String,
    pub region: String,
    pub tier: u8,
    pub capacity_gb: u64,
    pub price_per_gb_month: u64,
}

#[event]
pub struct ProviderActiveChanged {
    pub owner: Pubkey,
    pub active: bool,
}

#[event]
pub struct ProviderDeregistered {
    pub owner: Pubkey,
}

#[error_code]
pub enum RegistryError {
    #[msg("Endpoint must not be empty")]
    EmptyEndpoint,
    #[msg("Endpoint exceeds maximum length")]
    EndpointTooLong,
    #[msg("Region must not be empty")]
    EmptyRegion,
    #[msg("Region exceeds maximum length")]
    RegionTooLong,
    #[msg("Tier must be 0=Home, 1=Professional, 2=Enterprise, or 3=GlobalCDN")]
    InvalidTier,
    #[msg("Capacity must be greater than zero")]
    ZeroCapacity,
}
