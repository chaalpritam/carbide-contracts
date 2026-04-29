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

## Mainnet-beta deploy

Mainnet uses the same flow; the only differences are funding, the
`--provider.cluster` flag, and the USDC mint that gets passed into the
escrow program. Treat it as a one-way operation — re-deploys consume
real SOL and are irreversible without an upgrade authority.

```sh
solana config set --url mainnet-beta
solana balance                                # confirm the deploy
                                              # keypair has enough SOL
                                              # (~3 SOL is plenty)

anchor build                                  # produces fresh IDLs +
                                              # BPF artefacts

anchor deploy --provider.cluster mainnet      # publishes both programs
anchor migrate --provider.cluster mainnet     # runs migrations/deploy.ts
                                              # (initialises EscrowConfig)

anchor run add-verifier --provider.cluster mainnet -- <verifier-pubkey>
```

Operational checklist before firing `anchor deploy`:

1. **Pin the program IDs.** Run `anchor keys sync` so the addresses in
   `Anchor.toml` and the `declare_id!` macros match the keys in
   `target/deploy/`. Keep those keypairs in cold storage — they are the
   upgrade authority.
2. **Use mainnet USDC.** `EscrowConfig` stores the SPL mint that the
   escrow accepts; pass `EsK7… (USDC mainnet)` rather than the devnet
   mock when running `anchor migrate`.
3. **Audit your verifier set.** `add-verifier` is admin-gated; only add
   keys controlled by the verifier you intend to run.
4. **Snapshot the IDLs.** Commit `target/idl/*.json` to a release tag —
   the discovery service and clients consume them.
5. **Update downstream config.** Set `wallet.registry_address`,
   `escrow_address`, and `usdc_address` in `provider.toml` (and the
   equivalent env vars in the discovery service) to the new mainnet
   addresses, then redeploy those services.

## Toolchain notes

Solana CLI 2.0.21 bundles platform-tools v1.42 (cargo 1.75), which
cannot read the lockfile v4 that host cargo (1.78+) writes. If you
see "lock file version 4 requires `-Znext-lockfile-bump`" during
`anchor build`, build each program with a newer platform-tools:

```sh
rm -f Cargo.lock
( cd programs/carbide_registry && cargo build-sbf --tools-version v1.52 )
( cd programs/carbide_escrow   && cargo build-sbf --tools-version v1.52 )
anchor idl build -p carbide_registry -o target/idl/carbide_registry.json -t target/types/carbide_registry.ts
anchor idl build -p carbide_escrow   -o target/idl/carbide_escrow.json   -t target/types/carbide_escrow.ts
```

`anchor build` itself doesn't expose `--tools-version` cleanly (the
flag bleeds into the IDL `cargo test` step and errors out), so the
SBF build and IDL build are run separately. Upgrading to Solana CLI
2.1+ bundles platform-tools v1.46+ and lets `anchor build` work
unmodified. `Cargo.lock` is gitignored so the host vs. platform-tools
cargo version mismatch never gets baked into the tree.
