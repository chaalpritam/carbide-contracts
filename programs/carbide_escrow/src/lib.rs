//! Carbide payment escrow.
//!
//! Each storage deal gets its own EscrowAccount PDA plus a vault token
//! account it controls. The client deposits the full deal amount up
//! front; an authorised verifier co-signs each periodic release after a
//! valid proof-of-storage. Either party can raise a dispute, after which
//! the admin splits the remaining balance.
//!
//! Layout:
//! - EscrowConfig (singleton PDA, seeds = [b"config"])
//!     admin keypair, mutable list of authorised verifier pubkeys
//! - VerifierRecord (PDA, seeds = [b"verifier", verifier_key])
//!     existence == authorised; closed by admin to revoke
//! - EscrowAccount (PDA, seeds = [b"escrow", client, provider, nonce_le])
//!     deal state + reference to its vault token account
//! - Vault token account (ATA owned by the EscrowAccount PDA)
//!     holds the deposited SPL tokens until released or refunded

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("FQLdMfgTtio51EiWmNC444BmVfAtG9DAdWp8dLeCycgZ");

#[program]
pub mod carbide_escrow {
    use super::*;

    /// One-time setup: create the singleton EscrowConfig PDA, claim
    /// `admin` as its administrator. Subsequent admin changes go
    /// through `transfer_admin`.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Hand the admin role to a new pubkey. Caller must be the current
    /// admin (enforced by `has_one`).
    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    /// Whitelist a verifier. Creates a marker PDA whose presence the
    /// release flow checks; closing the PDA later revokes the verifier.
    pub fn add_verifier(ctx: Context<AddVerifier>) -> Result<()> {
        let record = &mut ctx.accounts.verifier_record;
        record.authority = ctx.accounts.verifier.key();
        record.bump = ctx.bumps.verifier_record;
        Ok(())
    }

    /// Revoke a previously authorised verifier by closing its marker PDA.
    pub fn remove_verifier(_ctx: Context<RemoveVerifier>) -> Result<()> {
        Ok(())
    }

    /// Open an escrow and pull `total_amount` SPL tokens from the
    /// client's ATA into a vault owned by the EscrowAccount PDA.
    /// `nonce` lets the same client/provider pair run multiple
    /// concurrent deals.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        nonce: u64,
        total_amount: u64,
        total_periods: u32,
    ) -> Result<()> {
        require!(total_amount > 0, EscrowError::ZeroAmount);
        require!(total_periods > 0, EscrowError::ZeroPeriods);

        let escrow = &mut ctx.accounts.escrow;
        escrow.client = ctx.accounts.client.key();
        escrow.provider = ctx.accounts.provider.key();
        escrow.token_mint = ctx.accounts.token_mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.total_amount = total_amount;
        escrow.released_amount = 0;
        escrow.total_periods = total_periods;
        escrow.periods_released = 0;
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow.active = true;
        escrow.disputed = false;
        escrow.nonce = nonce;
        escrow.bump = ctx.bumps.escrow;

        let cpi_accounts = Transfer {
            from: ctx.accounts.client_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.client.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            total_amount,
        )?;

        emit!(EscrowCreated {
            escrow: escrow.key(),
            client: escrow.client,
            provider: escrow.provider,
            total_amount,
            total_periods,
        });
        Ok(())
    }

    /// Release one period's slice to the provider. Requires both the
    /// provider's signature (so a verifier alone can't drain funds) and
    /// an authorised verifier's signature (proof attestation lives off
    /// chain — the verifier signs after checking it).
    pub fn release_payment(
        ctx: Context<ReleasePayment>,
        period: u32,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.active, EscrowError::EscrowInactive);
        require!(!escrow.disputed, EscrowError::EscrowDisputed);
        require!(
            period == escrow.periods_released + 1,
            EscrowError::WrongPeriod
        );
        require!(
            escrow.periods_released < escrow.total_periods,
            EscrowError::AllPeriodsReleased
        );

        // Equal slices; the final period absorbs any rounding remainder.
        let amount = if period == escrow.total_periods {
            escrow
                .total_amount
                .checked_sub(escrow.released_amount)
                .ok_or(EscrowError::MathOverflow)?
        } else {
            escrow.total_amount / escrow.total_periods as u64
        };

        let client = escrow.client;
        let provider = escrow.provider;
        let nonce_bytes = escrow.nonce.to_le_bytes();
        let bump = escrow.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            client.as_ref(),
            provider.as_ref(),
            nonce_bytes.as_ref(),
            &[bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.provider_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            ),
            amount,
        )?;

        escrow.released_amount = escrow
            .released_amount
            .checked_add(amount)
            .ok_or(EscrowError::MathOverflow)?;
        escrow.periods_released = period;

        let escrow_key = escrow.key();
        emit!(PaymentReleased {
            escrow: escrow_key,
            period,
            amount,
            proof_hash,
        });

        if escrow.periods_released == escrow.total_periods {
            escrow.active = false;
            emit!(EscrowCompleted { escrow: escrow_key });
        }
        Ok(())
    }

    /// Client-initiated cancellation while no dispute is open. Refunds
    /// the unreleased balance and closes the escrow.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.active, EscrowError::EscrowInactive);
        require!(!escrow.disputed, EscrowError::EscrowDisputed);

        let refund = escrow
            .total_amount
            .checked_sub(escrow.released_amount)
            .ok_or(EscrowError::MathOverflow)?;

        if refund > 0 {
            let client = escrow.client;
            let provider = escrow.provider;
            let nonce_bytes = escrow.nonce.to_le_bytes();
            let bump = escrow.bump;
            let signer_seeds: &[&[&[u8]]] = &[&[
                b"escrow",
                client.as_ref(),
                provider.as_ref(),
                nonce_bytes.as_ref(),
                &[bump],
            ]];
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.client_token_account.to_account_info(),
                authority: escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                refund,
            )?;
        }

        escrow.active = false;
        let escrow_key = escrow.key();
        emit!(EscrowCancelled {
            escrow: escrow_key,
            refunded: refund,
        });
        Ok(())
    }

    /// Either party flags the escrow as disputed; release / cancel are
    /// frozen until the admin resolves it.
    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.active, EscrowError::EscrowInactive);
        require!(!escrow.disputed, EscrowError::EscrowDisputed);

        let signer = ctx.accounts.disputer.key();
        require!(
            signer == escrow.client || signer == escrow.provider,
            EscrowError::Unauthorized
        );

        escrow.disputed = true;
        emit!(EscrowDisputed {
            escrow: escrow.key(),
            disputer: signer,
        });
        Ok(())
    }

    /// Admin-only: split the remaining vault balance between provider
    /// and client. The two amounts must sum to exactly the balance left.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        provider_amount: u64,
        client_amount: u64,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.disputed, EscrowError::NotDisputed);

        let remaining = escrow
            .total_amount
            .checked_sub(escrow.released_amount)
            .ok_or(EscrowError::MathOverflow)?;
        let split = provider_amount
            .checked_add(client_amount)
            .ok_or(EscrowError::MathOverflow)?;
        require!(split == remaining, EscrowError::SplitMismatch);

        let client = escrow.client;
        let provider = escrow.provider;
        let nonce_bytes = escrow.nonce.to_le_bytes();
        let bump = escrow.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            client.as_ref(),
            provider.as_ref(),
            nonce_bytes.as_ref(),
            &[bump],
        ]];

        if provider_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.provider_token_account.to_account_info(),
                authority: escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                provider_amount,
            )?;
        }
        if client_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.client_token_account.to_account_info(),
                authority: escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                client_amount,
            )?;
        }

        escrow.released_amount = escrow
            .released_amount
            .checked_add(provider_amount)
            .ok_or(EscrowError::MathOverflow)?;
        escrow.active = false;
        escrow.disputed = false;
        emit!(DisputeResolved {
            escrow: escrow.key(),
            provider_amount,
            client_amount,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + EscrowConfig::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, EscrowConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, EscrowConfig>,
}

#[derive(Accounts)]
pub struct AddVerifier<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, EscrowConfig>,
    /// CHECK: pubkey we are whitelisting; never deserialised.
    pub verifier: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + VerifierRecord::INIT_SPACE,
        seeds = [b"verifier", verifier.key().as_ref()],
        bump,
    )]
    pub verifier_record: Account<'info, VerifierRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveVerifier<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, EscrowConfig>,
    /// CHECK: pubkey we are revoking; never deserialised.
    pub verifier: UncheckedAccount<'info>,
    #[account(
        mut,
        close = admin,
        seeds = [b"verifier", verifier.key().as_ref()],
        bump = verifier_record.bump,
    )]
    pub verifier_record: Account<'info, VerifierRecord>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: provider pubkey is recorded; the provider does not need
    /// to sign the escrow open call.
    pub provider: UncheckedAccount<'info>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = client,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", client.key().as_ref(), provider.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(
        init,
        payer = client,
        associated_token::mint = token_mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = client_token_account.owner == client.key() @ EscrowError::Unauthorized,
        constraint = client_token_account.mint == token_mint.key() @ EscrowError::TokenMintMismatch,
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ReleasePayment<'info> {
    pub provider: Signer<'info>,
    pub verifier: Signer<'info>,
    #[account(
        seeds = [b"verifier", verifier.key().as_ref()],
        bump = verifier_record.bump,
        constraint = verifier_record.authority == verifier.key() @ EscrowError::Unauthorized,
    )]
    pub verifier_record: Account<'info, VerifierRecord>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref(), escrow.nonce.to_le_bytes().as_ref()],
        bump = escrow.bump,
        constraint = escrow.provider == provider.key() @ EscrowError::Unauthorized,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(
        mut,
        constraint = vault.key() == escrow.vault @ EscrowError::VaultMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = provider_token_account.owner == provider.key() @ EscrowError::Unauthorized,
        constraint = provider_token_account.mint == escrow.token_mint @ EscrowError::TokenMintMismatch,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    pub client: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref(), escrow.nonce.to_le_bytes().as_ref()],
        bump = escrow.bump,
        constraint = escrow.client == client.key() @ EscrowError::Unauthorized,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(
        mut,
        constraint = vault.key() == escrow.vault @ EscrowError::VaultMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = client_token_account.owner == client.key() @ EscrowError::Unauthorized,
        constraint = client_token_account.mint == escrow.token_mint @ EscrowError::TokenMintMismatch,
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    pub disputer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref(), escrow.nonce.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.client.as_ref(), escrow.provider.as_ref(), escrow.nonce.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(
        mut,
        constraint = vault.key() == escrow.vault @ EscrowError::VaultMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = provider_token_account.owner == escrow.provider @ EscrowError::Unauthorized,
        constraint = provider_token_account.mint == escrow.token_mint @ EscrowError::TokenMintMismatch,
    )]
    pub provider_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = client_token_account.owner == escrow.client @ EscrowError::Unauthorized,
        constraint = client_token_account.mint == escrow.token_mint @ EscrowError::TokenMintMismatch,
    )]
    pub client_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowConfig {
    pub admin: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VerifierRecord {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub client: Pubkey,
    pub provider: Pubkey,
    pub token_mint: Pubkey,
    pub vault: Pubkey,
    pub total_amount: u64,
    pub released_amount: u64,
    pub total_periods: u32,
    pub periods_released: u32,
    pub created_at: i64,
    pub nonce: u64,
    pub active: bool,
    pub disputed: bool,
    pub bump: u8,
}

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub provider: Pubkey,
    pub total_amount: u64,
    pub total_periods: u32,
}

#[event]
pub struct PaymentReleased {
    pub escrow: Pubkey,
    pub period: u32,
    pub amount: u64,
    pub proof_hash: [u8; 32],
}

#[event]
pub struct EscrowCompleted {
    pub escrow: Pubkey,
}

#[event]
pub struct EscrowCancelled {
    pub escrow: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct EscrowDisputed {
    pub escrow: Pubkey,
    pub disputer: Pubkey,
}

#[event]
pub struct DisputeResolved {
    pub escrow: Pubkey,
    pub provider_amount: u64,
    pub client_amount: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("Caller is not authorised for this account")]
    Unauthorized,
    #[msg("Escrow is not active")]
    EscrowInactive,
    #[msg("Escrow is currently disputed")]
    EscrowDisputed,
    #[msg("Escrow is not disputed")]
    NotDisputed,
    #[msg("Vault account does not match the escrow")]
    VaultMismatch,
    #[msg("Token mint does not match")]
    TokenMintMismatch,
    #[msg("Period must increment by exactly one from the last released period")]
    WrongPeriod,
    #[msg("All periods have already been released")]
    AllPeriodsReleased,
    #[msg("Total amount must be greater than zero")]
    ZeroAmount,
    #[msg("Total periods must be greater than zero")]
    ZeroPeriods,
    #[msg("Provider + client split must equal the remaining balance")]
    SplitMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
