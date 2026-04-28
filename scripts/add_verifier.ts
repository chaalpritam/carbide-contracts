import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ADMIN_KEYPAIR = process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");

(async () => {
  if (!process.argv[2]) {
    console.error("usage: add_verifier.ts <verifier-pubkey>");
    process.exit(1);
  }
  const verifierPubkey = new PublicKey(process.argv[2]);

  const idl = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "target/idl/carbide_escrow.json"), "utf-8")
  );

  const adminKp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(ADMIN_KEYPAIR, "utf-8")))
  );

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(adminKp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const programId = new PublicKey(idl.address);
  const program = new anchor.Program(idl, provider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [verifierRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier"), verifierPubkey.toBuffer()],
    programId
  );

  const existing = await connection.getAccountInfo(verifierRecordPda);
  if (existing) {
    console.log(
      `verifier ${verifierPubkey.toBase58()} already whitelisted at ${verifierRecordPda.toBase58()}`
    );
    return;
  }

  const sig = await (program.methods as any)
    .addVerifier()
    .accounts({
      admin: wallet.publicKey,
      config: configPda,
      verifier: verifierPubkey,
      verifierRecord: verifierRecordPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`whitelisted verifier ${verifierPubkey.toBase58()}`);
  console.log(`record PDA: ${verifierRecordPda.toBase58()}`);
  console.log(`tx: ${sig}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
