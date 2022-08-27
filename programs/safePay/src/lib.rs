use anchor_lang::prelude::*;
use anchor_spl::{token::{CloseAccount, Mint, Token, TokenAccount, Transfer}};

declare_id!("Fag2pgEsmMrDmGYdAE9rmyqerkVaUR8yrafGHfZzkwLb");

// 
/// A small utility function that allows us to transfer funds out of the Escrow.
///
/// # Arguments
///
/// * `user_sending` - Alice's account
/// * `user_sending` - Bob's account
/// * `mint_of_token_being_sent` - The mint of the token being held in escrow
/// * `escrow_wallet` - The escrow Token account
/// * `application_idx` - The primary key (timestamp) of the instance
/// * `state` - the application state public key (PDA)
/// * `state_bump` - the application state public key (PDA) bump
/// * `token_program` - the token program address
/// * `destination_wallet` - The public key of the destination address (where to send funds)
/// * `amount` - the amount of `mint_of_token_being_sent` that is sent from `escrow_wallet` to `destination_wallet`
///
fn transfer_escrow_out<'info>(
    user_sending: AccountInfo<'info>,
    user_receiving: AccountInfo<'info>,
    mint_of_token_being_sent: AccountInfo<'info>,
    escrow_wallet: &mut Account<'info, TokenAccount>,
    state: AccountInfo<'info>,
    state_bump: u8,
    token_program: AccountInfo<'info>,
    destination_wallet: AccountInfo<'info>,
    amount: u64
) -> Result<()> {

    // Nothing interesting here! just boilerplate to compute our signer seeds for
    // signing on behalf of our PDA.
    let bump_vector = state_bump.to_le_bytes();
    let mint_of_token_being_sent_pk = mint_of_token_being_sent.key().clone();
    let inner = vec![
        b"safe_pay_noah_state".as_ref(),
        user_sending.key.as_ref(),
        user_receiving.key.as_ref(),
        mint_of_token_being_sent_pk.as_ref(), 
        bump_vector.as_ref(),
    ];
    let outer = vec![inner.as_slice()];

    msg!("Destination wallet {}", destination_wallet.is_writable);

    // Perform the actual transfer
    let transfer_instruction = Transfer{
        from: escrow_wallet.to_account_info(),
        to: destination_wallet,
        authority: state.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        token_program.to_account_info(),
        transfer_instruction,
        outer.as_slice(),
    );
    anchor_spl::token::transfer(cpi_ctx, amount)?;


    // Use the `reload()` function on an account to reload it's state. Since we performed the
    // transfer, we are expecting the `amount` field to have changed.
    let should_close = {
        escrow_wallet.reload()?;
        escrow_wallet.amount == 0
    };

    // If token account has no more tokens, it should be wiped out since it has no other use case.
    if should_close {
        let ca = CloseAccount{
            account: escrow_wallet.to_account_info(),
            destination: user_sending.to_account_info(),
            authority: state.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            ca,
            outer.as_slice(),
        );
        anchor_spl::token::close_account(cpi_ctx)?;
    }

    Ok(())
}

#[program]
pub mod safe_pay {
    use super::*;

    pub fn initiate(ctx: Context<Initiate>, amount: u64, application_state_bump: u8, escrow_wallet_state_bump: u8) -> Result<()> {
        // Set the state attributes
        let state = &mut ctx.accounts.application_state;
        state.user_sending = ctx.accounts.user_sending.key().clone();
        state.user_receiving = ctx.accounts.user_receiving.key().clone();
        state.mint_of_token_being_sent = ctx.accounts.mint_of_token_being_sent.key().clone();
        state.escrow_wallet = ctx.accounts.escrow_wallet_state.key().clone();
        state.amount_tokens = amount;
        state.application_state_bump = application_state_bump;
        state.escrow_wallet_state_bump = escrow_wallet_state_bump;

        // Nothing interesting here! just boilerplate to compute our signer seeds for
        // signing on behalf of our PDA.
        let bump_vector = &[state.application_state_bump][..];
        let mint_of_token_being_sent_pk = ctx.accounts.mint_of_token_being_sent.key().clone();
        let inner = vec![
            b"safe_pay_noah_state".as_ref(),
            ctx.accounts.user_sending.key.as_ref(),
            ctx.accounts.user_receiving.key.as_ref(),
            mint_of_token_being_sent_pk.as_ref(), 
            bump_vector.as_ref(),
        ];
        let outer = vec![inner.as_slice()];

        // Below is the actual instruction that we are going to send to the Token program.
        let transfer_instruction = Transfer{
            from: ctx.accounts.wallet_to_withdraw_from.to_account_info(),
            to: ctx.accounts.escrow_wallet_state.to_account_info(),
            authority: ctx.accounts.user_sending.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
            outer.as_slice(),
        );

        anchor_spl::token::transfer(cpi_ctx, state.amount_tokens)?;

        Ok(())
    }

    pub fn pull_back(ctx: Context<PullBackInstruction>) -> Result<()> {
        let wallet_amount = ctx.accounts.escrow_wallet_state.amount;
        transfer_escrow_out(
            ctx.accounts.user_sending.to_account_info(),
            ctx.accounts.user_receiving.to_account_info(),
            ctx.accounts.mint_of_token_being_sent.to_account_info(),
            &mut ctx.accounts.escrow_wallet_state,
            ctx.accounts.application_state.to_account_info(),
            ctx.accounts.application_state.application_state_bump,
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.refund_wallet.to_account_info(),
            wallet_amount,
        )
    }

    pub fn complete_grant(ctx: Context<CompleteGrant>) -> Result<()> {
        let wallet_amount = ctx.accounts.escrow_wallet_state.amount;
        transfer_escrow_out(
            ctx.accounts.user_sending.to_account_info(),
            ctx.accounts.user_receiving.to_account_info(),
            ctx.accounts.mint_of_token_being_sent.to_account_info(),
            &mut ctx.accounts.escrow_wallet_state,
            ctx.accounts.application_state.to_account_info(),
            ctx.accounts.application_state.application_state_bump,
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.wallet_to_deposit_to.to_account_info(),
            wallet_amount
        )
    }
}

#[derive(Accounts)]
pub struct Initiate<'info> {
    // Derived PDAs
    #[account(
        init,
        space = 1000,
        payer = user_sending,
        seeds=[b"safe_pay_noah_state".as_ref(), user_sending.key().as_ref(), user_receiving.key.as_ref(), mint_of_token_being_sent.key().as_ref()],
        bump,
    )]
    application_state: Account<'info, State>,
    #[account(
        init,
        payer = user_sending,
        seeds=[b"safe_pay_noah_wallet".as_ref(), user_sending.key().as_ref(), user_receiving.key.as_ref(), mint_of_token_being_sent.key().as_ref()],
        bump,
        token::mint=mint_of_token_being_sent,
        token::authority=application_state,
    )]
    escrow_wallet_state: Account<'info, TokenAccount>,

    // Users and accounts in the system
    #[account(mut)]
    user_sending: Signer<'info>,  // Alice
    /// CHECK: unsafe 
    user_receiving: AccountInfo<'info>,              // Bob
    mint_of_token_being_sent: Account<'info, Mint>,  // USDC

    // Alice's USDC wallet that has already approved the escrow wallet
    #[account(
        mut,
        constraint=wallet_to_withdraw_from.owner == user_sending.key(),
        constraint=wallet_to_withdraw_from.mint == mint_of_token_being_sent.key()
    )]
    wallet_to_withdraw_from: Account<'info, TokenAccount>,

    // Application level accounts
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>
}

#[derive(Accounts)]
pub struct PullBackInstruction<'info> {
    #[account(
        mut,
        seeds=[b"safe_pay_noah_state".as_ref(), user_sending.key().as_ref(), user_receiving.key.as_ref(), mint_of_token_being_sent.key().as_ref()],
        bump = application_state.application_state_bump,
        has_one = user_sending,
        has_one = user_receiving,
        has_one = mint_of_token_being_sent,
    )]
    application_state: Account<'info, State>,
    #[account(
        mut,
        seeds=[b"safe_pay_noah_wallet".as_ref(), user_sending.key().as_ref(), user_receiving.key.as_ref(), mint_of_token_being_sent.key().as_ref()],
        bump = application_state.escrow_wallet_state_bump,
    )]
    escrow_wallet_state: Account<'info, TokenAccount>,    
    // Users and accounts in the system
    #[account(mut)]
    user_sending: Signer<'info>,
    /// CHECK: unsafe
    user_receiving: AccountInfo<'info>,
    mint_of_token_being_sent: Account<'info, Mint>,

    // Application level accounts
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>,

    // Wallet to deposit to
    #[account(
        mut,
        constraint=refund_wallet.owner == user_sending.key(),
        constraint=refund_wallet.mint == mint_of_token_being_sent.key()
    )]
    refund_wallet: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct CompleteGrant<'info> {
    #[account(
        mut,
        seeds=[b"safe_pay_noah_state".as_ref(), user_sending.key().as_ref(), user_receiving.key.as_ref(), mint_of_token_being_sent.key().as_ref()],
        bump = application_state.application_state_bump,
        has_one = user_sending,
        has_one = user_receiving,
        has_one = mint_of_token_being_sent,
    )]
    application_state: Account<'info, State>,
    #[account(
        mut,
        seeds=[b"safe_pay_noah_wallet".as_ref(), user_sending.key().as_ref(), user_receiving.key.as_ref(), mint_of_token_being_sent.key().as_ref()],
        bump = application_state.escrow_wallet_state_bump,
    )]
    escrow_wallet_state: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_of_token_being_sent,
        associated_token::authority = user_receiving,
    )]
    wallet_to_deposit_to: Account<'info, TokenAccount>,   // Bob's USDC wallet

    // Users and accounts in the system
    /// CHECK: unsafe
    #[account(mut)]
    user_sending: AccountInfo<'info>,                     // Alice
    #[account(mut)]
    user_receiving: Signer<'info>,                        // Bob
    mint_of_token_being_sent: Account<'info, Mint>,       // USDC

    // Application level accounts
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>,
}

#[account]
pub struct State {
    // Alice
    user_sending: Pubkey,

    // Bob
    user_receiving: Pubkey,

    // The Mint of the token that Alice wants to send to Bob
    mint_of_token_being_sent: Pubkey,

    // The escrow wallet
    escrow_wallet: Pubkey,

    // The amount of tokens Alice wants to send to Bob
    amount_tokens: u64,

    // Bumps
    application_state_bump: u8,
    escrow_wallet_state_bump: u8
}