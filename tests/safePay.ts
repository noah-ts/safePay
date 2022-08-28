import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { createMint, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, AccountLayout, mintTo, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SafePay } from "../target/types/safe_pay";

interface PDAParameters {
  escrowWalletKey: anchor.web3.PublicKey,
  stateKey: anchor.web3.PublicKey,
  escrowBump: number,
  stateBump: number
}

describe("safePay", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.Provider.env()
  anchor.setProvider(provider);

  const program = anchor.workspace.SafePay as Program<SafePay>;

  let pda: PDAParameters
  let mintAddress: anchor.web3.PublicKey;
  let alice: anchor.web3.Keypair;
  let aliceWallet: anchor.web3.PublicKey;
  let bob: anchor.web3.Keypair;
  let bobWallet: anchor.web3.PublicKey;

  const keypair = anchor.web3.Keypair.generate()

  const getPdaParams = async (connection: anchor.web3.Connection, alice: anchor.web3.PublicKey, bob: anchor.web3.PublicKey, mint: anchor.web3.PublicKey): Promise<PDAParameters> => {
    let [statePubKey, stateBump] = await anchor.web3.PublicKey.findProgramAddress(
        [anchor.utils.bytes.utf8.encode("safe_pay_noah_state"), alice.toBuffer(), bob.toBuffer(), mint.toBuffer()], program.programId,
    );
    let [walletPubKey, walletBump] = await anchor.web3.PublicKey.findProgramAddress(
        [anchor.utils.bytes.utf8.encode("safe_pay_noah_wallet"), alice.toBuffer(), bob.toBuffer(), mint.toBuffer()], program.programId,
    );
    return {
        escrowBump: walletBump,
        escrowWalletKey: walletPubKey,
        stateBump,
        stateKey: statePubKey,
    }
  }

  const customCreateMint = async (connection: anchor.web3.Connection) => {
    // Fund user with some SOL
    let txFund = new anchor.web3.Transaction();
    txFund.add(anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: keypair.publicKey,
        lamports: 5 * anchor.web3.LAMPORTS_PER_SOL,
    }));
    const sigTxFund = await provider.send(txFund);
    console.log(`[${keypair.publicKey.toBase58()}] Funded new account with 5 SOL: ${sigTxFund}`);

    return await createMint(
      connection,
      keypair,
      keypair.publicKey,
      keypair.publicKey,
      9
    )
  }

  const createUserAndAssociatedWallet = async (connection: anchor.web3.Connection, mint: anchor.web3.PublicKey): Promise<[anchor.web3.Keypair, anchor.web3.PublicKey | undefined]> => {
      const user = new anchor.web3.Keypair();

      // Fund user with some SOL
      let txFund = new anchor.web3.Transaction();
      txFund.add(anchor.web3.SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: user.publicKey,
          lamports: 5 * anchor.web3.LAMPORTS_PER_SOL,
      }));
      const sigTxFund = await provider.send(txFund);
      console.log(`[${user.publicKey.toBase58()}] Funded new account with 5 SOL: ${sigTxFund}`);

      let userAssociatedTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        user,
        mint,
        user.publicKey
      )

      try {
        await mintTo(
          connection,
          keypair,
          mint,
          userAssociatedTokenAccount.address,
          keypair,
          1337000000
        )
      } catch (error) {
        console.error('Error minting tokens: ', error)
      }
      return [user, userAssociatedTokenAccount.address];
  }

  beforeEach(async () => {
      try {
        mintAddress = await customCreateMint(provider.connection);
      } catch (error) {
        console.error('Error creating custom mint: ', error)
      }
      [alice, aliceWallet] = await createUserAndAssociatedWallet(provider.connection, mintAddress);
      [bob, bobWallet] = await createUserAndAssociatedWallet(provider.connection, mintAddress);
      pda = await getPdaParams(provider.connection, alice.publicKey, bob.publicKey, mintAddress);
  });

  it("initiate and pull back from escrow", async () => {
    const aliceBefore = await provider.connection.getTokenAccountsByOwner(alice.publicKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Alice's wallet before initiating");
    aliceBefore.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    console.log('Initiate escrow (transfer tokens from Alice to escrow wallet)')
    try {
      const tx = await program.methods
      .initiate(new anchor.BN(20000000), pda.stateBump, pda.escrowBump)
      .accounts({
        walletToWithdrawFrom: aliceWallet,

        applicationState: pda.stateKey,
        escrowWalletState: pda.escrowWalletKey,
        userSending: alice.publicKey,
        userReceiving: bob.publicKey,
        mintOfTokenBeingSent: mintAddress,

        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc()

      console.log("Your transaction signature", tx);
    } catch (error) {
      console.error('Error initiating safe pay: ', error)
    }

    const stateTokenAccounts = await provider.connection.getTokenAccountsByOwner(pda.stateKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Escrow wallet after initiating");
    stateTokenAccounts.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    const aliceAfter = await provider.connection.getTokenAccountsByOwner(alice.publicKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Alice's wallet after initiating");
    aliceAfter.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    console.log('Pullback from escrow (transfer tokens from escrow wallet back to Alice)')
    try {
      const tx = await program.methods
      .pullBack()
      .accounts({
        refundWallet: aliceWallet,

        applicationState: pda.stateKey,
        escrowWalletState: pda.escrowWalletKey,
        userSending: alice.publicKey,
        userReceiving: bob.publicKey,
        mintOfTokenBeingSent: mintAddress,

        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc()

      console.log("Your transaction signature", tx);
    } catch (error) {
      console.error('Error pulling back from escrow: ', error)
    }

    const stateTokenAccountsTwo = await provider.connection.getTokenAccountsByOwner(pda.stateKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Escrow wallet after pulling back");
    stateTokenAccountsTwo.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    const aliceAfterTwo = await provider.connection.getTokenAccountsByOwner(alice.publicKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Alice's wallet after pulling back");
    aliceAfterTwo.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })
  });

  it('initiate and complete escrow', async () => {
    const aliceBefore = await provider.connection.getTokenAccountsByOwner(alice.publicKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Alice's wallet before initiating");
    aliceBefore.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    const bobBefore = await provider.connection.getTokenAccountsByOwner(bob.publicKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Bob's wallet before initiating");
    bobBefore.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    console.log('Initiate escrow (transfer tokens from Alice to escrow wallet)')
    try {
      const tx = await program.methods
      .initiate(new anchor.BN(20000000), pda.stateBump, pda.escrowBump)
      .accounts({
        walletToWithdrawFrom: aliceWallet,

        applicationState: pda.stateKey,
        escrowWalletState: pda.escrowWalletKey,
        userSending: alice.publicKey,
        userReceiving: bob.publicKey,
        mintOfTokenBeingSent: mintAddress,

        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc()

      console.log("Your transaction signature", tx);
    } catch (error) {
      console.error('Error initiating safe pay: ', error)
    }

    const stateTokenAccounts = await provider.connection.getTokenAccountsByOwner(pda.stateKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Escrow wallet after initiating");
    stateTokenAccounts.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    const aliceAfter = await provider.connection.getTokenAccountsByOwner(alice.publicKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Alice's wallet after initiating");
    aliceAfter.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    console.log('Complete grant (transfer tokens from escrow wallet to Bob)')

    try {
      const tx = await program.methods
      .completeGrant()
      .accounts({
        walletToDepositTo: bobWallet,

        applicationState: pda.stateKey,
        escrowWalletState: pda.escrowWalletKey,
        userSending: alice.publicKey,
        userReceiving: bob.publicKey,
        mintOfTokenBeingSent: mintAddress,

        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([bob])
      .rpc()

      console.log("Your transaction signature", tx);
    } catch (error) {
      console.error('Error completing grant: ', error)
    }

    const stateTokenAccountsTwo = await provider.connection.getTokenAccountsByOwner(pda.stateKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Escrow wallet after completing escrow");
    stateTokenAccountsTwo.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    const aliceAfterTwo = await provider.connection.getTokenAccountsByOwner(alice.publicKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Alice's wallet after completing escrow");
    aliceAfterTwo.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    const bobAfter = await provider.connection.getTokenAccountsByOwner(bob.publicKey, { programId: TOKEN_PROGRAM_ID })
    console.log("Bob's wallet after completing escrow");
    bobAfter.value.forEach((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data);
      console.log(`${new anchor.web3.PublicKey(accountData.mint)}   ${accountData.amount}`);
    })

    console.log('Fetching state')
    const state = await program.account.state.fetch(pda.stateKey)
    console.log(state)
  })
});
