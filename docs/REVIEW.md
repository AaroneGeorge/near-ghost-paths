# Ghost Paths: independent security and privacy review (W6)

Reviewer: W6 (Claude Opus 5.5), 2026-11-09, against commit `1b091fb`. Round 1 fixes (H2, H3) are in `6dcbb61`; round 2
(every other finding except H1, at the coordinator's request) is in the working tree on top of it.
Scope: `docs/SPEC.md`, `docs/THREAT-MODEL.md`, `README.md`, `contract/src/*.rs`, `packages/sdk/src/**`,
`packages/relayer`, `packages/cli` (including `ghost serve`), and enough of `apps/web` and `demo/` to check the claims.
This is a design-level code review by one reviewer. It is not an audit. Nothing was redeployed.

## Summary

The core cryptography holds. KDF domain separation, the X25519 ECDH, the tweak, the path, the memo AEAD and the
sweep authorisation all match the spec, and the digest binds the contract, path, domain, expiry and the exact payload.
The digest therefore also binds the destination for all three chain adapters. I found no way for a relayer, a payer or a
front-runner to redirect funds, and no signature malleability or replay that matters.

The findings are in the system around the cryptography:

- a one-transaction, permanent denial of service against any recipient's scan (fixed);
- a web-UI default that burns swept funds on non-local chains, which the threat model presented as a privacy feature (fixed);
- the live testnet contract account still has a full-access key (documented; the owner deletes it on Nov 14);
- privacy leaks to target-chain RPC providers that the threat model did not mention (now documented);
- hardening gaps in the relayer and `ghost serve`, in contract pinning, and in fee and chain-id handling (fixed).

| # | Severity | Title | Fixed |
|---|---|---|---|
| H1 | high | `v1.ghost-paths.testnet` still has a full-access key: its holder can redeploy and spend every stealth address of the deployment | **n**: owner action, Nov 14 (documented) |
| H2 | high | Anyone can permanently break any recipient's `scan` (CLI, web, auditor) with one announcement on an unsupported chain tag | **y** (6dcbb61) |
| H3 | high | Web UI pre-fills an unspendable "fresh throwaway" sweep destination (burn), presented as the consolidation mitigation | **y** (6dcbb61; docs in round 2) |
| M1 | medium | Balance lookups give target-chain RPC providers the full set of a recipient's stealth addresses, linked to one client | **y** (documented; no code change) |
| M2 | medium | Default mainnet contract id `ghost-paths.near` is unregistered (squattable), and clients never verify the contract's code | **y** (pinned code hash; mainnet unpinned, so refused) |
| M3 | medium | Relayer: no auth, no rate limit, `Access-Control-Allow-Origin: *`; any web page can drain its NEAR through `/announce` | **y** |
| M4 | medium | `ghost serve` has no authentication; on a non-loopback `--host` the `Host` check is the only barrier and is trivially bypassed | **y** |
| L1 | low | Chain adapters trust the RPC for the EVM chain id and for fees (EVM gas price, BTC fee rate), with no cap and no confirmation | **y** |
| L2 | low | The deterministic-RNG "refuses mainnet" guard in the tape module is not implemented | **y** |
| L3 | low | Duplicate announcements (anyone can re-post one) are reported twice; auditor totals double-count | **y** |
| L4 | low | Without `GHOST_RELAYER_URL` the CLI silently defaults Mode B sweeps to self-submission (linkable); README said the default is the relayer | **y** |
| L5 | low | The payer trusts the NEAR RPC for `get_meta`; there is no fingerprint to check a meta-address out of band | **n** (not in the round-2 list) |
| L6 | low | `export-viewing-key` does not tighten the permissions of a pre-existing file | **y** |
| I1–I9 | info | Notes that need no fix; the wording items in I8 are fixed | I8 **y**, others n |

**Verification (after round 2):**
- `make test`: 82 pass, 5 skip, 0 fail, and Rust 24 + 2 + 1.
- `make demo-replay`: 17/17.
- `make web-e2e`: SMOKE PASSED.
- `make demo-record`: live, 17/17 in 95 s.

The round-2 changes add a `view_account` call before `pay`, `register` and `sweep` (M2), so I re-recorded `demo/fixtures/replay/` with `make demo-record`
(NEAR testnet plus docker, 2026-11-08T22:53Z UTC). The new tapes hold HTTP traffic and the throwaway seed only. The run's bob, carol and relayer accounts are deleted on
testnet; I checked them with `UNKNOWN_ACCOUNT`. Tests added: H2 (round 1); M3, M4, M2, L2, L3 and L4 (round 2). README.md:61 and docs/DEMO.md:12 now say `82 pass`.

---

## What was checked and holds

- **KDF domain separation** (`packages/sdk/src/constants.ts:9-18`, `stealth.ts:61-99`). HKDF-SHA256 uses the constant salt `ghost-paths/v1` and distinct `info` labels:
  `spend`, `view` (IKM = seed), `tweak`, `memo` (IKM = S). The view tag is a separately prefixed SHA-256. The tweak's info is
  `"tweak" || E(32) || P_spend(33) || chain`, so only the last field has variable length and the encoding is injective. Binding `P_spend` and
  `chain` into `h` means one announcement yields exactly one address on one chain. Reducing a 32-byte value mod n has a bias near 2^-128, which is negligible.
- **ECDH** (`stealth.ts:81-86`, `scan.ts:35-42`). X25519 via noble. All-zero shared secrets are rejected on both the send and scan sides,
  which covers low-order `P_view` and `E`. `parseMeta` checks that `P_spend` is on the curve.
- **Memo AEAD** (`announce.ts:19-65`). The key is HKDF(S, "memo"), unique per announcement. The nonce is 24 random bytes (XChaCha), and the AAD is
  `E || chain`. Decryption failure returns null, and the scan then drops the hit. Nonce handling is sound; even a nonce repeat would not
  matter, because the key never repeats.
- **Stealth math** (`stealth.ts:102-131`). `K = P_spend + h·G` rejects infinity, and `d_K = d_spend + h mod n` rejects zero. `buildSweepArgs` checks
  `d_K·G == K` before signing. The path `gp1/ || hex(sha256(x||y))` is checked in exactly that form by the contract (`sweep.rs:134-138`).
- **Sweep digest** (`sweep.rs:27-50`, `stealth.ts:207-232`). The digest is SHA-256 over
  `tag || contract_id || path || u8 domain || u64be expiry || u8 n || (u16be len || payload)*`. It is injective as argued in
  `contract/SWEEP-MESSAGE.md`, because account ids cannot contain `/` and the path has a fixed format. The contract computes the digest from its own
  `current_account_id`, which gives deployment binding. Domain, expiry and payload are all bound. Changing any of them gives `bad_signature`; unit tests cover the
  payload, expiry and key cases.
- **ecrecover** (`sweep.rs:139-153`). `malleability_flag = true` rejects high-s signatures. `v` must be 0..=3 (27/28 rejected), and the recovered key must equal `k_pub`
  byte for byte. Malleability would not matter anyway, because nothing is keyed on the signature.
- **Relayer cannot redirect.** The EVM payload is keccak(unsigned EIP-155 tx) and includes `to`, `value`, `nonce` and `chainId` (`chains/evm.ts:101-112`).
  The Solana payload is the full message (`solana.ts:89-97`). BTC payloads are BIP143 SIGHASH_ALL sighashes, which commit to all outputs (chainsig.js
  `prepareTransactionForSigning`). The client verifies the MPC signature the relayer returns against the stealth address before
  broadcasting (EVM `recoverTransactionAddress`, Solana `verifySignatures`). For BTC a bad signature only makes the broadcast fail.
- **Replay and front-running.** A sweep can be resubmitted by anyone until `expires_block`, which is inclusive. Every resubmission yields an MPC signature on the *same*
  payload. The MPC signature becomes public in the NEAR receipt, so anyone can broadcast the target-chain transaction first, but it is the
  recipient's own transaction. The EVM nonce, the BTC UTXOs and Solana's blockhash and status cache prevent double execution. The only cost falls on whoever resubmits.
- **Storage and refunds** (`util.rs:26-46`, `announce.rs:85-100`, `registry.rs:62-73`). Each caller pays for the bytes it adds, and the excess is refunded to
  the predecessor. The sweep keeps 1 yocto and refunds the rest. The contract's own balance cannot be drained. Overwrites are not refunded; this is documented.
- **Access control.** `register` is keyed by the predecessor. There is no owner method. `new` is `#[init]` and is deployed with the init call in the same transaction
  (`deploy-testnet.sh`), so it cannot be front-run. Only `sweep` calls the signer, and only for `gp1/` paths that the contract has authorised.
- **Secrets in the CLI.** Keystores and NEAR and wallet credentials are written 0600 in 0700 directories. `account import` takes the key from the environment, not argv.
  No command's JSON output carries a secret. I found no secret in tracked files: the tape seed in
  `demo/fixtures/replay/manifest.json` regenerates only the per-run accounts, and they were deleted. I checked on testnet: bob, carol and the relayer of
  that run are `UNKNOWN_ACCOUNT`. The cached funder was created outside the tape, so the seed cannot reproduce its key.
- `ghost serve` static files cannot escape `apps/web/dist`. Foreign `Host` and `Origin` headers are refused, and `Origin: null` fails closed.

---

## Findings

### H1 (high, not fixed): the testnet contract account still has a full-access key

- Where: `README.md:207`, `docs/THREAT-MODEL.md:72-77`. Checked on 2026-11-09 with `view_access_key_list v1.ghost-paths.testnet`: one `FullAccess` key
  (`ed25519:Akhn79Sm…`). Its secret is in `.secrets/near/v1.ghost-paths.testnet.json` on the dev host.
- Failure: whoever holds that key, or anyone who compromises the dev host, deploys a contract whose `sweep` skips `ecrecover`. They then
  request MPC signatures for any `gp1/…` path. Every stealth address ever derived for `v1.ghost-paths.testnet`, on every chain, can be spent. The key holder
  can also delete the account and have the parent re-create it with any code, which has the same effect.
- This is documented honestly, but it is the largest trust item in the project, and "will be deleted before judging" is still pending.
- Fix: `near account delete-keys v1.ghost-paths.testnet …` (the contract has no `add_key` method, so the account becomes immutable).
  Then confirm `view_access_key_list` returns `[]` and update README.md:207. Optionally pin and verify the code hash in the CLI (see M2).
- **Status: not fixed**, by decision. The owner deletes the key on Nov 14, then updates README.md:207. The M2 code-hash pin does not cover this:
  a redeploy changes the code hash, so clients would refuse it, but the funds already sit at addresses that the redeployed contract can sign for.

### H2 (high, fixed): one announcement permanently breaks any recipient's scan

- Where: `packages/cli/src/commands/scan.ts` (`scanFor`, the `getAdapter(chain)` call in the balance lookup, and `chainInfo(p.chain).symbol`).
  Also `packages/sdk/src/scan.ts` (`toPayments`, `lookup(hit.chain)`) and `packages/sdk/src/chains/config.ts:206-208`
  (`chainInfo("evm:<unknown id>")` throws `no RPC for …`).
- Failure: `P_view` is public. Mallory picks `e`, computes `S` and the tag for Bob, and announces with chain `evm:424242`; `isChainTag` accepts any
  `evm:<id>` and the contract accepts it too. Bob's scan matches it (the tag and the memo AEAD are both valid), and `getAdapter` throws. `Promise.all` rejects, so
  `ghost scan --as bob`, the web Scan and Sweep tabs, and the auditor's `--viewing-key` scan all fail. The log is append-only, so
  this lasts forever, and it costs Mallory about 0.0013 NEAR. Reproduced with a script before the fix.
- Fix applied: `scanFor` catches adapter construction errors and keeps the hit as a row with `balance_error` (symbol `?`). `toPayments` treats a
  throwing lookup as "no adapter". There is a regression test: `packages/sdk/test/announce-scan.test.ts` › "scan robustness (REVIEW W6-H2)".
- Residual: an attacker can still add any number of unfunded rows to a victim's scan. Each costs one balance RPC; see L3 for dedupe.

### H3 (high, fixed in the server): the web UI's default sweep destination is a burn address

- Where: `packages/cli/src/serve.ts:129-138` (`freshDestination`) derives an address from `("throwaway.testnet", gp1/<random>)` and throws the path away.
  `apps/web/src/tabs/Sweep.tsx:109-124` pre-fills it whenever a payment is picked ("Fresh throwaway address").
  `docs/THREAT-MODEL.md:61` says: "Mitigation: use a fresh destination for every sweep (the web UI pre-fills one)".
- Failure: nobody can ever produce a signature for that address. `throwaway.testnet` exists (someone else's account), but the path is a discarded 256-bit
  random value. A user who accepts the default on any chain where the funds matter (Sepolia, devnet, or Base once `GHOST_CHAINS` includes it) burns the whole
  payment. The threat model presents this as the privacy-preserving default.
- Fix applied: in live mode, `GET /api/fresh-destination` now returns 400 unless the chain is local (anvil, local validator, regtest), with the message
  "it would be unspendable (burn). Enter a fresh address you control." The simulated (`--dev`) backend is unchanged, so `make web-sim` and `web-e2e` still work.
- Round 2: THREAT-MODEL.md:61 now says to use a fresh destination *you control* and calls the button demo-only. A spendable fresh destination
  (for example a new stealth address to the recipient's own meta-address, announced like any payment) remains a possible feature.

### M1 (medium, not fixed): target-chain RPCs learn the set of a recipient's addresses

- Where: `packages/cli/src/commands/scan.ts` (`toPayments` → `adapter.getBalance(addr)` for every hit), `sweep.ts:361,451`. The web and auditor scans
  go through the same path. `docs/THREAT-MODEL.md:25` lists only "NEAR validators / RPC providers".
- Failure: every scan asks one EVM RPC, Solana RPC or esplora instance for the balances of exactly the recipient's stealth addresses, from one IP, in one burst,
  and repeats this on every refresh. The operator links all of them to each other and to the client, which is exactly the unlinkability the product sells.
  An auditor's scan leaks the same set. NEAR-side scanning is fine, because it downloads the whole log.
- Fix: document it in the actors table. Recommend your own node, Tor, or decoy lookups (for example, query balances for every announcement's
  derivable address in the page, or for a random superset). Reading balances in bulk from an indexer also avoids the per-address leak.
- **Status (round 2): documented.** THREAT-MODEL.md has a "Target-chain RPC / indexer providers" row in the actors table, and README's
  "Not hidden" list has a bullet for it. No code change: decoy lookups or an own-node default are a design change.

### M2 (medium, not fixed): squattable default mainnet contract and no contract verification

- Where: `packages/sdk/src/constants.ts:36-39` (`mainnet: "ghost-paths.near"`), `packages/cli/src/context.ts:230`. Checked on 2026-11-09:
  `ghost-paths.near` is `UNKNOWN_ACCOUNT` on mainnet.
- Failure: anyone can register `ghost-paths.near` and deploy a contract whose `sweep` needs no signature. A user who runs the CLI with
  `GHOST_NETWORK=mainnet` and without `GHOST_CONTRACT` reads metas from it and pays to `derive(ghost-paths.near, path)`, and the squatter spends everything. The
  same holds for any typo in `GHOST_CONTRACT`. `pay` derives the predecessor from configuration and never checks the code hash or access keys. (Spending is gated
  by `MAINNET_APPROVED=1`, which is why this is not rated higher.)
- Fix: no default contract on mainnet (require an explicit `GHOST_CONTRACT`). Before `pay`/`register`, check `view_account.code_hash` against the
  released wasm hash and `view_access_key_list == []`, and refuse or warn otherwise.
- **Status (round 2): fixed.** `PINNED_CODE_HASH` (`packages/sdk/src/constants.ts`) pins testnet to `Gep6ZYfa43r5ZJk97EAma1GjyPfuXrfcvTDPbJXN1fF6`
  (= `contract/res/ghost_paths.wasm`); mainnet is `undefined`. `verifyContractCode()` (`packages/sdk/src/near.ts`) compares `view_account.code_hash`, and
  `Ctx.checkContract()` (`packages/cli/src/context.ts`) runs it once per process before `pay`, `register` and `sweep`. Mainnet with no pin refuses ("no pinned
  Ghost Paths code hash"), and `make demo-live` lists `GHOST_CODE_HASH` as missing. Developers with a rebuilt wasm set `GHOST_CODE_HASH`. Contracts made by
  `make deploy-testnet` from the committed wasm have the same hash, so they pass. The mainnet default id is unchanged and no mainnet account was registered.
  Access keys are not checked (H1 would fail it today).

### M3 (medium, not fixed): the relayer can be drained, and any web page can drive it

- Where: `packages/relayer/src/server.ts:71,116-124` (`access-control-allow-origin: *`, `OPTIONS` allows POST with `content-type`), `:136-162`
  (no auth, no rate limit, no dedupe).
- Failure: any page the user visits can `fetch("http://127.0.0.1:8787/announce", …)` in a loop. Each call costs the relayer about 0.0013 NEAR of storage plus gas,
  and fills the public log with junk that every scanner must process. Bound publicly, which is the intended deployment for a relayer, the same works from
  anywhere. `/sweep` will also resubmit any valid public sweep until it expires (copied from a NEAR receipt), spending relayer gas each time.
- Fix: drop the wildcard CORS header (the CLI does not need CORS), add per-IP rate limits and a cap on announcements per minute, cache sweep `(path, digest)`
  submissions until `expires_block`, and require a small fee or proof of payment for `/announce` if the relayer is ever public.
- **Status (round 2): fixed** (`packages/relayer/src/server.ts`). Any `Origin` outside `RELAYER_CORS_ORIGINS` (default `http://127.0.0.1:8788`,
  `http://localhost:8788`) gets 403, including no-preflight `text/plain` POSTs, and the wildcard header is gone. POSTs require JSON. There is a per-IP limit
  (`RELAYER_RATE_PER_IP`, 30/min) and a global one (`RELAYER_RATE_GLOBAL`, 120/min) that answer 429. `RELAYER_TOKEN` is an optional Bearer secret (the CLI sends
  `GHOST_RELAYER_TOKEN`, compared in constant time), and `RELAYER_ALLOW_IPS` is an optional allowlist. A sweep with the same args is answered from a 20-minute cache, so
  replays spend nothing. The relayer logs a warning when it binds a non-loopback host with neither token nor allowlist. All of these are off or permissive by default, so
  `make demo` needs no configuration. Tests are in `packages/relayer/test/relayer.test.ts` › "relayer abuse limits".

### M4 (medium, not fixed): `ghost serve` is unauthenticated

- Where: `packages/cli/src/serve.ts:377` (`--host` / `GHOST_SERVE_HOST`), `:435-437`.
- Failure: the server holds every local keystore and can `pay` and `sweep` with any destination. Its only protections are the loopback bind and a `Host`/`Origin`
  check, which defend against browsers (DNS rebinding, CSRF) and not against other clients. With `--host 0.0.0.0`, which TRACK-4-NOTES suggests for remote viewing,
  `curl -H 'Host: localhost' http://<ip>:8788/api/sweep -d '{"pos":["3"],"flags":{"as":"bob","to":"<attacker>"}}'` sweeps Bob's funds. Any local
  user or process on a shared host can do the same over loopback, and `/api/viewing-bundle` hands out view keys.
- Fix: refuse a non-loopback bind unless `GHOST_SERVE_TOKEN` is set, and require it as a bearer token on every `/api/*` route. On shared hosts, bind a
  0700 Unix socket instead.
- **Status (round 2): fixed** (`packages/cli/src/serve.ts`). Every start gets a random 128-bit session token (`GHOST_SERVE_TOKEN`/`--token` fixes it,
  minimum 16 characters). Every POST route and `GET /api/viewing-bundle` require it in `x-ghost-token` (constant-time compare, 401 otherwise). `ghost serve` prints
  `open http://127.0.0.1:8788/?token=…`. The UI (`apps/web/src/api.ts`) moves the token from the URL into sessionStorage and sends it. A non-loopback `--host`
  without `GHOST_SERVE_TOKEN` refuses to start. Read-only public routes (`config`, `announcements`, `health`) stay open. Tests are in `packages/cli/test/serve.test.ts`;
  the e2e smoke test passes the token. Rebuild `apps/web/dist` (`make web-build`) to pick up the UI change; `make web`/`web-sim` do it.

### L1 (low, not fixed): fees and chain id come from the RPC unchecked

- Where: `packages/sdk/src/chains/evm.ts:88-94` (`getChainId()` and `getGasPrice()` from the RPC), `btc.ts:110-123,134` (`feeRate()` from mempool/esplora,
  uncapped), `packages/cli/src/commands/sweep.ts:403-404` (the user never sees the fee before the MPC request).
- Failure: a malicious or compromised RPC returns a huge gas price or fee rate. The sweep still sends `balance − fee` and the fee goes to miners, so most of the
  payment is lost. An EVM RPC that lies about `chainId` gets a transaction signed for another chain. The derived key, and so the address, is the same on every EVM chain,
  so the transaction is valid there. The funds still reach the user's destination on that chain, but not where the user expected.
- Fix: assert `chainId === chainInfo(tag).chainId`, cap the fee at a fraction of the value (for example 5%) unless `--max-fee` is given, and print the
  amount and fee before signing.
- **Status (round 2): fixed.** The EVM adapter refuses an RPC whose `chainId` differs from the chain tag's. Adapters return `value` and `fee`. `ghost sweep`
  prints "sending X, network fee Y" before any MPC request and refuses a fee above `GHOST_MAX_FEE_PCT` / `--max-fee-pct` (default 20%) of the amount moved.
  (Solana's fee is the fixed 5000 lamports.)

### L2 (low, not fixed): the deterministic-RNG mainnet guard does not exist

- Where: `packages/sdk/src/chains/tape.ts:14-16` says tape mode "refuses to run against mainnet (callers check `tapeStatus().deterministic`)". Nothing calls
  `tapeStatus()`. `installTape()` runs first in `ghost.ts:36` and in the relayer.
- Failure: if `GHOST_TAPE`/`GHOST_TAPE_MODE`/`GHOST_TAPE_SEED` leak into a real shell (copied from the demo, or an `.env`), every
  `crypto.getRandomValues` becomes a SHA-256 counter. `ghost init` seeds, ephemeral keys, NEAR keys and payer keys are then derivable from the seed.
- Fix: in `installTape`, throw when a seed is set and `GHOST_NETWORK=mainnet` or `MAINNET_APPROVED=1`. In `init`, `account create` and `pay`, refuse
  when `tapeStatus()?.deterministic` and the tape is not in replay mode.
- **Status (round 2): fixed.** `installTape()` throws when a seed is set together with `GHOST_NETWORK=mainnet` or `MAINNET_APPROVED=1`. The CLI context also
  refuses a mainnet network (for example `--network mainnet`) whenever `tapeStatus().deterministic`. There is a test in `packages/sdk/test/chains.test.ts`.

### L3 (low, not fixed): duplicate announcements double-count

- Where: `packages/sdk/src/scan.ts:81-92` (no dedupe), `contract/src/announce.rs:65` (anyone can re-post any `(chain, eph, tag, ct)`).
- Failure: Mallory copies Bob's real announcement. Bob's scan and the auditor's CSV show two rows for the same address and balance, so income is double-counted.
  The sweep of one row then marks the other "swept".
- Fix: dedupe hits by `(chain, eph)` and keep the lowest `idx`.
- **Status (round 2): fixed.** `scanAnnouncements` and `scanRegistry` keep the first hit per `(E, chain, address)` (`hitKey()` in `packages/sdk/src/scan.ts`).
  The web CSV (`paymentsCsv`) also writes one row per `(chain, address)`. Tests are in `announce-scan.test.ts` and `apps/web/test/lib.test.ts`.

### L4 (low, not fixed): the CLI default for Mode B sweeps is self-submission

- Where: `packages/cli/src/context.ts:227,433`. There is no default relayer URL. `README.md:235` says the default is `http://127.0.0.1:8787`, which only holds if
  `.env.example` was copied to `.env`.
- Failure: a user who skips the `.env` step runs `ghost sweep … --to X`. The sweep is submitted from their own NEAR account and links them to the path forever, with
  only a yellow warning line.
- Fix: in Mode B, refuse `via=self` unless it was explicitly requested (`--via self`), and fix the README table.
- **Status (round 2): fixed.** In Mode B, `ghost sweep` with no `GHOST_RELAYER_URL` refuses to self-submit unless `--allow-link` is given. The web UI's
  explicit "Self-submit" choice sends `allow-link`, and `make demo-live` (no mainnet relayer) passes it. README's config table is corrected. There is a test in `packages/cli/test/cli.test.ts`.

### L5 (low, not fixed): `get_meta` is trusted from RPC

- Where: `packages/sdk/src/registry.ts:243-246`, `packages/cli/src/commands/pay.ts:70`.
- Failure: a malicious RPC, or a hostile `NEAR_RPC_URL`, returns Mallory's meta-address for `bob.testnet`. The payer pays Mallory. Nothing on screen lets the
  payer notice.
- Fix: print a short fingerprint of `(spend_pub, view_pub)` in `ghost meta`/`pay` for out-of-band comparison, and accept a pinned fingerprint
  (`ghost:bob.testnet#ab12cd`) in the recipient handle.
- **Status: not fixed** (not in the round-2 scope).

### L6 (low, not fixed): secret files keep their old permissions

- Where: `packages/cli/src/commands/keys.ts:247` (`writeFileSync(out, bundle, { mode: 0o600 })`, default `./<name>.view.json` in the current directory).
- Failure: the `mode` option applies only when the file is created. Exporting over an existing 0644 file leaves the viewing key world-readable.
- Fix: `chmodSync(out, 0o600)` after writing, as `saveKeystore` and `writeSecret` already do.
- **Status (round 2): fixed.** `chmodSync(out, 0o600)` after writing. The other secret writers already chmod.

### Info

- **I1. ECDSA with additive tweaks.** A payer who paid Bob twice knows `h1` and `h2`. After Bob's sweep of payment 1 publishes a signature `(r, s)` on digest `z`,
  that signature is also valid under `K2` for `z' = z + r(h1 − h2)`. This is harmless only because the contract computes the digest itself from a structured
  preimage, so nobody can find a preimage for `z'`. Never add a method that verifies a caller-supplied raw digest. Consider stating this in SPEC §6.
- **I2. XChaCha20-Poly1305 is not key-committing.** In full (no-view-tag) mode an announcer can craft one ciphertext that decrypts under several recipients'
  memo keys (all of their `S` come from one `e`). The only effect is a spurious unfunded hit for each of them.
- **I3. Fingerprintable sweeps.** EVM sweeps are type-0, 21000-gas, balance-to-zero transfers. BTC sweeps spend every UTXO into one output, and a partial BTC sweep
  sends change back to the stealth address (address reuse). This lets an observer label Ghost Paths addresses; it does not identify the recipient.
- **I4. Memo length.** The ciphertext length reveals the amount string's length and whether a `txid` is present. The forced `"(no view tag)"` memo makes
  no-view-tag announcements recognisable by length.
- **I5. Changing mode.** The contract validates only the prefix of `spend_pub` and that `view_pub` is non-zero, and the SDK does the full checks, so a bad entry only harms its owner. If a recipient
  re-registers with a different `mode`, scans derive older payments under the new predecessor and show them as unfunded. Funds are not lost, but the CLI
  cannot sweep them without switching the mode back.
- **I6. Missing negative tests.** There are no contract unit tests for a domain swap (signed for domain 0, submitted as 1) or for cross-deployment replay. The digest binds both,
  so each test is a few lines and documents the property.
- **I7. 1Click wet mode** sweeps to the `depositAddress` returned by the 1Click API (`sweep.ts:391-394`), so the API is trusted with the destination. It is gated by
  `MAINNET_APPROVED` and `--wet`. Show the deposit address and require confirmation.
- **I8. Wording** (round 2: README.md:150 reworded and THREAT-MODEL.md:81 fixed; README.md:135's abbreviation left as is). README.md:150-151 ("a function-call key cannot attach a deposit, so a relayer or agent can only trigger a sweep through our contract") mixes
  Mode A and Mode B. The Mode B property is that only the contract is the predecessor, so only a valid `K` signature leads to an MPC signature.
  THREAT-MODEL.md:81 says `~/.ghost/<account>.json`; the file is `~/.ghost/<profile>.json`. README.md:135 abbreviates the digest (it omits `u8(n)` and the
  `u16be` length).
- **I9. MPC root keys** come from chainsig.js constants. `checkRootKeys()` exists, but the CLI does not call it before `pay`. A one-time check per session
  would catch a root rotation before funds go to an address the MPC no longer signs for.

## Claims in README.md and THREAT-MODEL.md compared with the code

Verdicts are for `1b091fb`. The last column shows the state after round 2.

| Claim | Verdict at `1b091fb` | After round 2 |
|---|---|---|
| "the relayer can censor or delay but cannot redirect funds (the destination is inside the signed digest)" | **True** for the EVM, Solana and BTC adapters as built. | unchanged |
| "A signed sweep can be replayed until `expires_block` … harmless" | **True** for funds. It cost the submitter gas, and the relayer resubmitted without limit (M3). | relayer answers repeats from cache |
| "Mitigation: use a fresh destination for every sweep (the web UI pre-fills one)" (THREAT-MODEL:61) | **False**: the pre-filled address was unspendable (H3). | reworded: a fresh destination *you control*; the throwaway button is demo-only |
| "NEAR validators / RPC providers: Same as the public, plus IPs" (THREAT-MODEL:25) | **Incomplete**: target-chain RPCs learn the set of a recipient's addresses (M1). | row split; target-chain RPC row added |
| "The seed in `~/.ghost/<account>.json`" (THREAT-MODEL:81) | Inaccurate: the file is `<profile>.json`. | fixed |
| README:150 "a function-call key cannot attach a deposit, so a relayer or agent can only trigger a sweep through our contract" | Muddled (mixes Mode A and Mode B). | reworded to the Mode B property |
| `GHOST_RELAYER_URL` default `http://127.0.0.1:8787` (README:235) | **Inaccurate**: the CLI had no default (L4). | table corrected, and self-sweep now needs `--allow-link` |
| "It has no owner and no upgrade method in v1" | True of the contract. **Not yet true of the account**: one full-access key, checked 2026-11-09 (H1). README says so. | unchanged until the owner deletes the key (Nov 14) |
| "Keys never reach the browser; `ghost serve` … refuses foreign Host and Origin headers" | True, but browser-only protection; no authentication (M4). | session token added; THREAT-MODEL updated |
| "tape mode … refuses to run against mainnet" (tape.ts comment) | **False**: not implemented (L2). | implemented |
| `make test-ts`: `72 pass` (README:61, DEMO.md:12) | True at `1b091fb`. | now `82 pass` after the added tests; both files updated |
| "Cannot learn … the recipient's NEAR account" (relayer), "nothing names the recipient" (Mode B sweep) | True. | unchanged |
| "No cryptographic primitive is hand-rolled" | True. | unchanged |
