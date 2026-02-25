import { expect } from "chai";
import { ethers } from "hardhat";
import { MockUSDC } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MockUSDC", function () {
  let usdc: MockUSDC;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  const FAUCET_AMOUNT = 10_000n * 1_000_000n; // 10,000 USDC (6 decimals)

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
  });

  describe("Deployment", function () {
    it("should have correct name, symbol, and decimals", async function () {
      expect(await usdc.name()).to.equal("Mock USD Coin");
      expect(await usdc.symbol()).to.equal("mUSDC");
      expect(await usdc.decimals()).to.equal(6);
    });

    it("should start with zero total supply", async function () {
      expect(await usdc.totalSupply()).to.equal(0);
    });
  });

  describe("Mint", function () {
    it("should mint tokens to any address", async function () {
      const amount = 5000n * 1_000_000n;
      await usdc.mint(alice.address, amount);
      expect(await usdc.balanceOf(alice.address)).to.equal(amount);
      expect(await usdc.totalSupply()).to.equal(amount);
    });

    it("should emit Transfer event from zero address", async function () {
      const amount = 1000n * 1_000_000n;
      await expect(usdc.mint(alice.address, amount))
        .to.emit(usdc, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, amount);
    });
  });

  describe("Faucet", function () {
    it("should mint FAUCET_AMOUNT to caller", async function () {
      await usdc.connect(alice).faucet();
      expect(await usdc.balanceOf(alice.address)).to.equal(FAUCET_AMOUNT);
    });

    it("should be callable multiple times", async function () {
      await usdc.connect(alice).faucet();
      await usdc.connect(alice).faucet();
      expect(await usdc.balanceOf(alice.address)).to.equal(FAUCET_AMOUNT * 2n);
    });

    it("should emit Transfer event", async function () {
      await expect(usdc.connect(alice).faucet())
        .to.emit(usdc, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, FAUCET_AMOUNT);
    });
  });

  describe("Transfer", function () {
    beforeEach(async function () {
      await usdc.connect(alice).faucet();
    });

    it("should transfer tokens between accounts", async function () {
      const amount = 1000n * 1_000_000n;
      await usdc.connect(alice).transfer(bob.address, amount);
      expect(await usdc.balanceOf(bob.address)).to.equal(amount);
      expect(await usdc.balanceOf(alice.address)).to.equal(FAUCET_AMOUNT - amount);
    });

    it("should revert on insufficient balance", async function () {
      await expect(
        usdc.connect(alice).transfer(bob.address, FAUCET_AMOUNT + 1n)
      ).to.be.revertedWith("MockUSDC: insufficient balance");
    });

    it("should emit Transfer event", async function () {
      const amount = 500n * 1_000_000n;
      await expect(usdc.connect(alice).transfer(bob.address, amount))
        .to.emit(usdc, "Transfer")
        .withArgs(alice.address, bob.address, amount);
    });
  });

  describe("Approve and TransferFrom", function () {
    const amount = 2000n * 1_000_000n;

    beforeEach(async function () {
      await usdc.connect(alice).faucet();
      await usdc.connect(alice).approve(bob.address, amount);
    });

    it("should set allowance", async function () {
      expect(await usdc.allowance(alice.address, bob.address)).to.equal(amount);
    });

    it("should emit Approval event", async function () {
      await expect(usdc.connect(alice).approve(bob.address, amount))
        .to.emit(usdc, "Approval")
        .withArgs(alice.address, bob.address, amount);
    });

    it("should allow transferFrom within allowance", async function () {
      await usdc.connect(bob).transferFrom(alice.address, bob.address, amount);
      expect(await usdc.balanceOf(bob.address)).to.equal(amount);
      expect(await usdc.allowance(alice.address, bob.address)).to.equal(0);
    });

    it("should revert transferFrom exceeding allowance", async function () {
      await expect(
        usdc.connect(bob).transferFrom(alice.address, bob.address, amount + 1n)
      ).to.be.revertedWith("MockUSDC: insufficient allowance");
    });

    it("should revert transferFrom exceeding balance", async function () {
      await usdc.connect(alice).approve(bob.address, FAUCET_AMOUNT + 1n);
      await expect(
        usdc.connect(bob).transferFrom(alice.address, bob.address, FAUCET_AMOUNT + 1n)
      ).to.be.revertedWith("MockUSDC: insufficient balance");
    });
  });
});
