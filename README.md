# carbide-contracts

Solana on-chain programs for the Carbide Network: the permissionless
provider registry and the SPL-token payment escrow that backs storage
deals. Built with Anchor 0.31.1.

## Programs

| Program | Path | Address (devnet/localnet) |
| --- | --- | --- |
| `carbide_registry` | `programs/carbide_registry` | `5rAsbS4ApXNyNqrSUXqC7ju24kpEudHxfU1Q5khmAZHD` |
| `carbide_escrow`   | `programs/carbide_escrow`   | `FQLdMfgTtio51EiWmNC444BmVfAtG9DAdWp8dLeCycgZ` |

The deploy keypairs in `target/deploy/` are gitignored. Operators
generate their own with `solana-keygen new -o target/deploy/<name>-keypair.json`
and then `anchor keys sync` to bake the new public key into the program
sources and `Anchor.toml`.

### carbide_registry

One `ProviderAccount` PDA per provider, seeded by the provider's
signing pubkey. Anyone can self-register; only the original owner can
update / set active / deregister. Each instruction emits an event so
the discovery service can mirror state via account-change subscriptions.

Instructions: `register`, `update`, `set_active`, `deregister`.

### carbide_escrow

Each storage deal opens an `EscrowAccount` PDA plus a vault token
account it controls. The full deal amount is pulled from the client's
ATA on creation; periodic releases need both the provider and an
authorised verifier to co-sign the same instruction. Disputes freeze
the deal until the admin splits the remaining balance.

Instructions: `initialize_config`, `transfer_admin`, `add_verifier`,
`remove_verifier`, `create_escrow`, `release_payment`, `cancel_escrow`,
`raise_dispute`, `resolve_dispute`.

## Local development

```sh
# install deps
npm install

# build BPF artefacts + IDL
anchor build

# run the full ts-mocha suite against a local validator
anchor test
```

`anchor test` boots a temporary validator that clones in the devnet
USDC mint (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) so escrow
flows behave the same locally as on devnet.

## Devnet deploy

```sh
solana airdrop 5 -u devnet
anchor build
anchor deploy --provider.cluster devnet
anchor migrate --provider.cluster devnet   # initialises EscrowConfig
```

After deploy, whitelist the discovery-service verifier:

```sh
anchor run add-verifier --provider.cluster devnet -- <verifier-pubkey>
```

(See `migrations/deploy.ts` to extend with custom post-deploy steps.)

## Toolchain notes

`anchor build` invokes Solana's bundled SBF cargo. If you see
"lock file version 4 requires `-Znext-lockfile-bump`", delete the
generated `Cargo.lock` and let the SBF cargo regenerate it — the
workspace deliberately gitignores `Cargo.lock` to avoid the
host-vs-platform-tools cargo version mismatch.
