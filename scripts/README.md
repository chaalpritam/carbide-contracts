# Operator scripts

One-off helpers for managing a deployed `carbide_escrow` program. They
read the IDL from `../target/idl/carbide_escrow.json` and use
`@coral-xyz/anchor` from the workspace `node_modules`, so run `npm
install` and `anchor build` (or `anchor idl build`) first.

Each script reads its inputs from environment variables so it works on
any cluster, not just the dev machine where it was first used.

## add_verifier.ts

Whitelists a verifier signer pubkey by initialising its `VerifierRecord`
PDA. The escrow admin (the keypair that signed `initialize_config`)
must run this.

```sh
anchor run add-verifier -- <verifier-pubkey>
# or directly:
node_modules/.bin/ts-node --transpile-only scripts/add_verifier.ts <verifier-pubkey>
```

Env vars (all optional):

| Var | Default |
| --- | --- |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `ADMIN_KEYPAIR` | `~/.config/solana/id.json` |

## exercise_escrow.ts

End-to-end smoke test for a deployed `carbide_escrow`: opens a 2-USDC
escrow with two periods, releases each one with the verifier
co-signing, and confirms the vault drains to the provider.

The "provider" is a fresh keypair generated inside the script — the
escrow program only checks signer == `escrow.provider`, so this proves
the contract path without needing a live carbide-node wallet.

```sh
anchor run exercise-escrow
```

Requires the client wallet to hold ≥ 2 USDC of the configured mint
(devnet USDC by default — top up at https://faucet.circle.com) and a
small amount of SOL for fees.

Env vars (all optional):

| Var | Default |
| --- | --- |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `USDC_MINT` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (devnet USDC) |
| `CLIENT_KEYPAIR` | `~/.config/solana/id.json` |
| `VERIFIER_KEYPAIR` | `~/.config/solana/carbide-verifier.json` |
