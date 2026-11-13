# DEMO: exact commands and expected output

Everything here was run on 2026-11-09 (Linux, bun 1.4.3, docker 29); `make demo-testnet` was run by the demo's author earlier the same day and not re-run for this page (it spends test funds). Timings vary; hashes, addresses and account names differ on every run (accounts are `gp-<name>-<random>.testnet`).
`ghost` below means `bun packages/cli/src/ghost.ts`.

| Command | Needs | Time | Ends with |
|---|---|---|---|
| `make demo-replay` | bun | 33 s | `demo OK: 17/17 checks passed in 33 s (replayed, offline)` |
| `make demo` | bun, docker, network | 82 to 90 s | `demo OK: 17/17 checks passed in 82 s` |
| `DEMO_NATIVE_CHAINS=1 make demo` | bun, `anvil` and `solana-test-validator` on PATH, network | about 90 s | the same; for Apple Silicon, where the agave docker image has no arm64 build (and crashes under x86 emulation) |
| `KEEP=1 make demo` then `make web` | the same | 90 s + UI | UI at `http://127.0.0.1:8788`; undo with `make demo-clean` |
| `make web-sim` | bun | 3 s | `ghost serve (dev: simulated chains, no network) on http://127.0.0.1:8788`, then `open http://127.0.0.1:8788/?token=…` (open that URL) |
| `make test-ts` | bun | 42 s | `82 pass`, `5 skip`, `0 fail` |
| `make test-live` | bun, network | 15 to 20 s | `3 pass` (ECDSA and EdDSA signed by the real MPC) |
| `make demo-testnet` | bun, network, payer keys | 110 s | `17/17` on Sepolia and Solana devnet |
| `make demo-live` | bun, network | 4 s | `demo-live refused cleanly (dry run only).` |

## The demo script (what `make demo` prints)

Each block starts with `[elapsed] N. title  (script 0:MM)`; the last number is where that step falls in the 2-minute video script.

1. **`[0:00] 1. Infrastructure`**: starts anvil and a local Solana validator in docker (skipped in replay), creates `bob`, `carol` and `relayer` NEAR testnet accounts from a cached funder, starts the relayer on `:8787`, and runs `ghost status`.
   See: `root keys ok (v1.signer-prod.testnet public_key matches chainsig.js for domains 0 and 1)`, `contract v1.ghost-paths.testnet deployed`, `mode contract (Mode B)`, and four green checks. `alice` has no NEAR account: the relayer posts her announcements.
2. **`2. Bob creates his keys and registers one meta-address`**: `ghost init --as bob`, `ghost register --as bob`.
   See: `handle ghost:gp-bob-....testnet`, `spend pub (secp256k1)`, `view pub (X25519)`, `You hold two keys and no BTC/ETH/SOL key`, and a `https://testnet.nearblocks.io/txns/...` link. `carol` registers too, as a stranger.
3. **`3. Alice pays bob 0.01 ETH on evm:31337`**: `ghost pay bob 0.01 ETH --chain evm:31337 --as alice --memo "invoice #42"`.
   See: `one-time address 0x... = MPC-derive(predecessor v1.ghost-paths.testnet, path gp1/..., domain 0)`, the payment tx, and `announcement idx 18: chain evm:31337, eph ..., tag 0x0e (no recipient field)`.
4. **`4. Alice pays bob 0.1 SOL on sol:local`**: same with `--chain sol:local`. See a base58 Solana address derived with `domain 1` (ed25519).
5. **`5. Who can see the payments? stranger, recipient, auditor`**:
   - `ghost scan --as carol --since 18`: `carol scanned 2 announcements: 0 payments`
   - `ghost scan --as bob`: `bob scanned 20 announcements: 2 payments`, a table with both addresses, balances `0.01 ETH` and `0.1 SOL`, memos `invoice #42` and `invoice #43`, status `unspent`
   - `ghost export-viewing-key --as bob --out bob.view.json`, then `ghost scan --viewing-key bob.view.json`: the same 2 payments and `viewing key only: no spend key, cannot sweep`
6. **`6. Bob sweeps idx 18 (evm:31337)`**: `ghost sweep 18 --to 0x... --as bob`.
   See: `sending 0.0099... ETH, network fee 0.00004... ETH` (shown before anything is signed; fees above 20% are refused), `relayer submits v1.ghost-paths.testnet.sweep(path gp1/..., k_pub ...); waiting for the MPC...`, `MPC signature in 6 to 16 s`, the chain tx hash, `destination balance 0.00995 ETH`, and
   `On NEAR: the relayer asked the contract to sign path gp1/...; nothing names the recipient.`
7. **`7. Bob sweeps idx 19 (sol:local)`**: the same on Solana (`destination balance 0.099995 SOL`), then `ghost scan --as bob` shows both payments `swept` with balance 0.
8. **`8. 1Click dry quote`**: `ghost quote --chain evm:8453 --amount 0.002 --to usdc:sol --recipient <addr> --confidential basic`.
   See: `1Click dry quote: 0.002 ETH -> ~4 usdc:sol` and `confidentiality public (wanted basic)` with the note that `basic` needs `ONECLICK_API_KEY`. Nothing is sent. The confidential sweep itself is not demonstrated.

The run ends with the funder getting its NEAR back (`ghost account delete ... --beneficiary`) unless `KEEP=1`.

## Do it by hand with the CLI

After `KEEP=1 make demo` (chains and relayer stay up):

```bash
export GHOST_HOME=$(ls -dt $PWD/.secrets/demo/*/home | head -1)   # the kept run's profiles: alice, bob, carol, relayer
export GHOST_RELAYER_URL=http://127.0.0.1:8787                     # without it the CLI tries to create a NEAR account for alice
alias ghost='bun packages/cli/src/ghost.ts'

ghost status                                                       # root keys ok, contract ok, relayer ok, chains ok
ghost pay bob 0.01 ETH --chain evm:31337 --as alice --memo "invoice #44"
ghost scan --as bob                                                # the new payment, 0.01 ETH, unspent
ghost scan --as carol                                              # 0 payments: she is a stranger
ghost export-viewing-key --as bob --out /tmp/bob.view.json
ghost scan --viewing-key /tmp/bob.view.json                        # auditor view; "cannot sweep"
ghost sweep 20 --to 0x2222222222222222222222222222222222222222 --as bob   # use the idx printed by scan
ghost scan --as bob                                                # swept
make demo-clean                                                    # stops everything, returns the NEAR to the funder
```

`ghost sweep` without `--as` refuses (`this command needs --as <profile>`): a viewing bundle has no spend key. The auditor view shows swept payments as `unfunded` (it has no local record of the earlier balance).
Other commands: `ghost derive` (offline), `ghost balance ADDR --chain TAG`, `ghost meta ACCOUNT`, `ghost fund` (local chains only), `ghost serve`. `ghost --help` lists them.

### `--json`

Every command takes `--json` and prints one object `{"ok": true, "command": "...", ...}`. Shapes (from `packages/cli/src/commands/*.ts`):

- `scan`: `{as, account, kind: "keystore"|"viewing-key", can_sweep, scanned, payments: [{idx, chain, address, path, balance, balance_base, symbol, memo: {amount, asset, note, txid}, swept}]}`
- `pay`: `{payer, recipient, chain, amount, asset, predecessor, path, address, domain_id, eph, tag, pay_tx, announce_tx, idx, announced_via}`
- `sweep`: `{idx, chain, from, to, path, mode, via, amount, symbol, near_txs: [{tx_hash, tx_url}], mpc_ms: [..], chain_tx, dest_balance_after}`

## Offline derivation, no network

```bash
bun packages/cli/src/ghost.ts derive --chain evm:1 --predecessor v1.ghost-paths.testnet --path gp1/$(printf 'ab%.0s' $(seq 32))
#   address      0x5c7dad9d2e0B89E71F3ceB876c270AB1013CcAb9
bun packages/cli/src/ghost.ts derive --chain sol:devnet    --predecessor v1.ghost-paths.testnet --path gp1/$(printf 'ab%.0s' $(seq 32))
#   address      8f6Pmk8tuN6sFbMXoSF1FFz2wGmZkk1q72PMdw7zpUvm
bun packages/cli/src/ghost.ts derive --chain btc:testnet4  --predecessor v1.ghost-paths.testnet --path gp1/$(printf 'ab%.0s' $(seq 32))
#   address      tb1qshvntagprslsmtj9306x4nlwgkwq54fl8xucmu
```

These equal what `v1.signer-prod.testnet`'s `derived_public_key` view returns for the same `(predecessor, path)` (recorded 2026-11-09; re-checked live by `bun test packages/sdk` without `GHOST_REPLAY=1`, which makes free RPC view calls, and by `make test-live`).
Bitcoin is derive-only: nothing is paid to that address in the demo.

## Two people, real wallets (MetaMask on Sepolia)

The product as it is used, with nothing simulated and no demo shortcut: the payer pays from MetaMask on a page that holds no
keys, the recipient sees it in their own app and withdraws to their own wallet. NEAR testnet + Ethereum Sepolia.

| Who | Where | Holds |
|---|---|---|
| Payer (Alice) | `http://127.0.0.1:8790/pay.html` (static; hostable, see [HOSTING.md](HOSTING.md)) | nothing: MetaMask signs |
| Recipient (Bob) | `http://127.0.0.1:8791/?token=…` (`ghost serve`, his own app) | only Bob's seed |
| Relayer | `http://127.0.0.1:8792` | its own NEAR testnet account |

**One-time setup** (testnet; a funder is any testnet account you control, as JSON `{account_id, secret_key}`, e.g. the
`.secrets/demo/funder.json` that `make demo` creates). Pick a free name for the recipient:

```bash
D=.secrets/demo/two-party; mkdir -p -m 700 $D/bob-home $D/relayer-home
export GHOST_NETWORK=testnet GHOST_FUNDER_FILE=.secrets/demo/funder.json
GHOST_HOME=$D/bob-home     bun packages/cli/src/ghost.ts account create --as bob --account-id yourname.testnet --fund 0.5
GHOST_HOME=$D/bob-home     bun packages/cli/src/ghost.ts init --as bob
GHOST_HOME=$D/bob-home     bun packages/cli/src/ghost.ts register --as bob      # see: registered yourname.testnet + NEAR tx
GHOST_HOME=$D/relayer-home bun packages/cli/src/ghost.ts account create --as relayer --fund 1
```

**Run**

```bash
make two-party
```

See: `check-bundle: … no secrets found`, then the relayer, the recipient app and the pay page start, and two URLs: the payer's
`http://127.0.0.1:8790/pay.html?to=yourname.testnet` and the recipient's `open http://127.0.0.1:8791/?token=…`. Ctrl-C stops all three.

Open them in two browser windows. MetaMask needs a little Sepolia ETH in the payer's account.

1. **Pay page.** **Connect MetaMask** (top right; it then shows the address and its Sepolia balance). The recipient field shows
   **Ready**, read live from the NEAR registry. Enter an amount (0.001) and an optional note, **Send 0.001 ETH privately**.
   MetaMask asks to switch to Sepolia if needed, then shows a plain transfer to an address you have never seen: **Confirm**.
   See: three steps (confirm in your wallet, Sepolia confirms, encrypted note on NEAR), then **Sent privately** with the
   one-time address and the path picture. **Technical details**: the Sepolia tx, the NEAR note tx (sent by the relayer's
   account, not yours), and the note itself, which has no recipient field.
2. **Recipient app.** Within about 10 s, without clicking anything, **Inbox** shows the payment, its amount and the decrypted note.
   There is no Send tab: this app belongs to the recipient and holds no payer wallet.
3. **Withdraw** → **Use my wallet's address**: MetaMask's account picker opens (pick the recipient's own account; nothing is
   signed, it only reads the address). **Withdraw**. See: approving with your key, NEAR signs the transfer (5 to 10 s, the
   MPC network signs for the one-time address), then `+0.000999 ETH arrived at 0x…` with the balance before and after. The
   NEAR record shows the relayer and the contract requesting a signature for an opaque path; nothing names the recipient.
4. **What others see**: the public record, with 0 payments traced to anyone.

Measured on 2026-11-13 (the dry run before recording): the relayer posted the note in 3.4 s; the withdrawal's MPC signature
took 5.7 s; 0.000999 of 0.001 ETH arrived (the rest paid the Sepolia gas of the withdrawal).

## Web UI

```bash
KEEP=1 make demo && make web        # open the printed http://127.0.0.1:8788/?token=… URL; live: real NEAR testnet + local chains
make web-sim                        # open the printed http://127.0.0.1:8788/?token=… URL; simulated chains, nothing else needed
```

- **Send**: from `alice`, recipient `bob` (the field shows `Ready` when bob is set up), ETH or SOL, amount, optional note (encrypted for bob). The receipt shows bob's new one-time address and the path picture; **Technical details** has the payment tx, the NEAR note tx, the derivation (`v1.ghost-paths.testnet` + `gp1/...`) and everything NEAR recorded (no recipient field).
- **Inbox** (was Scan + Sweep): bob's key finds his payments with the notes decrypted, and the total ready to withdraw. **Withdraw** opens in the row: destination pre-filled with an empty test address on local chains, "Privacy options" for the route (Private via the relayer, from my NEAR account, or a 1Click quote). See `+delta` arriving, then **Technical details** for the NEAR tx, the MPC time and the chain tx.
- **What others see** (was "As a stranger"): a random key reads the whole public record and traces `0` payments; the record has no recipient column; the honest limits are listed below it.
- **Accountant** (was Auditor + "As an auditor"): drop a viewing key file (or the demo shortcut), then stats, search, table and **Download CSV** (cells starting with `= + - @` are neutralised). It can never withdraw.

Screenshots from a live run: `docs/img/ui-send.png`, `docs/img/ui-inbox.png`. The Playwright smoke test (`make web-e2e`) drives the simulated server; against a kept live run it needs an empty state
(`GHOST_E2E_URL=http://127.0.0.1:8788 make web-e2e` expects exactly one payment, so on a kept run it stops at the inbox assertion after the Send step has already worked).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `helper HTTP 429: Rate limit exceeded` | The NEAR testnet faucet helper limits per IP. Run `DEMO_FUNDER_FILE=/path/funder.json make demo` (also for `make test-live` and `make demo-clean`; `GHOST_FUNDER_FILE` is the CLI's name for it) with a JSON `{"account_id","secret_key"}` of any testnet account with at least 3 NEAR, or use `make demo-replay`. |
| `make demo` prints `docker not available: running the offline replay` | Expected without docker (the Makefile also tries `sudo -n docker`). |
| MPC signing takes over 30 s or fails | The testnet MPC is slow or down. Retry, or `make demo-replay`. |
| First `make demo` is slow | It pulls about 1 GB of docker images once (anvil and the Solana validator). |
| `make web` says `no demo profiles found` | Run `KEEP=1 make demo` first, or use `make web-sim`. |
| Port 8788 busy | `GHOST_SERVE_PORT=8799 make web-sim` |
| Pay page: "origin not allowed" | The relayer's `RELAYER_CORS_ORIGINS` must list the pay page's origin (`make two-party` sets it). |
| Pay page: "No Ethereum wallet in this browser" | Install MetaMask. In Brave, also set Settings → Web3 → Default Ethereum wallet to "Extensions (no fallback)" if Brave Wallet answers instead. |
| `make test` prints `SKIPPING the Rust contract tests` | Install Rust, `cargo-near` and the `wasm32-unknown-unknown` target to run them; the TypeScript tests already ran. |
