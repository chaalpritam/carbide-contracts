import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deploymentPath = path.join(__dirname, "..", "deployments", `${chainId}.json`);

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found for chain ${chainId}. Run deploy.ts first.`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const usdcAddress = deployment.contracts.MockUSDC;

  console.log(`Calling faucet on MockUSDC at ${usdcAddress} for ${deployer.address}`);

  const usdc = await ethers.getContractAt("MockUSDC", usdcAddress);
  const tx = await usdc.faucet();
  await tx.wait();

  const balance = await usdc.balanceOf(deployer.address);
  console.log(`Faucet called successfully (tx: ${tx.hash})`);
  console.log(`New balance: ${ethers.formatUnits(balance, 6)} mUSDC`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
