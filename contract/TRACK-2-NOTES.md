# Track W2 (contract): notes

Builder: Opus 5.5, 2026-11-09. Status: **done**. Mode B works on testnet against the real MPC.

## What's here

| Path | What |
|---|---|
| `src/lib.rs` `registry.rs` `announce.rs` `sweep.rs` `events.rs` `util.rs` | the contract (PLAN.md §1.8) |
| `src/tests.rs` | 24 unit tests, including the canonical sweep vectors |
| `tests/integration.rs` | near-workspaces sandbox tests of the real wasm against `tests/mock_signer`; prints gas and storage numbers |
| `tests/mock_signer/` | test double for `v1.signer`: enforces ≥ 1 yocto and ≥ 15 Tgas, echoes predecessor, request and deposit |
| `tests/live_testnet.rs` | **LIVE** check, opt-in with `LIVE=1`; writes `fixtures/live-sweep-testnet.json` |
| `res/ghost_paths.wasm`, `res/ghost_paths_abi.json` | committed build (non-reproducible), sha256 `e88f0b99b6c405af23c1d49a33b7f16b5066a3a645435b23e9fc806de4874ed9` |
| `ABI.md`, `SWEEP-MESSAGE.md` | method table, events, and the canonical digest layout (W1 wrote it; W2 checked it and added an ack section) |
| `scripts/deploy-testnet.sh` | deploys the committed wasm to a new faucet account (`DEPLOY=1` path). Tested: it created `ghost-paths-baa64415.testnet`, a throwaway on the previous build |

## Deployment (testnet)

- Contract: **`v1.ghost-paths.testnet`**, `new(signer_id = "v1.signer-prod.testnet")`. Code hash `Gep6ZYfa43r5ZJk97EAma1GjyPfuXrfcvTDPbJXN1fF6` = sha256 of `res/ghost_paths.wasm`. Balance about 5 NEAR.
- Parent: `ghost-paths.testnet`, created with the faucet helper (10 NEAR). It also served as the "relayer" caller in the live check.
- Transactions: create v1 `5c841R1xHK6cJRtTV6DxCwAskgSjAV7KLrvq1JAVJ1NJ`, first deploy and init `2pJMrsaifCbSpf4jUkA6yeeays7uBjRnRUqEPpe9ttah`, redeploy of the final wasm (doc-comment change only, same state layout) `6MwE56TProLBLQTeeyo95BcefhWHQMu8P1mx9pXtWGvd`.
- Keys: `.secrets/near/ghost-paths.testnet.json` and `.secrets/near/v1.ghost-paths.testnet.json` (0600, near-cli key-file format, git-ignored). The throwaway account's key is in `~/.near-credentials/testnet/`.
- **Coordinator decision:** v1 still has a full-access key, so we can hot-fix during the hackathon. Before submission, consider deleting it (`near account delete-keys v1.ghost-paths.testnet ...`) so "no upgrade path" is literally true. Otherwise the README should say the testnet deployment still has a key.

## Live check: Mode B works (PLAN §4 W2, spike S2)

`LIVE=1 cargo test --test live_testnet -- --nocapture` (about 50 s). It uses a fresh random stealth key `K` each run. `ghost-paths.testnet` submits `v1.ghost-paths.testnet.sweep(...)` with 300 Tgas and 1 yocto. The contract checks `ecrecover`, then forwards `sign` to `v1.signer-prod.testnet`, and the MPC signature comes back as the transaction result.

| Domain | Tx | MPC latency | Gas burnt (whole tx) | Check |
|---|---|---|---|---|
| 0 ECDSA, 32-byte payload | `21AELEHgstoAhQTCPbQ7CHWnw73nLDpCJYTcofDSM78G` | 13.2 s | 10.66 Tgas | recovered pubkey == `derived_public_key(v1.ghost-paths.testnet, path, 0)` == local `Root + eps·G`, and != `derive(caller, path)` |
| 1 EdDSA, 215-byte Solana-sized message | `9qZQVb9MKdXXZ59tuXs9XerWVSimQL2RGoPMUvUx62W7` | 13.2 s | 11.63 Tgas | ed25519 verify under `derived_public_key(v1.ghost-paths.testnet, path, 1)` |

An earlier run on the previous build (`ESydC7J7…`, `7gwJbUCk…`) gave the same result. The fixture is `fixtures/live-sweep-testnet.json`, in the §3 fixture format plus `sweep_args`, `tx_hash`, per-receipt gas and latency. It contains no private key. **TODO W5:** copy it or link it from `demo/fixtures/`. I didn't write outside `contract/`.

S2 findings:
- The return value of a promise forwarded through yield/resume reaches our caller unchanged. No callback is needed.
- The real `sign` accepts a full Eddsa message (bounded 1..=1232 bytes in near/mpc `primitives.rs`), not only 32 bytes.
- The MPC config on testnet: `sign` needs ≥ 15 Tgas prepaid, and its resume callback uses 7 Tgas.

## Gas report

Sandbox numbers come from `cargo test --test integration -- --nocapture`. Testnet numbers come from the live run.

| Call | Total burnt | This contract's receipt | Notes |
|---|---|---|---|
| `register` | 2.54 Tgas | 1.78 | storage 126 B = 0.00126 NEAR |
| `announce` (no memo) | 2.52 Tgas | 1.76 | storage 127 B (+1 B per memo char) = 0.00127 NEAR; a 24-char memo cost 155 B |
| `sweep` ECDSA → mock | 3.99 Tgas | 2.17 | sandbox |
| `sweep` EdDSA 700 B → mock, 50 Tgas attached | 4.60 Tgas | 2.63 | the minimum prepaid gas is enough |
| `sweep` ECDSA → real MPC (testnet) | 10.66 Tgas | 2.20 | MPC `sign` 4.28 + resume callback 3.45 + refunds |
| `sweep` EdDSA → real MPC (testnet) | 11.63 Tgas | 2.32 | |

The PLAN acceptance is ≤ 300 Tgas end to end; the actual figure is about 11 Tgas. `sign` gets 30 Tgas static plus all unused gas (weight 1): about 298 Tgas when 300 is attached. Unused gas is refunded. Minimum prepaid gas for `sweep` is 50 Tgas.

## Spikes S5 and S8

- **S5 (ecrecover ↔ noble):** passes. noble-curves 2.4 `secp256k1.sign(msg, d, {prehash:false, format:"recovered"})` produces byte-identical `(v, r, s)` to k256 `sign_prehash_recoverable` on the canonical vector. `env::ecrecover(msg, r‖s, v, malleability_flag=true)` returns `K_unc` in unit tests, in the sandbox and on testnet. A high-s variant (`s → n−s`, `v ^= 1`) is rejected (unit test).
- **S8 (storage):** see the gas table. Per-announcement storage is 127 B. `ct` is capped at 1024 chars, which is at most about 0.0115 NEAR. The wasm is 168 KB, which is about 1.7 NEAR of storage on the contract account.

## Acceptance tests (PLAN §4 W2)

All pass: `cargo test` gives unit 24/24 and integration 2/2. The live test is skipped (passes as a no-op) unless `LIVE=1`.
- register, announce and pagination, with storage charging and refunds. The sandbox checks that the caller's balance only drops by storage plus gas from a 1 NEAR deposit. Also covered: missing deposit, bad mode, uncompressed key, bad chain tag, oversize memo, limit clamped to 200, and reads past the end.
- `sweep` rejects: a signature by another key, a tampered payload or expiry, a signature for another contract id (replay across deployments), high-s, expired, wrong `k_pub` (`path_mismatch`), 0 yocto, gas below 50 Tgas, `v=27`, domain 2, an ECDSA payload ≥ n, and two payloads. Rejected sweeps never reach the signer: the mock's call count is checked.
- A good sweep makes a promise to the mock, which sees **predecessor = the ghost contract**, deposit 1 yocto, and the exact `{payload_v2, path, domain_id}`. Our method returns the mock's value.

## Decisions and deviations (for W1, W3 and W6)

1. **Sweep layout:** exactly PLAN §1.7, with no length prefixes. W1 adopted it, and `SWEEP-MESSAGE.md` is canonical. **W2 ack:** I checked W1's rewrite of `SWEEP-MESSAGE.md` against `sweep.rs`. It matches, and the SDK `contract_vectors` digests and signatures equal the Rust `canonical_vectors`.
2. `v` may be 0..=3 (PLAN says 0|1). 27/28 is rejected with a clear message, because nearcore would raise a host error for v > 3.
3. Deposit is ≥ 1 yocto (not exactly 1). One yocto goes to the signer and the excess is refunded to the caller. Storage for `register` and `announce` is measured exactly. Storage freed by an overwrite is not refunded (v1).
4. Extra methods and events beyond §1.8, all additive:
   - `sweep_digest` view: clients can check their digest against the contract.
   - `contract_source_metadata` (NEP-330, automatic).
   - `register` and `sweep` events.
5. Extra input checks:
   - `chain` must match `[a-z0-9:-]{1,32}`.
   - `ct` must be printable ASCII, 1..=1024 chars. PLAN S8 suggested a 512-byte cap. I chose 1024 chars so it fits base64 of about 760 bytes; the encoding is W1's choice.
   - `spend_pub` must start with 02 or 03 (it isn't checked to be on the curve, so the contract has no k256 dependency); `view_pub` must not be zero.
   - An ECDSA payload must be < n, which the MPC would reject anyway.
6. Size: `src/` without tests is 520 lines with doc comments and rustfmt. PLAN's budget was under 300, and the logic itself is about 250 lines. There is no k256 dependency; `ecrecover` and `sha256` are host functions.
7. Toolchain: pinned `rust-toolchain.toml` to 1.99.1, the same as the reproducible image. PLAN didn't specify a version. cargo-near 0.23 reports that bulk-memory opcodes are supported by the current nearcore VM (protocol 85), so no MVP workaround is needed.
8. Replay: a valid signed sweep can be resubmitted until `expires_block`, and the MPC signs the same payload again. That is harmless because the target chain's nonce or UTXO prevents a double spend. Any caller can use the contract as a signer only for stealth keys it controls, because `path` is bound to `sha256(K)` and must be signed by `K`.
9. PLAN facts verified as correct: F1, F3 (live), F4 (local derivation equals the view), F5 (`payload_v2` shape, 1 yocto, 15 Tgas minimum). Nothing I checked was wrong.

## TODOs outside contract/ (for the coordinator / owners)

- **Makefile (W2 section):** suggested lines:
  ```make
  build-contract:
  	cd contract && cargo near build non-reproducible-wasm && cp target/near/ghost_paths.wasm target/near/ghost_paths_abi.json res/
  build-contract-reproducible:
  	cd contract && cargo near build reproducible-wasm && cp target/near/ghost_paths.wasm res/
  deploy-testnet:
  	contract/scripts/deploy-testnet.sh
  test-contract-live:
  	LIVE=1 cargo test --manifest-path contract/Cargo.toml --test live_testnet -- --nocapture
  ```
  W5's `test-live` can call `test-contract-live`.
- **CI:** `make test-contract` runs `cargo test`, and the integration tests need **network and cargo-near**. near-workspaces downloads the `near-sandbox` binary, and the tests build the wasms with `cargo near` (set `GHOST_SKIP_WASM_BUILD=1` to reuse `target/near/*.wasm`). The CI job needs `cargo install cargo-near --locked` (or the prebuilt installer) and the `wasm32-unknown-unknown` target. The live test is a no-op without `LIVE=1`.
- **W5:** copy or link `contract/fixtures/live-sweep-testnet.json` into `demo/fixtures/`. Put the S2, S5 and S8 results above into `docs/SPIKES.md`.
- **W3:** the `GHOST_CONTRACT` default `v1.ghost-paths.testnet` exists. For `DEPLOY=1`, either reuse `scripts/deploy-testnet.sh` or mirror it in TS: create a faucet account, deploy `res/ghost_paths.wasm`, then call `new({signer_id})` with 30 Tgas.
- **README "Development":** reproducible build instructions:
  1. Commit everything. `reproducible-wasm` refuses a dirty tree and builds from the git HEAD.
  2. Run `docker pull sourcescan/cargo-near:0.22.0-rust-1.99.1`. The image digest in `Cargo.toml` was copied from the tripwire sibling and is **not yet verified**: check it against `docker inspect`, or update it from the cargo-near release notes.
  3. Run `cd contract && cargo near build reproducible-wasm`, then `cp target/near/ghost_paths.wasm res/`.
  4. Redeploy. The code hash becomes verifiable (NEP-330 build info), for example on SourceScan.

  The current `res/` wasm is a host build (`non-reproducible-wasm`).

## Code Garage

I searched for "near-sdk rust contract near-workspaces test mock cross-contract". Nothing applicable came up: the only NEAR item is the `near-sdk-rs` mirror (the SDK itself, `web3.chains.other-l1-sdks`). No garage code was used.
