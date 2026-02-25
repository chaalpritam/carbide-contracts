import { expect } from "chai";
import { ethers } from "hardhat";
import { CarbideEscrow, MockUSDC } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("CarbideEscrow", function () {
  let escrow: CarbideEscrow;
  let usdc: MockUSDC;
  let owner: HardhatEthersSigner;
  let client: HardhatEthersSigner;
  let provider: HardhatEthersSigner;
  let verifier: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const DEPOSIT_AMOUNT = 12_000n * 1_000_000n; // 12,000 USDC
  const TOTAL_PERIODS = 12; // 12 months

  // EIP-712 helpers
  let domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };

  const types = {
    PaymentRelease: [
      { name: "escrowId", type: "uint256" },
      { name: "period", type: "uint32" },
      { name: "provider", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proofHash", type: "bytes32" },
    ],
  };

  async function signRelease(
    signer: HardhatEthersSigner,
    escrowId: bigint,
    period: number,
    providerAddr: string,
    amount: bigint,
    proofHash: string
  ): Promise<string> {
    return signer.signTypedData(domain, types, {
      escrowId,
      period,
      provider: providerAddr,
      amount,
      proofHash,
    });
  }

  beforeEach(async function () {
    [owner, client, provider, verifier, outsider] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    // Deploy CarbideEscrow
    const CarbideEscrow = await ethers.getContractFactory("CarbideEscrow");
    escrow = await CarbideEscrow.deploy();

    // Setup EIP-712 domain
    const network = await ethers.provider.getNetwork();
    domain = {
      name: "CarbideEscrow",
      version: "1",
      chainId: Number(network.chainId),
      verifyingContract: await escrow.getAddress(),
    };

    // Add verifier
    await escrow.addVerifier(verifier.address);

    // Fund client with USDC
    await usdc.connect(client).faucet();
    await usdc.connect(client).faucet(); // 20,000 USDC total
  });

  // ---------------------------------------------------------------
  // Deployment
  // ---------------------------------------------------------------

  describe("Deployment", function () {
    it("should set owner to deployer", async function () {
      expect(await escrow.owner()).to.equal(owner.address);
    });

    it("should start with nextEscrowId = 0", async function () {
      expect(await escrow.nextEscrowId()).to.equal(0);
    });

    it("should compute DOMAIN_SEPARATOR", async function () {
      const ds = await escrow.DOMAIN_SEPARATOR();
      expect(ds).to.not.equal(ethers.ZeroHash);
    });
  });

  // ---------------------------------------------------------------
  // Verifier Management
  // ---------------------------------------------------------------

  describe("Verifier management", function () {
    it("should allow owner to add verifier", async function () {
      await expect(escrow.addVerifier(outsider.address))
        .to.emit(escrow, "VerifierAdded")
        .withArgs(outsider.address);
      expect(await escrow.authorizedVerifiers(outsider.address)).to.be.true;
    });

    it("should allow owner to remove verifier", async function () {
      await expect(escrow.removeVerifier(verifier.address))
        .to.emit(escrow, "VerifierRemoved")
        .withArgs(verifier.address);
      expect(await escrow.authorizedVerifiers(verifier.address)).to.be.false;
    });

    it("should revert addVerifier for non-owner", async function () {
      await expect(
        escrow.connect(client).addVerifier(outsider.address)
      ).to.be.revertedWith("CarbideEscrow: not owner");
    });

    it("should revert removeVerifier for non-owner", async function () {
      await expect(
        escrow.connect(client).removeVerifier(verifier.address)
      ).to.be.revertedWith("CarbideEscrow: not owner");
    });
  });

  // ---------------------------------------------------------------
  // Create Escrow
  // ---------------------------------------------------------------

  describe("createEscrow", function () {
    it("should create escrow and transfer USDC", async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await escrow.connect(client).createEscrow(
        provider.address,
        await usdc.getAddress(),
        DEPOSIT_AMOUNT,
        TOTAL_PERIODS
      );

      const e = await escrow.getEscrow(0);
      expect(e.client).to.equal(client.address);
      expect(e.provider).to.equal(provider.address);
      expect(e.totalAmount).to.equal(DEPOSIT_AMOUNT);
      expect(e.totalPeriods).to.equal(TOTAL_PERIODS);
      expect(e.releasedAmount).to.equal(0);
      expect(e.periodsReleased).to.equal(0);
      expect(e.active).to.be.true;
      expect(e.disputed).to.be.false;
    });

    it("should emit EscrowCreated event", async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await expect(
        escrow.connect(client).createEscrow(
          provider.address,
          await usdc.getAddress(),
          DEPOSIT_AMOUNT,
          TOTAL_PERIODS
        )
      )
        .to.emit(escrow, "EscrowCreated")
        .withArgs(0, client.address, provider.address, DEPOSIT_AMOUNT, TOTAL_PERIODS);
    });

    it("should increment nextEscrowId", async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await escrow.connect(client).createEscrow(
        provider.address,
        await usdc.getAddress(),
        DEPOSIT_AMOUNT,
        TOTAL_PERIODS
      );
      expect(await escrow.nextEscrowId()).to.equal(1);
    });

    it("should revert on zero provider address", async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await expect(
        escrow.connect(client).createEscrow(
          ethers.ZeroAddress,
          await usdc.getAddress(),
          DEPOSIT_AMOUNT,
          TOTAL_PERIODS
        )
      ).to.be.revertedWith("CarbideEscrow: zero provider address");
    });

    it("should revert on zero amount", async function () {
      await expect(
        escrow.connect(client).createEscrow(
          provider.address,
          await usdc.getAddress(),
          0,
          TOTAL_PERIODS
        )
      ).to.be.revertedWith("CarbideEscrow: zero amount");
    });

    it("should revert on zero periods", async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await expect(
        escrow.connect(client).createEscrow(
          provider.address,
          await usdc.getAddress(),
          DEPOSIT_AMOUNT,
          0
        )
      ).to.be.revertedWith("CarbideEscrow: zero periods");
    });
  });

  // ---------------------------------------------------------------
  // Release Payment
  // ---------------------------------------------------------------

  describe("releasePayment", function () {
    const proofHash = ethers.keccak256(ethers.toUtf8Bytes("proof-data-period-1"));
    const perPeriodAmount = DEPOSIT_AMOUNT / BigInt(TOTAL_PERIODS);

    beforeEach(async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await escrow.connect(client).createEscrow(
        provider.address,
        await usdc.getAddress(),
        DEPOSIT_AMOUNT,
        TOTAL_PERIODS
      );
    });

    it("should release correct per-period amount", async function () {
      const sig = await signRelease(verifier, 0n, 1, provider.address, perPeriodAmount, proofHash);
      await escrow.releasePayment(0, 1, proofHash, sig);

      const e = await escrow.getEscrow(0);
      expect(e.releasedAmount).to.equal(perPeriodAmount);
      expect(e.periodsReleased).to.equal(1);
      expect(await usdc.balanceOf(provider.address)).to.equal(perPeriodAmount);
    });

    it("should emit PaymentReleased event", async function () {
      const sig = await signRelease(verifier, 0n, 1, provider.address, perPeriodAmount, proofHash);
      await expect(escrow.releasePayment(0, 1, proofHash, sig))
        .to.emit(escrow, "PaymentReleased")
        .withArgs(0, 1, perPeriodAmount, proofHash);
    });

    it("last period gets remainder", async function () {
      // Release periods 1..11
      for (let p = 1; p < TOTAL_PERIODS; p++) {
        const ph = ethers.keccak256(ethers.toUtf8Bytes(`proof-period-${p}`));
        const sig = await signRelease(verifier, 0n, p, provider.address, perPeriodAmount, ph);
        await escrow.releasePayment(0, p, ph, sig);
      }

      // Period 12 should get the remainder
      const remainder = DEPOSIT_AMOUNT - perPeriodAmount * BigInt(TOTAL_PERIODS - 1);
      const ph12 = ethers.keccak256(ethers.toUtf8Bytes("proof-period-12"));
      const sig12 = await signRelease(verifier, 0n, 12, provider.address, remainder, ph12);
      await expect(escrow.releasePayment(0, 12, ph12, sig12))
        .to.emit(escrow, "EscrowCompleted")
        .withArgs(0);

      const e = await escrow.getEscrow(0);
      expect(e.active).to.be.false;
      expect(e.releasedAmount).to.equal(DEPOSIT_AMOUNT);
    });

    it("should reject unauthorized signer", async function () {
      const sig = await signRelease(outsider, 0n, 1, provider.address, perPeriodAmount, proofHash);
      await expect(
        escrow.releasePayment(0, 1, proofHash, sig)
      ).to.be.revertedWith("CarbideEscrow: invalid verifier signature");
    });

    it("should reject wrong period", async function () {
      const sig = await signRelease(verifier, 0n, 2, provider.address, perPeriodAmount, proofHash);
      await expect(
        escrow.releasePayment(0, 2, proofHash, sig)
      ).to.be.revertedWith("CarbideEscrow: wrong period");
    });

    it("should reject non-existent escrow", async function () {
      const sig = await signRelease(verifier, 99n, 1, provider.address, perPeriodAmount, proofHash);
      await expect(
        escrow.releasePayment(99, 1, proofHash, sig)
      ).to.be.revertedWith("CarbideEscrow: escrow does not exist");
    });
  });

  // ---------------------------------------------------------------
  // Cancel Escrow
  // ---------------------------------------------------------------

  describe("cancelEscrow", function () {
    beforeEach(async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await escrow.connect(client).createEscrow(
        provider.address,
        await usdc.getAddress(),
        DEPOSIT_AMOUNT,
        TOTAL_PERIODS
      );
    });

    it("should refund unreleased funds to client", async function () {
      const balBefore = await usdc.balanceOf(client.address);
      await escrow.connect(client).cancelEscrow(0);
      const balAfter = await usdc.balanceOf(client.address);

      expect(balAfter - balBefore).to.equal(DEPOSIT_AMOUNT);
      const e = await escrow.getEscrow(0);
      expect(e.active).to.be.false;
    });

    it("should emit EscrowCancelled event", async function () {
      await expect(escrow.connect(client).cancelEscrow(0))
        .to.emit(escrow, "EscrowCancelled")
        .withArgs(0, DEPOSIT_AMOUNT);
    });

    it("should revert for non-client", async function () {
      await expect(
        escrow.connect(provider).cancelEscrow(0)
      ).to.be.revertedWith("CarbideEscrow: not client");
    });

    it("should revert for inactive escrow", async function () {
      await escrow.connect(client).cancelEscrow(0);
      await expect(
        escrow.connect(client).cancelEscrow(0)
      ).to.be.revertedWith("CarbideEscrow: escrow not active");
    });

    it("should revert for disputed escrow", async function () {
      await escrow.connect(client).raiseDispute(0);
      await expect(
        escrow.connect(client).cancelEscrow(0)
      ).to.be.revertedWith("CarbideEscrow: escrow is disputed");
    });
  });

  // ---------------------------------------------------------------
  // Raise Dispute
  // ---------------------------------------------------------------

  describe("raiseDispute", function () {
    beforeEach(async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await escrow.connect(client).createEscrow(
        provider.address,
        await usdc.getAddress(),
        DEPOSIT_AMOUNT,
        TOTAL_PERIODS
      );
    });

    it("client can raise dispute", async function () {
      await expect(escrow.connect(client).raiseDispute(0))
        .to.emit(escrow, "EscrowDisputed")
        .withArgs(0, client.address);
      const e = await escrow.getEscrow(0);
      expect(e.disputed).to.be.true;
    });

    it("provider can raise dispute", async function () {
      await expect(escrow.connect(provider).raiseDispute(0))
        .to.emit(escrow, "EscrowDisputed")
        .withArgs(0, provider.address);
    });

    it("should revert for third party", async function () {
      await expect(
        escrow.connect(outsider).raiseDispute(0)
      ).to.be.revertedWith("CarbideEscrow: not a party");
    });

    it("should revert for inactive escrow", async function () {
      await escrow.connect(client).cancelEscrow(0);
      await expect(
        escrow.connect(client).raiseDispute(0)
      ).to.be.revertedWith("CarbideEscrow: escrow not active");
    });
  });

  // ---------------------------------------------------------------
  // Resolve Dispute
  // ---------------------------------------------------------------

  describe("resolveDispute", function () {
    beforeEach(async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await escrow.connect(client).createEscrow(
        provider.address,
        await usdc.getAddress(),
        DEPOSIT_AMOUNT,
        TOTAL_PERIODS
      );
      await escrow.connect(client).raiseDispute(0);
    });

    it("should split funds between provider and client", async function () {
      const providerShare = DEPOSIT_AMOUNT / 2n;
      const clientShare = DEPOSIT_AMOUNT - providerShare;

      const clientBefore = await usdc.balanceOf(client.address);
      const providerBefore = await usdc.balanceOf(provider.address);

      await expect(escrow.resolveDispute(0, providerShare, clientShare))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(0, providerShare, clientShare);

      expect(await usdc.balanceOf(provider.address)).to.equal(providerBefore + providerShare);
      expect(await usdc.balanceOf(client.address)).to.equal(clientBefore + clientShare);

      const e = await escrow.getEscrow(0);
      expect(e.active).to.be.false;
      expect(e.disputed).to.be.false;
    });

    it("should revert on wrong amounts", async function () {
      await expect(
        escrow.resolveDispute(0, DEPOSIT_AMOUNT, 1n)
      ).to.be.revertedWith("CarbideEscrow: amounts must equal remaining");
    });

    it("should revert for non-owner", async function () {
      await expect(
        escrow.connect(client).resolveDispute(0, DEPOSIT_AMOUNT / 2n, DEPOSIT_AMOUNT / 2n)
      ).to.be.revertedWith("CarbideEscrow: not owner");
    });

    it("should revert for non-disputed escrow", async function () {
      // Create a second, non-disputed escrow (fund client again first)
      await usdc.connect(client).faucet();
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await escrow.connect(client).createEscrow(
        provider.address,
        await usdc.getAddress(),
        DEPOSIT_AMOUNT,
        TOTAL_PERIODS
      );
      await expect(
        escrow.resolveDispute(1, DEPOSIT_AMOUNT / 2n, DEPOSIT_AMOUNT / 2n)
      ).to.be.revertedWith("CarbideEscrow: not disputed");
    });
  });

  // ---------------------------------------------------------------
  // View Functions
  // ---------------------------------------------------------------

  describe("View functions", function () {
    beforeEach(async function () {
      await usdc.connect(client).approve(await escrow.getAddress(), DEPOSIT_AMOUNT);
      await escrow.connect(client).createEscrow(
        provider.address,
        await usdc.getAddress(),
        DEPOSIT_AMOUNT,
        TOTAL_PERIODS
      );
    });

    it("getEscrow returns correct struct", async function () {
      const e = await escrow.getEscrow(0);
      expect(e.client).to.equal(client.address);
      expect(e.provider).to.equal(provider.address);
      expect(e.totalAmount).to.equal(DEPOSIT_AMOUNT);
    });

    it("getRemainingBalance returns full amount initially", async function () {
      expect(await escrow.getRemainingBalance(0)).to.equal(DEPOSIT_AMOUNT);
    });

    it("getCurrentPeriod returns 1 initially", async function () {
      expect(await escrow.getCurrentPeriod(0)).to.equal(1);
    });

    it("getEscrow reverts for non-existent id", async function () {
      await expect(escrow.getEscrow(99)).to.be.revertedWith(
        "CarbideEscrow: escrow does not exist"
      );
    });
  });
});
