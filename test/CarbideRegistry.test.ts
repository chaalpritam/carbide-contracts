import { expect } from "chai";
import { ethers } from "hardhat";
import { CarbideRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("CarbideRegistry", function () {
  let registry: CarbideRegistry;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  const endpoint = "https://alice.example.carbidenetwork.xyz:8080";
  const region = "NorthAmerica";
  const tier = 0; // Home
  const capacityGb = 1_000n;
  const pricePerGbMonth = 5_000n; // 0.005 USDC per GB/month (6 decimals)

  beforeEach(async function () {
    [alice, bob, carol] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("CarbideRegistry");
    registry = await Registry.deploy();
  });

  describe("register", function () {
    it("registers a new provider", async function () {
      await expect(
        registry
          .connect(alice)
          .register(endpoint, region, tier, capacityGb, pricePerGbMonth)
      )
        .to.emit(registry, "ProviderRegistered")
        .withArgs(alice.address, endpoint, region, tier, capacityGb, pricePerGbMonth);

      expect(await registry.isRegistered(alice.address)).to.equal(true);
      expect(await registry.providerCount()).to.equal(1n);

      const p = await registry.getProvider(alice.address);
      expect(p.endpoint).to.equal(endpoint);
      expect(p.region).to.equal(region);
      expect(p.tier).to.equal(tier);
      expect(p.capacityGb).to.equal(capacityGb);
      expect(p.pricePerGbMonth).to.equal(pricePerGbMonth);
      expect(p.active).to.equal(true);
      expect(p.registeredAt).to.be.greaterThan(0n);
      expect(p.updatedAt).to.equal(p.registeredAt);
    });

    it("rejects a second registration from the same address", async function () {
      await registry
        .connect(alice)
        .register(endpoint, region, tier, capacityGb, pricePerGbMonth);

      await expect(
        registry
          .connect(alice)
          .register(endpoint, region, tier, capacityGb, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("rejects empty endpoint", async function () {
      await expect(
        registry.connect(alice).register("", region, tier, capacityGb, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "EndpointEmpty");
    });

    it("rejects oversize endpoint", async function () {
      const huge = "h".repeat(257);
      await expect(
        registry.connect(alice).register(huge, region, tier, capacityGb, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "EndpointTooLong");
    });

    it("rejects empty region", async function () {
      await expect(
        registry.connect(alice).register(endpoint, "", tier, capacityGb, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "RegionEmpty");
    });

    it("rejects oversize region", async function () {
      await expect(
        registry
          .connect(alice)
          .register(endpoint, "r".repeat(33), tier, capacityGb, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "RegionTooLong");
    });

    it("rejects tier above MAX_TIER", async function () {
      await expect(
        registry.connect(alice).register(endpoint, region, 4, capacityGb, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "TierOutOfRange");
    });

    it("rejects zero capacity", async function () {
      await expect(
        registry.connect(alice).register(endpoint, region, tier, 0, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "CapacityZero");
    });

    it("rejects zero price", async function () {
      await expect(
        registry.connect(alice).register(endpoint, region, tier, capacityGb, 0)
      ).to.be.revertedWithCustomError(registry, "PriceZero");
    });

    it("allows different addresses to register independently", async function () {
      await registry
        .connect(alice)
        .register(endpoint, region, tier, capacityGb, pricePerGbMonth);
      await registry
        .connect(bob)
        .register("https://bob.example:8080", "Europe", 1, 500n, 7_000n);

      expect(await registry.providerCount()).to.equal(2n);
      expect(await registry.isRegistered(alice.address)).to.equal(true);
      expect(await registry.isRegistered(bob.address)).to.equal(true);
    });
  });

  describe("update", function () {
    beforeEach(async function () {
      await registry
        .connect(alice)
        .register(endpoint, region, tier, capacityGb, pricePerGbMonth);
    });

    it("replaces fields and refreshes updatedAt", async function () {
      const before = await registry.getProvider(alice.address);
      // nudge block timestamp forward
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        registry
          .connect(alice)
          .update("https://alice-new.example:9090", "Europe", 2, 2_000n, 9_000n)
      )
        .to.emit(registry, "ProviderUpdated")
        .withArgs(alice.address, "https://alice-new.example:9090", "Europe", 2, 2_000n, 9_000n);

      const after = await registry.getProvider(alice.address);
      expect(after.endpoint).to.equal("https://alice-new.example:9090");
      expect(after.region).to.equal("Europe");
      expect(after.tier).to.equal(2);
      expect(after.capacityGb).to.equal(2_000n);
      expect(after.pricePerGbMonth).to.equal(9_000n);
      expect(after.registeredAt).to.equal(before.registeredAt);
      expect(after.updatedAt).to.be.greaterThan(before.updatedAt);
    });

    it("reverts if the caller is not registered", async function () {
      await expect(
        registry.connect(bob).update(endpoint, region, tier, capacityGb, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("applies the same validation as register", async function () {
      await expect(
        registry.connect(alice).update("", region, tier, capacityGb, pricePerGbMonth)
      ).to.be.revertedWithCustomError(registry, "EndpointEmpty");
    });
  });

  describe("setActive", function () {
    beforeEach(async function () {
      await registry
        .connect(alice)
        .register(endpoint, region, tier, capacityGb, pricePerGbMonth);
    });

    it("toggles active and emits only on change", async function () {
      await expect(registry.connect(alice).setActive(false))
        .to.emit(registry, "ProviderActiveChanged")
        .withArgs(alice.address, false);

      expect((await registry.getProvider(alice.address)).active).to.equal(false);

      // No-op should not emit
      const tx = await registry.connect(alice).setActive(false);
      const receipt = await tx.wait();
      const evt = receipt!.logs.find((l: any) =>
        "fragment" in l && l.fragment?.name === "ProviderActiveChanged"
      );
      expect(evt).to.equal(undefined);
    });

    it("reverts for unregistered callers", async function () {
      await expect(registry.connect(bob).setActive(false))
        .to.be.revertedWithCustomError(registry, "NotRegistered");
    });
  });

  describe("deregister", function () {
    it("removes the caller's entry and keeps others intact", async function () {
      await registry
        .connect(alice)
        .register(endpoint, region, tier, capacityGb, pricePerGbMonth);
      await registry
        .connect(bob)
        .register("https://bob.example:8080", "Europe", 1, 500n, 7_000n);
      await registry
        .connect(carol)
        .register("https://carol.example:8080", "Asia", 2, 2_000n, 8_000n);

      expect(await registry.providerCount()).to.equal(3n);

      await expect(registry.connect(bob).deregister())
        .to.emit(registry, "ProviderDeregistered")
        .withArgs(bob.address);

      expect(await registry.isRegistered(bob.address)).to.equal(false);
      expect(await registry.providerCount()).to.equal(2n);
      expect(await registry.isRegistered(alice.address)).to.equal(true);
      expect(await registry.isRegistered(carol.address)).to.equal(true);

      await expect(registry.getProvider(bob.address)).to.be.revertedWithCustomError(
        registry,
        "NotRegistered"
      );
    });

    it("allows re-registration after deregister", async function () {
      await registry
        .connect(alice)
        .register(endpoint, region, tier, capacityGb, pricePerGbMonth);
      await registry.connect(alice).deregister();

      await expect(
        registry
          .connect(alice)
          .register(endpoint, region, tier, capacityGb, pricePerGbMonth)
      ).to.emit(registry, "ProviderRegistered");
    });

    it("reverts for unregistered callers", async function () {
      await expect(registry.connect(bob).deregister()).to.be.revertedWithCustomError(
        registry,
        "NotRegistered"
      );
    });
  });

  describe("getProvidersPage", function () {
    beforeEach(async function () {
      await registry
        .connect(alice)
        .register("https://alice.example:8080", "NorthAmerica", 0, 1_000n, 5_000n);
      await registry
        .connect(bob)
        .register("https://bob.example:8080", "Europe", 1, 500n, 7_000n);
      await registry
        .connect(carol)
        .register("https://carol.example:8080", "Asia", 2, 2_000n, 8_000n);
    });

    it("returns the full list when limit = 0", async function () {
      const [owners, records] = await registry.getProvidersPage(0, 0);
      expect(owners.length).to.equal(3);
      expect(records.length).to.equal(3);
      expect(new Set(owners)).to.deep.equal(
        new Set([alice.address, bob.address, carol.address])
      );
    });

    it("supports pagination", async function () {
      const [firstOwners, firstRecords] = await registry.getProvidersPage(0, 2);
      expect(firstOwners.length).to.equal(2);
      expect(firstRecords.length).to.equal(2);

      const [secondOwners] = await registry.getProvidersPage(2, 2);
      expect(secondOwners.length).to.equal(1);

      const combined = new Set([...firstOwners, ...secondOwners]);
      expect(combined.size).to.equal(3);
    });

    it("caps limit at end of list", async function () {
      const [owners] = await registry.getProvidersPage(1, 100);
      expect(owners.length).to.equal(2);
    });

    it("returns empty when the registry is empty", async function () {
      // Fresh registry
      const Registry = await ethers.getContractFactory("CarbideRegistry");
      const empty = await Registry.deploy();
      const [owners, records] = await empty.getProvidersPage(0, 0);
      expect(owners.length).to.equal(0);
      expect(records.length).to.equal(0);
    });

    it("reverts on offset past end", async function () {
      await expect(registry.getProvidersPage(5, 1)).to.be.revertedWithCustomError(
        registry,
        "PageOutOfRange"
      );
    });
  });
});
