# Track W3 (chains + CLI + relayer + demo): notes

Builder: Opus 5.5, 2026-11-09. Status: **done**. Every demo target passes on this host.

## Results

| Target | Result (this host) | What it does |
|---|---|---|
| `make demo` | **exit 0, 17/17 checks, 83–89 s** | NEAR testnet + real MPC (`v1.signer-prod.testnet`) via `v1.ghost-paths.testnet` (Mode B, relayer), anvil + solana-test-validator in docker. Without docker it runs the replay and says so. |
| `make demo-record` | exit 0 | Same as `demo`, and records every HTTP exchange into `demo/fixtures/replay/` (24 tapes, 480 KB). |
| `make demo-replay` | **exit 0, 17/17, 32 s** | `GHOST_REPLAY=1`: no network and no docker. The real CLI, SDK and relayer code runs against the recorded responses. |
| `make demo-replay-airgap` | exit 0, 17/17 | The same run inside a network namespace that has only loopback (`unshare -n`), proving it is offline. |
| `make demo-testnet` | **exit 0, 17/17, 110 s** | Sepolia + Solana devnet. lechu-wallet paid 0.001 ETH and 0.02 SOL, and the sweeps sent them back to lechu-wallet's own addresses (net cost is gas only). |
| `make demo-live` | exit 0, **refuses** | No `MAINNET_APPROVED=1` / mainnet contract / mainnet profiles → it lists what's missing, runs only the keyless 1Click dry quote, and spends nothing. |
| `make demo-clean` | ok | Undoes `KEEP=1`: stops the kept relayer, deletes the kept accounts (their NEAR returns to the funder), and runs `chains-down`. |
| `make web` (W4) after `KEEP=1 make demo` | ok | pay → scan → sweep through `ghost serve` (`/api/*`) against the live chains and the relayer. |
| `make test` | 61 pass, 0 fail (TS) + cargo | Mine: `packages/sdk/test/chains.test.ts` (13), `packages/cli/test/cli.test.ts` (4), `packages/relayer/test/relayer.test.ts` (3). All offline. |

Measured MPC latency through the contract: 6.0–7.2 s (ECDSA and EdDSA), compared with the PLAN's 15 s estimate. The Mode A fallback (`GHOST_MODE=account`, direct `v1.signer.sign`) was tested on sol:local: 6.0 s, works, and warns about the public link.

## Spikes

- **S3 anvil:** `ghcr.io/foundry-rs/foundry:latest` → `anvil --host 0.0.0.0 --chain-id 31337` is ready in about 2 s. A real MPC signature broadcasts fine on 31337.
- **S4 Solana local validator:** works, but only with two fixes (both are in `demo/docker-compose.yml`):
  1. Docker's default seccomp profile blocks io_uring, and agave 3.1.15 *asserts* io_uring support (`fs/src/dirs.rs: assertion failed: io_uring_supported()`), so it exits with code 101. Fix: `security_opt: seccomp:unconfined`.
  2. `--bind-address 0.0.0.0` panics in gossip. Binding the container's own IP (`$(hostname -i)`) works and keeps the port mapping usable.
  It is healthy in about 1 s, and `requestAirdrop` works. The image is 840 MB.
- **S6 1Click `confidentiality: basic`:** **401 without auth** ("User authentication is required for confidential intent quotes"), and the same for `advanced`. `public` dry quotes work keyless, with a default 20 bps `appFees` entry. `sweepQuote()` falls back to a public dry quote and says the mitigation needs `ONECLICK_API_KEY`. The README must not claim confidential sweeps work without a key.
- **S7 BTC (partial):** testnet4 derive (P2WPKH `tb1…`) and the esplora reads through mempool.emzy.de work. The sweep path (all UTXOs → one output, one payload per input, chainsig.js PSBT) passes offline against a fake esplora with a local key. There are no sats, so BTC is not in the demo (it's derive-only, per the PLAN cut line).

## Deviations from PLAN.md (reality won)

1. **The NEAR testnet faucet helper rate-limits per IP.** After about 10 accounts today it returned `HTTP 429: Rate limit exceeded, retry in 11 hours`. Per-run faucet accounts are therefore impossible. The demo now uses one cached **funder** (`.secrets/demo/funder.json`, created by a single faucet call per machine, or `DEMO_FUNDER_FILE`). Each run creates fresh top-level accounts from the funder through the `testnet` registrar (`create_account`, 0.5/0.5/1.5 NEAR) and **deletes them at the end** with the funder as beneficiary. A run costs about 0.03 NEAR. On this host the funder is `gp-alice-9b00b4ae68.testnet` (one of my faucet accounts, 9.8 NEAR left). The CLI does the same with `GHOST_FUNDER_FILE` (`ghost account create --fund N`, `ghost account delete --beneficiary`).
2. **The payer (alice) has no NEAR account** in the demo: the relayer posts her announcement. This is a better privacy story than the PLAN's "three faucet accounts".
3. **How replay works:** instead of hand-written fakes, `packages/sdk/src/chains/tape.ts` records and replays every `fetch` (NEAR RPC including MPC results, anvil, Solana, 1Click) per subprocess, and seeds a SHA-256 DRBG into `crypto.getRandomValues`, so replayed runs regenerate byte-identical keys and transactions. The fixtures are real traffic from a real testnet run. The funder's own transactions can't be signed identically in replay (its key isn't committed), so the tape falls back to matching by order for those calls. **Committed seed:** `demo/fixtures/replay/manifest.json` has the DRBG seed, which regenerates the run's throwaway testnet keys. Those accounts were deleted at the end of the recording, so the keys control nothing. I checked: no secret key appears in any tape (the `ed25519:` strings are tx and block signatures).
4. **The EVM sweep uses a legacy (EIP-155) gas price**, not EIP-1559, so the stealth balance goes to exactly 0. EIP-1559 left the unused max-fee as dust and the scan showed "unspent".
5. **demo-live without approval exits 0** after a clear refusal and a free dry quote. That keeps "refuses cleanly" from looking like a crash to judges. If any prerequisite is missing it refuses the same way, even with `MAINNET_APPROVED=1`. Only a fully configured run without `LIVE_RECIPIENT` exits 1.
6. **Docker needs sudo on this host.** The Makefile/demo try `docker`, then `sudo -n docker`, then fall back to replay.
7. The relayer also enforces `payloads.length == 1` and `v ∈ {0,1}` (W2's contract accepts 0–3), and rejects bad signatures or expired requests before spending gas.

## Files (W3)

- `packages/sdk/src/chains/`: `config.ts` (chain table, RPC env overrides `GHOST_RPC_<TAG>`, mainnet gate, exact units), `evm.ts`, `solana.ts`, `btc.ts`, `sig.ts`, `wallets.ts` (payers: local key, `FUNDER_*` env, lechu-wallet), `tape.ts`, `index.ts` (`getAdapter`). `packages/sdk/src/oneclick.ts`. Both are exported from `packages/sdk/src/index.ts`, as the coordinator asked.
- `packages/cli/src/`: `ghost.ts` (entry; `--json`, `--json-out`), `args.ts`, `context.ts` (profiles in `GHOST_HOME`, 0600 files), `output.ts`, `commands/{keys,pay,payers,scan,sweep,misc,index,types}.ts`. Commands: `account create|import|show|delete`, `init`, `register`, `meta`, `pay`, `scan`, `sweep` (incl. `--via-1click … --confidential … [--wet]`), `export-viewing-key`, `derive`, `balance`, `fund`, `quote`, `status`, `serve` (W4's `serve.ts`, loaded lazily). `runCommand()` in `commands/index.ts` is what `ghost serve` uses.
- `packages/relayer/src/server.ts`: `POST /announce`, `POST /sweep`, `GET /health`, a tx mutex, local verification, and a 64 KB body cap. `RELAYER_KEY_FILE` or `RELAYER_AUTO_CREATE=1`.
- `demo/demo.ts` (modes local / replay / testnet / live / record / clean), `demo/docker-compose.yml`, `demo/tsconfig.json`, `demo/fixtures/replay/*` (recorded run), `demo/fixtures/live-sweep-testnet.json` (W2's fixture, copied).
- Makefile W3 section: `demo demo-record demo-replay demo-replay-airgap demo-testnet demo-live demo-clean chains-up chains-down relayer ghost`. W2 section: `build-contract`, `deploy-testnet` (added at the coordinator's request). Root `package.json`: a `build` script for apps/web (W4's request). `args.ts`: `--dev` is now boolean (W4's request).

## Notes for other tracks

- **W5 (docs):** `ghost` = `bun packages/cli/src/ghost.ts` (or `make ghost ARGS=…`). The `--json` output of every command is one object `{ok, command, …}`; the fields are in the `*Result` interfaces in `commands/*.ts`. The demo output in §1.10 is what `make demo` prints. Step 8 is a keyless *public* dry quote, because confidential needs a key (S6). Re-record the replay with `make demo-record` whenever the CLI's request sequence changes (it is a byte-level tape). The `tape.ts` tests and the replay target catch drift.
- **W4:** `WEB_HOME` takes `ls -d .secrets/demo/*/home | tail -1` (lexical order). Runs without `KEEP` now delete their `home/`, so only kept runs match, but `ls -td` would be more robust. `KEEP=1 make demo` leaves the relayer running (pid in `<run>/relayer.pid`); `make demo-clean` stops it.
- **W6 (review):** the tape DRBG makes randomness deterministic. It only runs when `GHOST_TAPE` + `GHOST_TAPE_SEED` are set (record/replay), never in normal use. Mainnet spending is gated in `assertSpendAllowed` (pay, sweep) and in `OneClick.quote` (non-dry). I never ran the live path with approval.
- The lechu-wallet tx-hash parsing (`extractTxHash`) is verified for sepolia and solana-devnet output only.
