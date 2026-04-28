import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Connection,
  Keypair,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import BN from "bn.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const USDC_MINT = process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const CLIENT_KEYPAIR = process.env.CLIENT_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
const VERIFIER_KEYPAIR = process.env.VERIFIER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/carbide-verifier.json");

const USDC = new PublicKey(USDC_MINT);

(async () => {
  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "target/idl/carbide_escrow.json"), "utf-8")
  );

  const clientKp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(CLIENT_KEYPAIR, "utf-8")))
  );
  const verifierKp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(VERIFIER_KEYPAIR, "utf-8")))
  );
  const providerKp = Keypair.generate();

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(clientKp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const programId = new PublicKey(idl.address);
  const program = new anchor.Program(idl, provider);

  const nonce = new BN(Date.now());
  const totalAmount = new BN(2_000_000); // 2 USDC (6 decimals)
  const totalPeriods = 2;

  const [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      clientKp.publicKey.toBuffer(),
      providerKp.publicKey.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
  const [verifierRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier"), verifierKp.publicKey.toBuffer()],
    programId
  );

  const clientUsdcAta = await getAssociatedTokenAddress(USDC, clientKp.publicKey);
  const vaultAta = await getAssociatedTokenAddress(USDC, escrowPda, true);

  console.log(`client:      ${clientKp.publicKey.toBase58()}`);
  console.log(`provider:    ${providerKp.publicKey.toBase58()} (synthetic)`);
  console.log(`verifier:    ${verifierKp.publicKey.toBase58()}`);
  console.log(`escrow PDA:  ${escrowPda.toBase58()} (bump ${escrowBump})`);
  console.log(`vault ATA:   ${vaultAta.toBase58()}`);
  console.log(`nonce:       ${nonce.toString()}`);

  // --- create_escrow ---
  console.log("\n--- create_escrow ---");
  const createSig = await (program.methods as any)
    .createEscrow(nonce, totalAmount, totalPeriods)
    .accounts({
      client: clientKp.publicKey,
      provider: providerKp.publicKey,
      tokenMint: USDC,
      escrow: escrowPda,
      vault: vaultAta,
      clientTokenAccount: clientUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(`tx: ${createSig}`);

  const vaultBalanceAfterCreate = (await getAccount(connection, vaultAta)).amount;
  console.log(`vault USDC after create: ${Number(vaultBalanceAfterCreate) / 1e6}`);

  // --- provider needs an ATA + a tiny SOL balance to be a signer (rent for tx fee covered by client below; provider pays its own tx fee on release) ---
  // Fund provider with 0.05 SOL for fees
  const fundTx = await connection.requestAirdrop(providerKp.publicKey, 50_000_000).catch(() => null);
  if (fundTx) {
    await connection.confirmTransaction(fundTx, "confirmed");
  } else {
    // airdrop may be rate-limited; transfer from client instead
    const transferIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: clientKp.publicKey,
      toPubkey: providerKp.publicKey,
      lamports: 50_000_000,
    });
    const tx = new anchor.web3.Transaction().add(transferIx);
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [clientKp]);
  }

  const providerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    clientKp,             // payer
    USDC,
    providerKp.publicKey
  );
  console.log(`provider ATA: ${providerAta.address.toBase58()}`);

  // --- release_payment, period 1 ---
  console.log("\n--- release_payment (period 1) ---");
  const proofHash = Buffer.alloc(32, 1);
  const releaseSig1 = await (program.methods as any)
    .releasePayment(1, [...proofHash])
    .accounts({
      provider: providerKp.publicKey,
      verifier: verifierKp.publicKey,
      verifierRecord: verifierRecordPda,
      escrow: escrowPda,
      vault: vaultAta,
      providerTokenAccount: providerAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([providerKp, verifierKp])
    .rpc();
  console.log(`tx: ${releaseSig1}`);

  const providerBal1 = (await getAccount(connection, providerAta.address)).amount;
  const vaultBal1 = (await getAccount(connection, vaultAta)).amount;
  console.log(`provider USDC: ${Number(providerBal1) / 1e6}, vault USDC: ${Number(vaultBal1) / 1e6}`);

  // --- release_payment, period 2 ---
  console.log("\n--- release_payment (period 2) ---");
  const releaseSig2 = await (program.methods as any)
    .releasePayment(2, [...proofHash])
    .accounts({
      provider: providerKp.publicKey,
      verifier: verifierKp.publicKey,
      verifierRecord: verifierRecordPda,
      escrow: escrowPda,
      vault: vaultAta,
      providerTokenAccount: providerAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([providerKp, verifierKp])
    .rpc();
  console.log(`tx: ${releaseSig2}`);

  const providerBal2 = (await getAccount(connection, providerAta.address)).amount;
  const vaultBal2 = (await getAccount(connection, vaultAta)).amount;
  console.log(`provider USDC: ${Number(providerBal2) / 1e6}, vault USDC: ${Number(vaultBal2) / 1e6}`);

  console.log("\nescrow flow OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
