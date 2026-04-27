import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

import { CarbideEscrow } from "../target/types/carbide_escrow";

describe("carbide_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CarbideEscrow as Program<CarbideEscrow>;

  const admin = Keypair.generate();
  const verifier = Keypair.generate();
  const client = Keypair.generate();
  const providerWallet = Keypair.generate();

  let mint: PublicKey;
  let clientAta: PublicKey;
  let providerAta: PublicKey;

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  )[0];

  const verifierPda = (key: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("verifier"), key.toBuffer()],
      program.programId
    )[0];

  const escrowPda = (clientKey: PublicKey, providerKey: PublicKey, nonce: BN) => {
    const nonceLe = Buffer.alloc(8);
    nonceLe.writeBigUInt64LE(BigInt(nonce.toString()));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), clientKey.toBuffer(), providerKey.toBuffer(), nonceLe],
      program.programId
    )[0];
  };

  before(async () => {
    // Fund the admin/verifier/client/provider wallets.
    for (const kp of [admin, verifier, client, providerWallet]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Deploy a 6-decimal mock USDC mint for tests.
    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    clientAta = await createAssociatedTokenAccount(
      provider.connection,
      client,
      mint,
      client.publicKey
    );
    providerAta = await createAssociatedTokenAccount(
      provider.connection,
      providerWallet,
      mint,
      providerWallet.publicKey
    );

    // Fund client with 100 USDC.
    await mintTo(provider.connection, admin, mint, clientAta, admin, 100_000_000);
  });

  it("initialises config and whitelists a verifier", async () => {
    await program.methods
      .initializeConfig()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    await program.methods
      .addVerifier()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        verifier: verifier.publicKey,
        verifierRecord: verifierPda(verifier.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const cfg = await program.account.escrowConfig.fetch(configPda);
    expect(cfg.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    const rec = await program.account.verifierRecord.fetch(verifierPda(verifier.publicKey));
    expect(rec.authority.toBase58()).to.equal(verifier.publicKey.toBase58());
  });

  it("creates an escrow and pulls the deposit", async () => {
    const nonce = new BN(1);
    const escrow = escrowPda(client.publicKey, providerWallet.publicKey, nonce);
    const vault = getAssociatedTokenAddressSync(mint, escrow, true);

    await program.methods
      .createEscrow(nonce, new BN(12_000_000), 12)
      .accounts({
        client: client.publicKey,
        provider: providerWallet.publicKey,
        tokenMint: mint,
        escrow,
        vault,
        clientTokenAccount: clientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([client])
      .rpc();

    const escrowAcct = await program.account.escrowAccount.fetch(escrow);
    expect(escrowAcct.totalAmount.toNumber()).to.equal(12_000_000);
    expect(escrowAcct.totalPeriods).to.equal(12);
    expect(escrowAcct.active).to.equal(true);

    const vaultBal = await getAccount(provider.connection, vault);
    expect(Number(vaultBal.amount)).to.equal(12_000_000);
  });

  it("releases one period to the provider", async () => {
    const nonce = new BN(1);
    const escrow = escrowPda(client.publicKey, providerWallet.publicKey, nonce);
    const vault = getAssociatedTokenAddressSync(mint, escrow, true);
    const proofHash = Buffer.alloc(32, 1); // 0x01 * 32

    await program.methods
      .releasePayment(1, Array.from(proofHash))
      .accounts({
        provider: providerWallet.publicKey,
        verifier: verifier.publicKey,
        verifierRecord: verifierPda(verifier.publicKey),
        escrow,
        vault,
        providerTokenAccount: providerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([providerWallet, verifier])
      .rpc();

    const escrowAcct = await program.account.escrowAccount.fetch(escrow);
    expect(escrowAcct.periodsReleased).to.equal(1);
    expect(escrowAcct.releasedAmount.toNumber()).to.equal(1_000_000); // 12_000_000 / 12

    const providerBal = await getAccount(provider.connection, providerAta);
    expect(Number(providerBal.amount)).to.equal(1_000_000);
  });

  it("rejects an out-of-order release", async () => {
    const nonce = new BN(1);
    const escrow = escrowPda(client.publicKey, providerWallet.publicKey, nonce);
    const vault = getAssociatedTokenAddressSync(mint, escrow, true);
    try {
      await program.methods
        .releasePayment(5, Array.from(Buffer.alloc(32, 2)))
        .accounts({
          provider: providerWallet.publicKey,
          verifier: verifier.publicKey,
          verifierRecord: verifierPda(verifier.publicKey),
          escrow,
          vault,
          providerTokenAccount: providerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([providerWallet, verifier])
        .rpc();
      expect.fail("expected out-of-order release to fail");
    } catch (err) {
      expect(String(err)).to.match(/WrongPeriod/);
    }
  });

  it("refunds remaining balance on cancel", async () => {
    const nonce = new BN(1);
    const escrow = escrowPda(client.publicKey, providerWallet.publicKey, nonce);
    const vault = getAssociatedTokenAddressSync(mint, escrow, true);

    const beforeClient = Number((await getAccount(provider.connection, clientAta)).amount);

    await program.methods
      .cancelEscrow()
      .accounts({
        client: client.publicKey,
        escrow,
        vault,
        clientTokenAccount: clientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();

    const afterClient = Number((await getAccount(provider.connection, clientAta)).amount);
    // 11 periods were unreleased = 11_000_000 base units back to client.
    expect(afterClient - beforeClient).to.equal(11_000_000);

    const escrowAcct = await program.account.escrowAccount.fetch(escrow);
    expect(escrowAcct.active).to.equal(false);
  });
});
