# Ghost Paths — build plan (NEAR HACKATHON, Nov 9–14 2026)

Planner: Fable 5.1, 2026-11-09. Builders: Opus 5.5 (high effort) per track, Sonnet 5.5 for docs/tests/scaffolding. Shared rules live in `../CONTEXT.md`; read it first. Repo: github.com/AaroneGeorge/near-ghost-paths (private until the owner says otherwise; `main` has no commits yet). Licence MIT. Sibling project: Tripwire (github.com/AaroneGeorge/near-tripwire) — each README must name the other (HACKATHON.md Q-015).

Rules every builder brief must carry: never run `claude` as another user without `--strict-mcp-config`; never commit secrets (testnet keys go in git-ignored `.secrets/`, anything of value in `sudo lechu-secret set hackathon KEY`); never print secret values; search the Code Garage (`mcp__plugin_garage_garage__search`) before writing utility code (I searched 4 ways today — NEAR/chainsig/ECIES/near-sdk templates — nothing pinned applies; the nearest item is `web3.chains.other-l1-sdks`, Soroban/Fuel only, quarantine); no mainnet action without the owner's explicit approval.

---

## 0. Facts verified today (2026-11-09), not from memory

| # | Claim | How verified | Result |
|---|---|---|---|
| F1 | Contract ids | chainsig.js 1.1.16 bundle constants; RPC `version` view | testnet `v1.signer-prod.testnet` (v3.18.0), mainnet `v1.signer` (v3.17.0). Both `Running`. |
| F2 | Epsilon formula | chainsig.js source (`function at`) and near/mpc `crates/near-mpc-crypto-types/src/kdf.rs` (`TWEAK_DERIVATION_PREFIX`) | `epsilon = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor_id + "," + path)`. secp256k1: `K = Root + epsilon·G`. ed25519: `K = Root + (epsilon_LE mod L)·B`. |
| F3 | Keyed on predecessor | NEAR docs ("The NEAR account calling the MPC contract"); near/mpc `sign.rs` (`SignatureRequest::new(domain_id, payload, &predecessor, &path)`); my live test: a signature from account X recovers to `derive(X, path)` and **not** to `derive(Y, path)` | Yes. If a contract calls `sign`, the predecessor is the contract. |
| F4 | Local derivation == contract | bun script with `utils.cryptography.deriveChildPublicKey[Ed25519]` vs RPC view `derived_public_key({path, predecessor, domain_id})` | Byte-identical for secp256k1 (domain 0) and ed25519 (domain 1), testnet. Root keys: testnet `secp256k1:4NfTiv3U…`, `ed25519:6vSEtQxr…`; mainnet `secp256k1:3tFRbMqm…`, `ed25519:G9hwngxW…` (hardcoded in chainsig.js, matched `public_key` view). |
| F5 | Sign API | chainsig.js `sign()`; near/mpc deposits.rs | `sign({request:{payload_v2:{Ecdsa: hex32 \| Eddsa: hex}, path, domain_id: 0\|1}})`, **deposit 1 yoctoNEAR** (`SIGN_DEPOSIT_YOCTONEAR = 1`), chainsig.js attaches **300 Tgas**; contract minimum 15 Tgas (`sign_call_gas_attachment_requirement_tera_gas`). `experimental_signature_deposit` no longer exists. |
| F6 | Latency | live calls from a faucet account | ECDSA 15.5 s, EdDSA 14.8 s (testnet, one request each). Plan for 10–30 s. |
| F7 | Signature correctness | recovered pubkey from the ECDSA (r,s,v) == `derive(account, path)`; ed25519 verify against derived key | Both true. This is the "address equals what v1.signer signs for" proof; the test track turns it into a fixture + live test. |
| F8 | Function-call key for `sign` | added a FunctionCall key scoped to `v1.signer-prod.testnet::sign`, tried to sign | **Fails**: a function-call key cannot attach a deposit, and `sign` needs 1 yocto. A "sweeper agent with a function-call key" must go through our own contract (which attaches the yocto itself). |
| F9 | Domains | `state` view | 0 CaitSith/secp256k1 Sign, 1 Frost/ed25519 Sign, 2 ConfidentialKeyDerivation (TEE apps, WIP, not for us), 3 ForeignTx. Threshold 11 (testnet) / 10 (mainnet). |
| F10 | chainsig.js under bun | `bun add chainsig.js@1.1.16` + ESM import | Works. Exports: `contracts.ChainSignatureContract` (not `contracts.near.*` as the README shows), `chainAdapters.{evm,btc,solana,…}`, `utils.cryptography`. `sign()` takes a `@near-js/accounts` v2 `Account` as `signerAccount`. @noble v2 needs `.js` import paths (`@noble/curves/secp256k1.js`). `getDerivedPublicKey` is local (no RPC) for the two known contract ids. |
| F11 | BTC infra | curl | `mempool.space` is IPv6-only from this host (times out). `https://mempool.emzy.de/testnet4/api` (mempool-compatible, works with chainsig.js `Mempool` adapter) and `https://blockstream.info/testnet4/api` (esplora; different fee endpoint) work. chainsig.js `Bitcoin` adapter: networks `mainnet\|testnet\|regtest`, P2WPKH. |
| F12 | Solana devnet | RPC | `api.devnet.solana.com` healthy; **public RPC airdrop closed (410)** — only faucet.solana.com (human). Owner's `lechu-wallet` has 1.999 SOL devnet. |
| F13 | EVM testnets | RPC | `ethereum-sepolia-rpc.publicnode.com` works. Owner's `lechu-wallet`: 1.0 ETH Sepolia, 1.0 ETH Base Sepolia, 0 on all mainnets. Usable via `sudo -u claude lechu-wallet send sepolia <to> <eth>` (test networks send at once; mainnet needs the owner's fingerprint). |
| F14 | NEAR testnet accounts without near-cli | `POST https://helper.nearprotocol.com/account {newAccountId, newAccountPublicKey}` | Works, 10 NEAR, ~3 s. `make demo` creates every NEAR account this way. near-cli-rs 0.31.1 is also installed. |
| F15 | Toolchain | local | bun 1.4.3, node/npm present, rustc 1.99.1 + `wasm32-unknown-unknown`, cargo-near 0.23.0, near-sdk 5.30.1 (crates.io, 2026-11-05), docker 29.9; `ghcr.io/foundry-rs/foundry` (anvil), `anzaxyz/agave:stable`, `bitcoin/bitcoin` images exist. `near_sdk::env::ecrecover` exists. |
| F16 | 1Click | docs + `/v0/tokens` | `confidentiality: "public"\|"basic"\|"advanced"` on `POST /v0/quote` (Confidential Intents; what basic vs advanced hides is not documented — verify day 1 with a dry quote). Asset ids: `nep141:btc.omft.near`, `nep141:eth.omft.near`, `nep141:base.omft.near`, `nep141:sol.omft.near`, Base USDC `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`. Mainnet only; `dry: true` quotes are free and keyless. |

Spike artefacts (throwaway, do not reuse): `/tmp/claude-1000/-home-lechuuu/3ee29ba5-4f7c-4c7f-aa6d-ca97fcd0ddd3/scratchpad/spike/buncheck/{check.ts,shape.ts,sign.ts}`; the test track should re-create them inside the repo (W5) rather than copy the scratchpad.

---

## 1. Product, crypto spec, demo script

### 1.1 Product (one paragraph)

Ghost Paths lets anyone pay a NEAR account privately on Bitcoin, Ethereum/Base or Solana at a fresh one-time address the recipient never generated and nobody can link to them. It is ERC-5564 stealth addresses rebuilt on NEAR Chain Signatures: the recipient publishes one meta-address (a spend public key and an X25519 viewing key) in a small NEAR registry; the payer derives a one-time address on the target chain from that meta-address plus a fresh ephemeral key, pays it, and posts a short announcement to NEAR; the recipient — or an auditor holding only the viewing key — scans announcements to find the payments; only the recipient can sweep, by authorising the Ghost Paths contract to request an MPC signature from `v1.signer`. The recipient never holds a Bitcoin, Ethereum or Solana key: the MPC network signs for every chain from the same two keys, and because the signing request comes from the shared contract and is authorised by a per-payment stealth key, the sweep does not reveal who was paid. The variant that sells it to a normal company is private payroll: an employer pays N contractors in ETH/USDC at stealth addresses and the accountant gets a viewing key.

### 1.2 Why this needs NEAR (for the README, keep it honest)

- Chain Signatures' derivation is *public*: `derive(predecessor, path)` is computable by anyone, while only `predecessor` can obtain a signature. That turns the MPC into a stealth-address signer for every supported chain, including ed25519 chains (Solana) that ERC-5564 cannot serve from a secp256k1 spend key.
- The authorising logic is a NEAR contract: viewing-key delegation, per-payment authorisation, and (later) policies such as payroll vesting or agent allowances are enforced on-chain instead of in a wallet.
- The recipient never touches chain-specific keys or tooling. One NEAR account id is the whole "payment handle".

### 1.3 Two modes; Mode B is the product

**Mode A — account-as-spender (fallback, kept in the SDK as `mode: "account"`).** Predecessor = the recipient's NEAR account. Sweeping means `bob.near` calls `v1.signer::sign(path)` directly. Problem, found today: that transaction is public and carries `path` and the payload; anyone who indexes `sign` calls recomputes the stealth address (or recovers the public key from the ECDSA signature) and links it to `bob.near`. Privacy lasts only until the sweep. Ship it only if Mode B's contract slips; label the limitation loudly.

**Mode B — shared signer contract + stealth spend key (primary).** Predecessor = the Ghost Paths contract (`ghost.testnet` / `ghost.near`) for every user. The path is a hash of a per-payment stealth public key `K = P_spend + h·G` (ERC-5564 construction). Sweeping = anyone (a relayer) submits `sweep(...)` with an ECDSA signature by `K`; the contract verifies it with `env::ecrecover` and forwards `sign` to `v1.signer`, attaching the 1 yocto itself. What becomes public at sweep time is `(ghost.near, K)` and the destination — not the recipient. Linking `K` to `P_spend` requires the ECDH shared secret (same DDH assumption as ERC-5564). F8 also makes this the only way to let an agent/relayer trigger sweeps without a full-access key.

### 1.4 Keys

| Key | Curve | Holder | Derivation |
|---|---|---|---|
| `seed` | 32 random bytes | recipient only | `crypto.getRandomValues`; stored 0600 in `~/.ghost/<account>.json` (demo: `.secrets/ghost/`) |
| spend `d_spend`, `P_spend` | secp256k1 | recipient only | `d_spend = int(HKDF-SHA256(ikm=seed, salt="ghost-paths/v1", info="spend", 32)) mod n`, reject 0; `P_spend = d_spend·G` (33-byte compressed in the registry) |
| view `k_view`, `P_view` | X25519 | recipient + auditors | `k_view = HKDF(seed, salt, "view", 32)` (x25519 clamps); `P_view = x25519.getPublicKey(k_view)` (32 bytes) |
| NEAR account key | ed25519 | recipient | ordinary NEAR key; used only to `register` and (Mode A) to sign. Not a spend authority in Mode B. |
| MPC root keys | secp256k1 / ed25519 | MPC network | F4; hardcoded in chainsig.js, cross-checked with `public_key` view at startup |

Meta-address = registry entry keyed by NEAR account id: `{v:1, mode:"contract"|"account", spend_pub: hex33, view_pub: hex32}`. Human form `ghost:bob.testnet`. Viewing-key bundle (export for auditors): `{v:1, account, view_priv: hex32, spend_pub: hex33, signer: "ghost.testnet"}` — lets one scan, never sweep.

### 1.5 Pay (sender; needs only the registry entry)

```
e      = random 32 bytes;  E = x25519.getPublicKey(e)
S      = x25519.getSharedSecret(e, P_view);  reject all-zero
tag    = sha256("ghost-paths/v1/view-tag" || S)[0]                       # 1 byte
h      = int(HKDF(ikm=S, salt="ghost-paths/v1", info="tweak"||E||P_spend||chain_tag, 32)) mod n; reject 0
K      = P_spend + h·G;  reject infinity;  K_unc = x||y (64 bytes)
path   = "gp1/" + hex(sha256(K_unc))                                      # 68 chars; contract re-checks sha256
A      = deriveAddress(predecessor = SIGNER_CONTRACT_ID, path, chain)     # chainsig.js adapters; domain 0 (BTC/EVM) or 1 (SOL)
pay A on the target chain (any wallet; the demo uses anvil / lechu-wallet / BTC faucet)
memo_ct= XChaCha20-Poly1305(key=HKDF(S,salt,"memo",32), nonce=rand24, aad=E||chain_tag, pt=JSON{amount,asset,note,txid})   # optional
announce(chain_tag, E, tag, memo_ct) on the registry contract              # no recipient field, ever
```

`chain_tag` strings: `evm:31337` (anvil), `evm:11155111` (Sepolia), `evm:84532` (Base Sepolia), `evm:8453` (Base), `btc:regtest|testnet4|mainnet`, `sol:local|devnet|mainnet`. Including `chain_tag` in `h` makes the same announcement unusable across chains (so one announcement = one address on one chain).

### 1.6 Scan (recipient or auditor; needs `k_view`, `P_spend`)

```
for a in announcements[since..]:                 # view-paginated, no indexer
  S' = x25519(k_view, a.E);  if sha256(tag-prefix||S')[0] != a.tag: skip   # ~255/256 skipped
  h, K, path, A as above (with a.chain)
  balance = chainAdapter(a.chain).getBalance(A);  memo = decrypt(memo_ct)
  emit {idx: a.idx, chain, address: A, balance, memo, swept: balance == 0 && seen-before}
```

### 1.7 Sweep (recipient only; needs `d_spend`)

```
d_K      = (d_spend + h) mod n                                        # per-payment stealth private key, never stored
tx       = chainAdapter.prepareTransactionForSigning({from: A, to: dest, amount: balance - fee})
payloads = tx.hashesToSign                                            # ECDSA: 32-byte hash(es); Eddsa: Solana message bytes
msg      = sha256("ghost-paths/v1/sweep" || contract_id || path || u8(domain_id) || u64be(expires_block) || u8(len) || Σ(u16be(len_i)||payload_i))
sig      = secp256k1.sign(msg, d_K)  -> r||s (64 bytes, low-s) + v (0|1)
call ghost.sweep({path, domain_id, payloads: [hex], expires_block, k_pub: hex64(K_unc), sig: hex64, v})  with 1 yocto × len(payloads), 300 Tgas
   contract: block_height <= expires_block; sha256(k_pub) == path[4..]; env::ecrecover(msg, sig, v, true) == k_pub
             -> Promise v1.signer.sign({request:{payload_v2:{Ecdsa|Eddsa: payload}, path, domain_id}}, 1 yocto, 250 Tgas) ; returns the MPC signature
finalize + broadcast with the chain adapter; print tx hash
```

v1 limit: one payload per `sweep` call (BTC with several UTXOs = several calls; the CLI loops). Who submits the NEAR transaction: the relayer (own NEAR account; cannot steal — destination is signed into `msg`; can only censor), else the user's own account with a printed warning ("this links the sweep to your account on NEAR").

Mode A sweep (fallback): same `path`; `bob` calls `v1.signer::sign` directly with chainsig.js `contract.sign(...)`.

### 1.8 Registry / announcement contract (Rust, near-sdk 5.30, one contract, two concerns)

- `new(signer_id: AccountId)` — fixed at init; no owner, no upgrade method in v1 (document; testnet redeploys use a new sub-account).
- `register(spend_pub: String, view_pub: String, mode: String)` payable (storage); key = predecessor; overwrite allowed. `get_meta(account_id) -> Option<Meta>`.
- `announce(chain: String, eph: String, tag: u8, ct: Option<String>) -> u64` payable (storage, ≈ 0.003 NEAR, refund excess); appends to `Vector<Announcement{idx, chain, eph, tag, ct, block_height, timestamp_ms, announcer}>`; emits NEP-297 event `{"standard":"ghost-paths","version":"1.0.0","event":"announce","data":[{idx,chain,eph,tag}]}`. Note `announcer` is public anyway (it is the predecessor); storing it is honest.
- `announcement_count() -> u64`, `get_announcements(from: u64, limit: u32) -> Vec<Announcement>` (limit ≤ 200).
- `sweep(path, domain_id: u8, payloads: Vec<String>, expires_block: u64, k_pub: String, sig: String, v: u8) -> Promise` as in 1.7; `signer_id() -> AccountId`.
- Size budget < 300 lines; no `k256` dependency (ecrecover + sha256 are host functions).

### 1.9 Threat model — what is and isn't private

Adversaries: public observers of NEAR + target chains; the payer; an auditor with a viewing key; the relayer; the MPC operators; NEAR validators.

Private (from the public), Mode B:
- The link between a stealth address `A` and the recipient's identity (`bob.near`, `P_spend`), before and after the sweep. Linking needs `S` (ECDH with `k_view`) — DDH on X25519 — or `d_spend`.
- Which registered recipient a given announcement targets (modulo the view tag, see below).
- The recipient's total income across stealth payments.

Public / leaked (say it in the README):
- The *fact* that `bob.near` uses Ghost Paths (registry entry) and when it registered.
- The announcer's NEAR account and the time of each announcement; the payer's address on the target chain and the amount paid to `A`. Timing correlation between an announcement and a payment on the target chain is trivial — same as ERC-5564.
- The view tag leaks 1 byte of `S`: with a small registry (our demo has 3 users) it identifies the recipient among registered users. Mitigation: `--no-view-tag` (tag = random), default *on* for scan speed like ERC-5564; state the anonymity-set caveat.
- At sweep: `(ghost.near, path, K, payload, destination chain tx)` are public on NEAR. Not linkable to `bob` without `S`, but **consolidation links**: sweeping several `A_i` to the same destination links them together (common-input-ownership on BTC, same-recipient on EVM/SOL) and, if the destination is a known address of Bob's, to Bob. Mitigations: sweep each payment to a fresh destination; sweep into another Ghost Paths stealth address of your own (hides nothing from a graph analyst, adds a hop); on mainnet, `--via 1click --confidential basic`: the sweep pays a 1Click deposit address and the recipient receives on any chain/address through NEAR Intents' Confidential Intents, which "cannot be tracked" between deposit and withdrawal (docs); trust moves to the Intents solvers/1Click.
- Amounts are public on the target chain. Ghost Paths hides *who*, not *how much*.
- The relayer learns sweep requests (`K`, destination) but not `bob` (unless the destination is identifiable). It can censor; the user can always submit themselves (linkable).
- MPC operators learn exactly what the public learns (predecessor = our contract). Threshold trust (10/11 of N) is inherited from Chain Signatures: a colluding supermajority could sign for any derived address.
- The payer knows everything about their own payment (inherent) and could publish `(E, bob)`.
- Mode A: everything above plus the sweep publicly links `bob.near` to `A`.
- Denial: a payer can announce without paying (scanner shows unfunded, filtered) or pay without announcing (recipient never finds it; recoverable if the payer later shares `E`).
- Our contract has no upgrade path in v1 (good for trust, bad for bugs); registry spam costs storage.

### 1.10 Exact 2-minute demo script ("do X, see Y")

Everything below is what `make demo` prints; the video records the terminal and the web UI. Times are cumulative.

1. 0:00 `make demo` — see: three NEAR testnet accounts created via faucet (payer `alice-…testnet`, recipient `bob-…testnet`, relayer), the Ghost Paths contract id (`v1.ghost-paths.testnet`, pre-deployed; `DEPLOY=1` deploys a fresh one), anvil and a local Solana validator up (docker), the MPC root key check ("v1.signer-prod.testnet public_key matches chainsig.js").
2. 0:15 `ghost init --as bob` then `ghost register` — see: Bob's meta-address (spend pub, view pub) and the NEAR tx link. "Bob holds two keys and no ETH/SOL/BTC key."
3. 0:30 `ghost pay bob 0.01 ETH --chain evm:31337 --as alice` — see: the one-time address `0x…` (derived from `v1.ghost-paths.testnet` + path `gp1/…`), the anvil payment tx, the NEAR announcement tx (`idx 17: chain evm:31337, eph 0x…, tag 0x7c` — "no recipient field").
4. 0:45 `ghost pay bob 0.1 SOL --chain sol:local --as alice` — see the same for an ed25519 chain (address is a base58 Solana pubkey derived with domain 1).
5. 1:00 `ghost scan --as carol` — see: "0 payments" (Carol has a different viewing key). `ghost scan --as bob` — see: 2 payments (address, chain, balance, decrypted memo "invoice #42"). `ghost scan --viewing-key bob.view.json` (auditor) — see the same 2 payments and "no spend key: cannot sweep".
6. 1:15 `ghost sweep 17 --to 0xDEST --as bob` — see: "relayer submits ghost.sweep(path gp1/…, k_pub …)", "MPC signature in 15.3 s", anvil tx hash, destination balance +0.0099 ETH. Then the NEAR explorer link: "v1.ghost-paths.testnet requested a signature for path gp1/… — nothing names bob".
7. 1:40 Web UI at http://localhost:5173 — Send / Scan / Sweep / Auditor tabs showing the same state (one click each).
8. 1:50 (video only, from `make demo-live` recorded separately) Base mainnet: `ghost pay bob 0.002 ETH --chain evm:8453`, then `ghost sweep … --via 1click --confidential basic` — see the 1Click quote and the recipient receiving USDC on another chain, no on-chain path from the stealth address to the recipient.

Acceptance for `make demo`: exit 0, under 4 minutes on a fresh machine with docker + bun, no owner secrets, no prompts.

---

## 2. Architecture

```
          payer (CLI / web)                        recipient / auditor (CLI / web)
   registry.get_meta(bob) ─┐                      ┌─ registry.get_announcements(cursor)
   derive A (chainsig.js)  │   NEAR testnet       │  x25519 scan, derive A, balances
   pay A (chain adapter)   ├──► v1.ghost-paths ◄──┤
   announce(E, tag, ct) ───┘    (registry +       └─ sweep: sign msg with d_K ──► relayer ──► ghost.sweep(...)
                                 announcements +                                           │ ecrecover == K
                                 sweep gateway)                                            ▼
                                      │                                      v1.signer-prod.testnet (MPC) ──► signature
                                      ▼                                                    │
                     local chains for `make demo`: anvil (evm:31337), solana-test-validator (sol:local)
                     public testnets for `make demo-testnet`: Sepolia / Base Sepolia, Solana devnet, BTC testnet4
                     mainnet for `make demo-live`: ghost.near on NEAR mainnet, Base (evm:8453), 1Click confidential sweep, optional BTC mainnet
```

Components:
- **contract/** — one Rust contract (1.8). Compiled wasm committed in `contract/res/ghost_paths.wasm` with the reproducible-build command in the README, so `make demo` never needs cargo.
- **packages/sdk** (TS, bun, also runs in node ≥ 20) — keys, stealth math, derivation (wraps chainsig.js), announcement codec, scan, sweep message, registry client, chain adapters (evm via viem, btc via chainsig.js `Mempool` adapter pointed at emzy/blockstream, solana via @solana/web3.js), 1Click client (dry quotes offline-safe), NEAR helpers (faucet account creation, `Account` construction, relayer client).
- **packages/cli** — `ghost` binary (`bun run`): `init, register, meta, pay, scan, export-viewing-key, sweep, derive, serve, demo`. JSON output with `--json`; human output otherwise. `ghost serve` exposes the same operations over HTTP for the web UI so the keystore never enters the browser.
- **packages/relayer** — tiny bun HTTP server with its own NEAR account: `POST /announce`, `POST /sweep`, `GET /health`. Forwards calls to the contract, attaches deposits, returns tx hash + result. Started by `make demo`.
- **apps/web** — Vite + React + TS, four tabs, talks to `ghost serve` (`VITE_GHOST_API`). No wallet connection needed for the demo (keys live server-side); a "connect NEAR wallet" button is out of scope.
- **demo/** — `demo.ts` orchestrator (what `make demo` runs), `docker-compose.yml` (anvil, agave test validator), `fixtures/` (recorded announcements, derived keys, real MPC signatures from testnet for `make demo-replay` and tests), `fund.ts` (testnet funders: `sudo -u claude lechu-wallet` on this host, or `FUNDER_*` env keys elsewhere).

Flags and modes (every live dependency behind one):

| Env / flag | Default | Effect |
|---|---|---|
| `GHOST_NETWORK` | `testnet` | NEAR network; `mainnet` only in `make demo-live` |
| `GHOST_CONTRACT` | `v1.ghost-paths.testnet` | registry/signer contract; `DEPLOY=1` deploys a fresh sub-account from the committed wasm |
| `GHOST_SIGNER` | from network | `v1.signer-prod.testnet` / `v1.signer` |
| `GHOST_CHAINS` | `evm:31337,sol:local` | chains `make demo` exercises; `btc:regtest` only if W3 lands it |
| `GHOST_RELAYER_URL` | `http://127.0.0.1:8787` | unset → submit sweeps/announcements from the user's own account (warning) |
| `GHOST_MODE` | `contract` | `account` = Mode A fallback |
| `GHOST_REPLAY=1` | off | no network at all: fixtures replace NEAR/MPC/chains (`make demo-replay`, CI) |
| `LIVE=1` | off | tests also hit the testnet MPC (one ECDSA + one EdDSA sign, ~30 s) |
| `ONECLICK_API_KEY` | unset | optional; dry quotes work without it |
| `FUNDER_EVM_PK`, `FUNDER_SOL_KEY`, `BTC_FUNDER` | unset | public-testnet funding for `make demo-testnet`; on this host `demo/fund.ts` uses `sudo -u claude lechu-wallet send …` instead |
| `MAINNET_APPROVED=1` | off | hard gate for anything that spends mainnet funds |

Make targets: `make demo` (NEAR testnet + local chains), `make demo-replay` (offline), `make demo-testnet` (public testnets, needs funders), `make demo-live` (mainnet, gated), `make test` (unit + contract + fixture tests), `make test-live` (adds `LIVE=1`), `make build-contract` (cargo-near reproducible), `make deploy-testnet`, `make web`, `make clean`.

---

## 3. Repo layout and interface contracts (so 5 builders don't collide)

```
near-ghost-paths/
  Makefile                      W0 (Sonnet) owns; tracks add targets via PRs touching only their lines
  README.md  LICENSE  .gitignore  .env.example   W0 then W5
  package.json  bun.lock  tsconfig.base.json     W0 (bun workspaces: packages/*, apps/*, demo)
  docs/SPEC.md                  W1 keeps it equal to section 1 of this plan (test vectors appended)
  docs/THREAT-MODEL.md          W5 from 1.9, reviewed by W1
  docs/DEMO.md  docs/VIDEO-SCRIPT.md  docs/AI-DISCLOSURE.md   W5
  contract/                     W2
    Cargo.toml  rust-toolchain.toml  src/lib.rs  src/{registry,announce,sweep,events}.rs
    tests/integration.rs (near-workspaces-rs, includes a mock signer contract in tests/mock_signer/)
    res/ghost_paths.wasm  ABI.md (method table = 1.8; any change needs W1+W3 ack in the PR)
  packages/sdk/                 W1 (core) + W3 (chains/, near/relayer client)
    src/index.ts  types.ts  constants.ts
    src/keys.ts        seed → {d_spend,P_spend,k_view,P_view}; keystore read/write; viewing-key bundle export
    src/stealth.ts     ecdh, viewTag, tweak(h), K, path, d_K; sweepMessage(); pure functions, no I/O
    src/derive.ts      deriveAddress(predecessor, path, chainTag) over chainsig.js; root-key sanity check
    src/announce.ts    encode/decode announcement, memo encrypt/decrypt
    src/scan.ts        scan(announcements, viewingBundle, chains) → Payment[]
    src/registry.ts    view/call wrappers for the contract (get_meta, announce, get_announcements, sweep)
    src/near.ts        createFaucetAccount(), makeAccount(), rpc provider with failover
    src/chains/{evm,btc,solana}.ts   ChainAdapter interface impls (W3)
    src/oneclick.ts    quote(dry) / submit (W3, mainnet-gated)
    test/*.test.ts     bun test (W1 for stealth/announce/scan; W5 for fixtures + live)
  packages/cli/src/ghost.ts  commands/*.ts  W3 (uses only the sdk public API)
  packages/relayer/src/server.ts          W3
  apps/web/                               W4
  demo/demo.ts  docker-compose.yml  fund.ts  fixtures/*.json  W3 (+W5 fixtures)
  .secrets/   (git-ignored) demo keystores, faucet account keys
```

Interface contracts (frozen on Nov 10 09:00 UTC by W1; later changes by PR with the affected track's ack):

```ts
// packages/sdk/src/types.ts
export type ChainTag = `evm:${number}` | `btc:${'regtest'|'testnet4'|'mainnet'}` | `sol:${'local'|'devnet'|'mainnet'}`;
export interface Meta { v: 1; mode: 'contract'|'account'; spend_pub: Hex33; view_pub: Hex32 }
export interface ViewingBundle { v: 1; account: string; view_priv: Hex32; spend_pub: Hex33; signer: string }
export interface Keystore extends ViewingBundle { seed: Hex32 }                   // never leaves the machine
export interface Announcement { idx: number; chain: ChainTag; eph: Hex32; tag: number; ct?: string; block_height: number; timestamp_ms: number; announcer: string }
export interface StealthTarget { chain: ChainTag; eph: Hex32; tag: number; h: bigint; K: Uint8Array /*65 uncompressed*/; path: string; address: string; domainId: 0|1 }
export interface Payment extends StealthTarget { idx: number; balance: bigint; decimals: number; memo?: Memo; swept: boolean }
export interface ChainAdapter {
  tag: ChainTag; domainId: 0|1;
  deriveAddress(predecessor: string, path: string): Promise<{ address: string; publicKey: string }>;
  getBalance(address: string): Promise<{ balance: bigint; decimals: number }>;
  prepareSweep(from: string, publicKey: string, to: string, amount?: bigint): Promise<{ tx: unknown; payloads: Uint8Array[] }>;
  finalize(tx: unknown, sigs: MpcSignature[]): Promise<string /*serialized*/>;
  broadcast(serialized: string): Promise<string /*tx hash*/>;
  fund?(address: string, amount: bigint): Promise<string>;            // demo only (anvil / local validator / lechu-wallet)
}
export type MpcSignature = { r: Hex32; s: Hex32; v: number } | { scheme: 'Ed25519'; signature: number[] };
```

Stealth API (W1): `deriveRecipientKeys(seed)`, `makeTarget(meta, chain, eph?) → {target, S}`, `viewTag(S)`, `tweak(S, E, P_spend, chain)`, `stealthPath(K)`, `stealthPriv(d_spend, h)`, `sweepMessage({contractId, path, domainId, payloads, expiresBlock})`, `signSweep(msg, d_K) → {sig, v}`, `scanOne(a, bundle) → StealthTarget | null`. Registry API: `getMeta`, `register`, `announce`, `getAnnouncements(from, limit)`, `sweep(args, via: 'relayer'|'self')`. Relayer HTTP: `POST /announce {chain, eph, tag, ct}` → `{tx_hash, idx}`; `POST /sweep {path, domain_id, payloads, expires_block, k_pub, sig, v}` → `{tx_hash, signature: MpcSignature}`; `GET /health` → `{account, balance}`. CLI `--json` output: one JSON object per command, documented in `docs/DEMO.md`; the web UI consumes `ghost serve` which mirrors the CLI commands as `POST /api/<command>`.

Fixtures format (`demo/fixtures/*.json`): `{ network, signer, root_keys, cases: [{ predecessor, path, domain_id, derived_pub, address, payload, signature, recovered_ok }] }` — recorded from real testnet calls by W5 on Nov 10 (one ECDSA, one EdDSA per predecessor type: EOA and contract).

---

## 4. Build tracks

Each track = one Opus 5.5 (or Sonnet 5.5) agent working in its owned files; cross-track changes via small PRs. Branch per track (`w1-sdk`, …), merge to `main` at least daily; `make test` must pass before merge. Builders use the throwaway faucet accounts; never the owner's keys.

| Track | Model | Owns | Deliverable | Acceptance |
|---|---|---|---|---|
| **W0 scaffold** (Nov 9 evening) | Sonnet | repo root, Makefile, workspaces, CI (`bun test` + `cargo test` on push, no network), LICENSE, .gitignore, .env.example, `docs/` stubs | buildable empty workspace; `make test` green with placeholder tests | `bun install && make test` passes; CI run green |
| **W1 crypto SDK** | Opus | `packages/sdk/src/{keys,stealth,derive,announce,scan,registry,near,types,constants}.ts`, `docs/SPEC.md`, sdk unit tests | 1.4–1.7 implemented as pure functions + registry client; test vectors in SPEC.md | `bun test`: tweak math (`K == (d_spend+h)·G`), path format, view-tag filter rate, announcement roundtrip, scan finds/doesn't; **derivation test**: `deriveAddress(contract, path)` equals RPC `derived_public_key` for domains 0 and 1 (free view call, allowed in CI); root-key check vs `public_key` |
| **W2 contract** | Opus | `contract/**` | contract per 1.8; mock signer for tests; deployed to `v1.ghost-paths.testnet`; wasm committed | `cargo test` (near-workspaces): register/announce/pagination/storage refunds; sweep rejects bad sig, expired, wrong `k_pub`; good sig → promise to mock signer returns its value; gas report ≤ 300 Tgas end-to-end; **live**: `sweep` against the real testnet signer returns a signature that recovers to `derive(contract, path)` (recorded as a fixture) |
| **W3 chains + CLI + relayer + demo** | Opus | `packages/sdk/src/chains/**`, `oneclick.ts`, `packages/cli/**`, `packages/relayer/**`, `demo/**` | adapters (evm via viem; btc via chainsig.js Mempool adapter with emzy/blockstream; solana), CLI, relayer, `make demo` orchestration, docker-compose, funders, 1Click dry quote + gated submit | `make demo` exit 0 on this host in < 4 min; `make demo-replay` exit 0 with network disabled (`unshare -n` or `GHOST_REPLAY=1`); `make demo-testnet` completes Sepolia + Solana devnet with lechu-wallet funding; each CLI command has `--json` |
| **W4 web UI** | Sonnet (Opus if time allows polish) | `apps/web/**`, `ghost serve` route handlers in `packages/cli/src/serve.ts` (coordinate with W3) | 4 tabs: Send (pick recipient account, chain, amount → shows address, tx, announcement), Scan (as recipient / as auditor via uploaded viewing bundle / as stranger), Sweep (pick payment, destination, via relayer/self/1Click), Auditor (read-only table + CSV export) | Playwright smoke test over `make demo` state: send → scan shows 1 → sweep → balance moves; builds with `bun run build`; no secrets in the bundle |
| **W5 tests, fixtures, docs, video** | Sonnet | `demo/fixtures/**`, `packages/sdk/test/fixtures.test.ts`, `test-live`, `README.md`, `docs/{THREAT-MODEL,DEMO,VIDEO-SCRIPT,AI-DISCLOSURE}.md`, X-post draft | fixture recording script; README per section 7; 2-minute video script with timestamps and exact commands; AI-generated-code and libraries disclosure | README "do X, see Y" steps reproduce on a fresh clone (a second Sonnet agent follows them blind on Nov 13); `make test` runs fixture tests offline; `make test-live` performs one ECDSA + one EdDSA sign and checks recovery |
| **W6 review** (Nov 13) | Opus, fresh context | read-only + PRs | security/privacy review of SPEC vs code (KDF domain separation, low-s, replay, expires, ecrecover malleability flag, nonce handling, storage griefing), README claims vs behaviour | written findings; blockers fixed same day |

Dependencies: W3 and W4 code against `types.ts` from the moment W1 freezes it (Nov 10 09:00 UTC) using an in-memory fake registry (`registry.ts` exports `MemoryRegistry` for tests) until W2's testnet deploy lands (Nov 10 evening). W2 needs only `sweepMessage()` byte layout from W1 (fix it in SPEC.md first thing).

---

## 5. Schedule (UTC) and cut lines

| Day | Goal | Who | Cut line / decision |
|---|---|---|---|
| **Nov 9 (Sun)** | Plan approved by owner; W0 scaffold; day-1 spikes S1–S4 (section 6) started by W2/W3 | Sonnet W0; Opus W2, W3 | — |
| **Nov 10 (Mon)** | 09:00 `types.ts` + `sweepMessage` frozen. W1: stealth + derive + announce + scan with tests. W2: registry + announce deployed to `v1.ghost-paths.testnet` by evening; sweep compiled and tested against the mock signer. W3: anvil + Solana local validator via docker, evm/solana adapters, `ghost pay/scan` end-to-end in **Mode A** on anvil (direct `sign`), relayer skeleton. W5: fixtures recorded (EOA + contract predecessor once W2 is up). | all | If the Solana docker validator is not working by 18:00 → `make demo` is EVM-only, Solana moves to `demo-testnet` (devnet, lechu-wallet funded). |
| **Nov 11 (Tue)** | Mode B end-to-end: W2 live `sweep` on testnet; W3 CLI `sweep --via relayer`; Solana sweep (Eddsa); `make demo` first full green run; W4 UI against `ghost serve`; W5 README draft + THREAT-MODEL. | all | If live contract→signer `sweep` is not green by 20:00 → ship Mode A as default for the demo, keep Mode B contract code + tests, README says "Mode B on testnet: partial". |
| **Nov 12 (Wed)** | `demo-testnet` (Sepolia/Base Sepolia + Solana devnet); BTC testnet4 (derive + pay from faucet + sweep) if sats arrived by noon; `demo-replay`; hardening (retries, timeouts, idempotent re-runs); UI polish; **code-complete 22:00**. | all | 12:00: no BTC sats → BTC is derive-only in the demo (address shown, no payment), kept in README as supported-by-code. 18:00: UI Auditor tab not done → auditor is CLI-only. |
| **Nov 13 (Thu)** | W6 review AM; fixes; mainnet: deploy `ghost.near` (or sub-account), `demo-live` on Base with ~$10 + 1Click confidential sweep (dry quote always; wet only with `MAINNET_APPROVED=1` and owner's approval); record video (terminal + UI, 2 min); README final; blind README reproduction by a fresh Sonnet agent. | W6, W3, W5 | No mainnet funds by 15:00 → video uses testnet only (eligible per Q-010); README says so. |
| **Nov 14 (Fri)** | Buffer. Owner: repo public, X post with video, confirm submission payload; submit via API before 23:59 UTC (one attempt). | owner + planner | Nothing new merges after 12:00 except README/typo fixes. |

---

## 6. Risks, day-1 spikes, fallbacks

Day-1 spikes (Nov 9 evening / Nov 10 morning; each ≤ 1 hour, results posted in `docs/SPIKES.md`):

| # | Spike | Why | Fallback |
|---|---|---|---|
| S1 | `derived_public_key` view with a 68-char path `gp1/<sha256 hex>` and with a 134-char path; confirm no length limit for our format (free view call) | path format in 1.5 | path = `gp1/<sha256>` already short; if even that fails, `gp1/<base58(sha256)>` |
| S2 | Minimal contract calling `v1.signer-prod.testnet::sign` from a promise with 1 yocto and 250 Tgas; capture the promise result shape and total gas; also confirm `Eddsa` payload accepts a full Solana message (not just 32 bytes) | W2 core; Solana sweep | gas: attach less to our own code; Eddsa size: pre-hash is not possible for ed25519 — if rejected, Solana is derive-only |
| S3 | anvil (docker foundry) + viem adapter + testnet MPC signature broadcast on chainId 31337 | `make demo` EVM | Sepolia with lechu-wallet funding for the video; replay fixtures for judges |
| S4 | `anzaxyz/agave:stable` `solana-test-validator` in docker: start time, airdrop, @solana/web3.js transfer signed by the MPC | `make demo` Solana | Solana devnet with lechu-wallet funds (`demo-testnet` only) |
| S5 | ecrecover compatibility: noble `secp256k1.sign(msg, d)` (low-s, recovery bit) → `env::ecrecover(msg, sig64, v, true)` returns the 64-byte key equal to `K_unc` | sweep auth | try `malleability_flag=false`; or compare both `v` candidates server-side |
| S6 | 1Click dry quote `confidentiality: "basic"`, Base ETH → USDC on Solana, no API key | mainnet sweep mitigation | `confidentiality: public` (then say the mitigation is unavailable) |
| S7 | BTC testnet4: derive P2WPKH, fetch UTXOs/fees through `mempool.emzy.de/testnet4/api`, build PSBT with chainsig.js; get sats from coinfaucet.eu (human: owner or planner solves the captcha) | BTC in the video | BTC derive-only |
| S8 | Contract size/gas with near-sdk 5.30 + `Vector` of announcements; storage cost per announcement | storage pricing in `announce` | cap `ct` to 512 bytes |

Risks:

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Testnet MPC slow/down during demo or judging | medium | high | 30 s timeout + 2 retries; `make demo-replay` always works; README tells judges to use replay if testnet is down |
| Contract→`sign` gas/promise shape surprises | medium | high (Mode B) | S2 on day 1; Mode A fallback already in the SDK |
| Docker missing on a judge's machine | medium | medium | `make demo` detects docker; without it runs `demo-replay` automatically and says so |
| Solana validator image heavy/slow | medium | low | EVM-only `make demo`, Solana in `demo-testnet` |
| BTC faucet/human loop | high | low | derive-only BTC; sats optional |
| Mainnet funds/approval late | medium | medium | testnet-only submission is eligible; `demo-live` is a bonus in the video |
| Privacy claims over-stated | medium | high (judges) | THREAT-MODEL.md is reviewed by W6; README privacy-limits section mandatory; demo literally shows what a stranger sees |
| Reusing ERC-5564 wording without attribution | low | medium | cite EIP-5564 in README and SPEC; state what differs |
| chainsig.js API drift (README shows `contracts.near.*`, code exports `contracts.ChainSignatureContract`) | known | low | pin `chainsig.js@1.1.16`, `@near-js/*@2.5.x`, `@noble/curves@2.x`; adapters wrap it |
| Two-projects rule / README cross-naming forgotten | low | high | README skeleton includes it; W5 checklist |

---

## 7. README skeleton (W5 writes it; keep this order)

```
# Ghost Paths — stealth addresses on Bitcoin, Ethereum and Solana from one NEAR account
Built at NEAR HACKATHON (Nov 2026). Tracks: privacy, realworld, open. MIT.

One paragraph (1.1) + a 20-second GIF of `make demo`.

## Try it (do X, see Y)
  Requirements: bun ≥ 1.2, docker (optional: without it `make demo` runs the offline replay), git.
  1. `git clone … && cd near-ghost-paths && bun install`                      → see "n packages installed"
  2. `make demo`                                                                → see the 7 steps of §1.10 with addresses, tx links, "stranger sees 0 payments"
  3. `make test`                                                                → see sdk, contract and fixture tests green, incl. "derived address == MPC-signed key" for secp256k1 and ed25519
  4. `make test-live`                                                           → one real MPC signature each on secp256k1 and ed25519 (~30 s), recovered keys match
  5. `make web`                                                                 → http://localhost:5173, Send / Scan / Sweep / Auditor
  6. Optional: `make demo-testnet` (Sepolia, Solana devnet, BTC testnet4; needs funder keys, see .env.example)
  7. Optional: `make demo-live` (NEAR mainnet + Base + 1Click confidential sweep; needs MAINNET_APPROVED=1 and funds)
  Troubleshooting: testnet MPC down → `make demo-replay`; docker absent → same.

## What it does / how it works
  Diagram (§2) + the 8-line protocol (§1.5–1.7). Link docs/SPEC.md.

## NEAR technology used
  - Chain Signatures (`v1.signer`, `v1.signer-prod.testnet`): public key derivation keyed on (predecessor, path); `sign` with payload_v2 Ecdsa/Eddsa, domains 0 and 1; 1 yocto deposit; chainsig.js adapters.
  - Our contract on NEAR (near-sdk-rs 5.30): registry + announcement log (NEP-297 events) + sweep gateway using `env::ecrecover`.
  - NEAR Intents 1Click (mainnet only, behind a flag): confidential sweep (`confidentiality: basic`) to break consolidation links.
  - NEAR testnet faucet for zero-secret demos; (Mode A) direct account signing.

## Privacy: what is hidden, what is not   (verbatim from docs/THREAT-MODEL.md summary, §1.9)
  Hidden: … Not hidden: announcer account, timing, amounts, view-tag leakage with small anonymity sets, consolidation linkability, MPC threshold trust, Mode A sweep linkability. Comparison with ERC-5564.

## Private payroll (realworld)
  `ghost payroll payroll.csv --chain evm:8453` pays N recipients; the accountant gets `ghost export-viewing-key`. (If W3 ships the batch command; else describe the per-payment flow.)

## Architecture and repo layout  (§2, §3 condensed)
## Testnet deployments  contract id, example tx links, MPC signer ids
## Development  build contract reproducibly (`cargo near build reproducible-wasm`), run tests, env flags table (§2)
## Libraries and AI-generated code
  chainsig.js 1.1.16, @near-js 2.5, @noble/curves 2.x, @noble/ciphers, @noble/hashes, viem, @solana/web3.js, bitcoinjs-lib (via chainsig.js), near-sdk-rs 5.30, near-workspaces-rs, Vite/React. All code in this repo was written during the hackathon window by Claude agents (Opus 5.5 / Sonnet 5.5 / Fable 5.1) directed by the submitter; see docs/AI-DISCLOSURE.md.
## Related project by the same submitter
  Tripwire — injection-proof policy changes for agent wallets (github.com/AaroneGeorge/near-tripwire), also entered in NEAR HACKATHON. Independent code, independent problem; disclosed per the rules.
## Limitations and next steps   (Mode A vs B, BTC multi-UTXO, no upgrade path, relayer economics, payroll batching)
## License  MIT
```

---

## 8. What the owner must provide, and when

Nothing is needed for `make demo`, `make demo-replay`, `make test`, the testnet contract or the testnet video path — all keys are faucet-created.

| When | Item | Why |
|---|---|---|
| Now (Nov 9) | Approve this plan; confirm Mode B as the product and Mode A as fallback; confirm tracks `privacy, realworld, open`; confirm repo `AaroneGeorge/near-ghost-paths`, MIT | unblocks W0–W5 |
| Now | OK to use `sudo -u claude lechu-wallet send sepolia|base-sepolia|solana-devnet …` for `demo-testnet` (≈ 0.05 ETH, 0.5 SOL on test networks; sends immediately, no fingerprint) | public-testnet video without faucets |
| Nov 10–12 (optional) | Solve two captchas when asked: coinfaucet.eu BTC testnet4 to an address we print (BTC in the video); faucet.solana.com if lechu-wallet devnet SOL runs out | BTC/Solana on public testnets |
| Nov 12 evening | Decide: mainnet `demo-live` yes/no. If yes: approve ≈ $50 total — ~3 NEAR to an address we print (contract deploy on mainnet; or create `ghost-paths.near`-style named account yourself and give us a function-call key — we must not create named mainnet accounts), ~$15 of ETH on Base in lechu-wallet mainnet (currently 0) for one payment + gas + 1Click fee, optional $20 of BTC. Each mainnet send still needs your fingerprint in the app | §1.10 step 8 |
| Nov 13 | Review the video and README privacy section (10 minutes) | claims you sign off on |
| Nov 14 by 18:00 UTC | Make the repo public (or tell us to); post on X with the video, text we draft, tags @NEARProtocol #NEARHackathon (optionally @NearLegion @NearBuilders); give us the post URL | submission fields |
| Nov 14 by 20:00 UTC | Submission details: project name "Ghost Paths", lead name, email (aaroneofficial1879@gmail.com per CONTEXT), size `1`, mainnet payout account (you create it), consent sentence read verbatim; confirm the printed JSON payload | one-shot `POST /api/applications` |

Not needed for this project: NEAR AI Cloud key, PingPay key, Agent API key (those are Tripwire's).
