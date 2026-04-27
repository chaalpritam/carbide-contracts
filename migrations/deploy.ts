// Anchor deploy script: runs once after `anchor deploy` against the
// configured cluster. Initialises the EscrowConfig PDA so the deployed
// programs are usable end-to-end.
//
// Re-running is idempotent: if the config already exists the script
// no-ops. Add admin-only setup (verifier whitelisting, etc.) below as
// the deployment evolves.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);

  const escrow = anchor.workspace.CarbideEscrow;

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    escrow.programId
  )[0];

  const existing = await provider.connection.getAccountInfo(configPda);
  if (existing) {
    console.log(`escrow config already initialised at ${configPda.toBase58()}`);
    return;
  }

  await escrow.methods
    .initializeConfig()
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(
    `initialised escrow config ${configPda.toBase58()} with admin ${provider.wallet.publicKey.toBase58()}`
  );
};
