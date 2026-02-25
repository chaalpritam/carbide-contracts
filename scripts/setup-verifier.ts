import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const verifierAddress = process.env.VERIFIER_ADDRESS;
  if (!verifierAddress) {
    throw new Error("VERIFIER_ADDRESS environment variable is required");
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deploymentPath = path.join(__dirname, "..", "deployments", `${chainId}.json`);

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found for chain ${chainId}. Run deploy.ts first.`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const escrowAddress = deployment.contracts.CarbideEscrow;

  console.log(`Adding verifier ${verifierAddress} to CarbideEscrow at ${escrowAddress}`);

  const escrow = await ethers.getContractAt("CarbideEscrow", escrowAddress);
  const tx = await escrow.addVerifier(verifierAddress);
  await tx.wait();

  console.log(`Verifier added successfully (tx: ${tx.hash})`);
  console.log(`Verified: ${await escrow.authorizedVerifiers(verifierAddress)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
