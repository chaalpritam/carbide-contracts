import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`Deploying contracts on chain ${chainId} with account: ${deployer.address}`);
  console.log(`Account balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  // Deploy MockUSDC
  console.log("\nDeploying MockUSDC...");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log(`  MockUSDC deployed to: ${usdcAddress}`);

  // Deploy CarbideEscrow
  console.log("Deploying CarbideEscrow...");
  const CarbideEscrow = await ethers.getContractFactory("CarbideEscrow");
  const escrow = await CarbideEscrow.deploy();
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log(`  CarbideEscrow deployed to: ${escrowAddress}`);

  // Deploy CarbideRegistry
  console.log("Deploying CarbideRegistry...");
  const CarbideRegistry = await ethers.getContractFactory("CarbideRegistry");
  const registry = await CarbideRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`  CarbideRegistry deployed to: ${registryAddress}`);

  // Write deployment info to JSON
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deployment = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      MockUSDC: usdcAddress,
      CarbideEscrow: escrowAddress,
      CarbideRegistry: registryAddress,
    },
  };

  const outputPath = path.join(deploymentsDir, `${chainId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment info written to: ${outputPath}`);
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
