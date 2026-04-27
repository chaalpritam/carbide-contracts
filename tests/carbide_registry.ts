import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import { CarbideRegistry } from "../target/types/carbide_registry";

describe("carbide_registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CarbideRegistry as Program<CarbideRegistry>;

  const owner = provider.wallet;

  const providerPda = (ownerKey: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("provider"), ownerKey.toBuffer()],
      program.programId
    )[0];

  it("registers a new provider", async () => {
    const pda = providerPda(owner.publicKey);

    await program.methods
      .register(
        "https://provider.example:8080",
        "NorthAmerica",
        0, // Home
        new anchor.BN(100),
        new anchor.BN(5_000) // 0.005 USDC, 6 decimals
      )
      .accounts({
        owner: owner.publicKey,
        provider: pda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const acct = await program.account.providerAccount.fetch(pda);
    expect(acct.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(acct.endpoint).to.equal("https://provider.example:8080");
    expect(acct.region).to.equal("NorthAmerica");
    expect(acct.tier).to.equal(0);
    expect(acct.capacityGb.toNumber()).to.equal(100);
    expect(acct.pricePerGbMonth.toNumber()).to.equal(5_000);
    expect(acct.active).to.equal(true);
  });

  it("rejects re-registering the same owner", async () => {
    try {
      await program.methods
        .register("https://other.example:8080", "Europe", 1, new anchor.BN(50), new anchor.BN(1_000))
        .accounts({
          owner: owner.publicKey,
          provider: providerPda(owner.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("expected re-registration to fail");
    } catch (err) {
      // System program throws "account already in use" when init_if_needed isn't used.
      expect(String(err)).to.match(/already in use|already exists|0x0/i);
    }
  });

  it("updates the provider record", async () => {
    const pda = providerPda(owner.publicKey);
    await program.methods
      .update(
        "https://updated.example:9090",
        "Europe",
        2, // Enterprise
        new anchor.BN(500),
        new anchor.BN(3_000)
      )
      .accounts({
        owner: owner.publicKey,
        provider: pda,
      })
      .rpc();

    const acct = await program.account.providerAccount.fetch(pda);
    expect(acct.endpoint).to.equal("https://updated.example:9090");
    expect(acct.region).to.equal("Europe");
    expect(acct.tier).to.equal(2);
    expect(acct.capacityGb.toNumber()).to.equal(500);
  });

  it("flips the active flag", async () => {
    const pda = providerPda(owner.publicKey);

    await program.methods
      .setActive(false)
      .accounts({ owner: owner.publicKey, provider: pda })
      .rpc();
    let acct = await program.account.providerAccount.fetch(pda);
    expect(acct.active).to.equal(false);

    await program.methods
      .setActive(true)
      .accounts({ owner: owner.publicKey, provider: pda })
      .rpc();
    acct = await program.account.providerAccount.fetch(pda);
    expect(acct.active).to.equal(true);
  });

  it("rejects invalid inputs", async () => {
    const fresh = anchor.web3.Keypair.generate();
    // Fund the fresh keypair so it can pay rent.
    const sig = await provider.connection.requestAirdrop(fresh.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    const pda = providerPda(fresh.publicKey);

    try {
      await program.methods
        .register("", "NorthAmerica", 0, new anchor.BN(100), new anchor.BN(5_000))
        .accounts({
          owner: fresh.publicKey,
          provider: pda,
          systemProgram: SystemProgram.programId,
        })
        .signers([fresh])
        .rpc();
      expect.fail("expected empty endpoint to fail");
    } catch (err) {
      expect(String(err)).to.match(/EmptyEndpoint/);
    }
  });

  it("deregisters and frees the PDA", async () => {
    const pda = providerPda(owner.publicKey);
    await program.methods
      .deregister()
      .accounts({ owner: owner.publicKey, provider: pda })
      .rpc();

    const info = await provider.connection.getAccountInfo(pda);
    expect(info).to.equal(null);
  });
});
