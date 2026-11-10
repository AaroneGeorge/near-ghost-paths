# AI-generated code and libraries disclosure

NEAR HACKATHON asks teams to list libraries, templates and AI-generated code (rules Q-005 and Q-014). This file is the long form of the README section.

## Summary

- **Every line of code and documentation in this repository was written during the hackathon window (2026-11-09 onward) by Claude agents**, directed and reviewed by the submitter, Aarone George.
- The repository has no pre-existing code, no vendored code and no template. Git history starts with the scaffold commit.
- Nothing was copied from another project except the reproducible-build image reference in `contract/Cargo.toml`, which was copied from the sibling project Tripwire and is **not verified** (see the README, "Development").
- The protocol is an adaptation of [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) (stealth addresses); the differences are listed in `docs/SPEC.md` section 9.

## Who wrote what

| Area | Written by | Notes |
|---|---|---|
| Research, product choice, build plan, protocol design (`PLAN.md`) | Claude Fable 5.1 (high effort) | Facts in `PLAN.md` section 0 were verified against live testnet calls and the chainsig.js and near/mpc sources on the day |
| `packages/sdk` (keys, stealth math, derivation, announcements, scan, registry client, `docs/SPEC.md`) | Claude Opus 5.5 (high effort) | Test vectors re-derived with an independent implementation (pyca/cryptography) and cross-checked against the Rust contract's k256 |
| `contract/` (registry, announcements, sweep gateway, tests) | Claude Opus 5.5 (high effort) | 24 unit tests, sandbox tests against a mock signer, an opt-in live test against the real MPC |
| `packages/sdk/src/chains`, `oneclick.ts`, `packages/cli`, `packages/relayer`, `demo/` | Claude Opus 5.5 (high effort) | `demo/fixtures/replay/` is real recorded traffic, not hand-written |
| `apps/web`, `packages/cli/src/serve.ts`, `serve-dev.ts` | Claude Sonnet 5.5 (high effort) | Icons: `lucide-react` (chosen via the Code Garage item `frontend.design.icon-sets`); smoke test: Playwright (`frontend.testing.playwright-for-ui`) |
| `README.md`, `docs/*`, `packages/sdk/test/fixtures.test.ts`, `packages/sdk/test/live.test.ts`, the `test-live` target | Claude Sonnet 5.5 (high effort) | The README commands were executed, and the README was then followed blind from a fresh clone |
| Scaffold, Makefile skeleton, CI, LICENSE | Claude Sonnet 5.5 | |

What the human did: chose the two projects, approved the plan, ran the agents, reviewed outputs, owns the accounts and keys, will record the video and publish the post and the submission.

## What is real and what is recorded

- `demo/fixtures/live-sweep-testnet.json`: output of a real run of `contract/tests/live_testnet.rs` against `v1.ghost-paths.testnet` and `v1.signer-prod.testnet` (transaction hashes are in the file). No private key is stored in it.
- `demo/fixtures/replay/`: a recording of a real `make demo --record` run (real NEAR testnet RPC including real MPC results, local anvil and Solana validator traffic). It is replayed by `make demo-replay`; the demo prints that it is a replay. The throwaway accounts of that run were deleted afterwards.
- `make test-live` does not use fixtures: it makes two new real MPC calls.
- No TEE or attestation is involved in this project, and none is claimed.

## Libraries

JavaScript/TypeScript (pinned in `bun.lock`): `chainsig.js` 1.1.16 (includes `bitcoinjs-lib`), `near-api-js` 7.4.0, `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0, `@noble/ciphers` 2.4.0, `@scure/base` 2.2.0, `viem` 2.57.17,
`@solana/web3.js` 1.98.4, `react` and `react-dom` 19, `vite` 8, `@vitejs/plugin-react`, `lucide-react`, `playwright` (smoke test), `@biomejs/biome`, `typescript`, `@types/*`.

Rust (pinned in `contract/Cargo.lock`): `near-sdk` 5.30.1 (feature `unstable` for `env::ecrecover`), `hex`; dev-only: `near-workspaces` 0.24, `tokio`, `anyhow`, `serde_json`, `k256`, `sha2`, `sha3`, `ed25519-dalek`, `bs58`, `rand`.

Tooling and services: `cargo-near` 0.23 and Rust 1.99.1 (contract build), docker images `ghcr.io/foundry-rs/foundry` (anvil) and `anzaxyz/agave` (solana-test-validator), the NEAR testnet RPC and account helper,
`https://1click.chaindefuser.com` (dry quotes), `mempool.emzy.de` (Bitcoin testnet4 reads).

No cryptographic primitive is hand-rolled: hashing, HKDF, X25519, secp256k1, ed25519 and XChaCha20-Poly1305 come from the `@noble` and `@scure` libraries; on the contract side `ecrecover` and `sha256` are NEAR host functions.

## Honest limits of AI authorship

Code written by language models can be subtly wrong. We reduced the risk with test vectors checked by a second implementation, a contract tested in a real NEAR sandbox and against the live MPC, and a blind README run. We did not commission an external audit,
and `docs/THREAT-MODEL.md` lists what we did not verify.
