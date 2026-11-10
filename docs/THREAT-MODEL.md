# Ghost Paths threat model: what is hidden and what is not

Scope: protocol version 1 as implemented in this repository (`docs/SPEC.md`), Mode B (the product):
the Ghost Paths contract is the MPC predecessor and a relayer submits sweeps. Mode A is described
at the end. Last checked against the code on 2026-11-09. Nothing here is an audit; see
"What we did not verify".

## One-paragraph summary

Ghost Paths hides **who** was paid, not **that** a payment happened and not **how much**. A stranger
who reads every NEAR transaction and every target-chain transaction cannot link a one-time address
`A` to the recipient's NEAR account (nor to the recipient's other one-time addresses), unless the
recipient later behaves in a linkable way (for example, sweeping several payments to one address).
Amounts, timing, the payer's own address, and the fact that the recipient has registered are public.

## Actors and what each learns

| Actor | Learns | Cannot learn / do |
|---|---|---|
| Public observer (NEAR + target chains) | The registry (who registered, when), every announcement `(chain, E, tag, ciphertext, announcer, time)`, every one-time address, its balance and its transactions, every sweep `(contract, path, K, payload)` on NEAR | Which registered recipient an announcement targets, beyond the 1-byte view tag; which recipient owns a one-time address; the recipient's total income |
| Payer (inherent) | Everything about their own payment: recipient, address, amount, `E` | Other people's payments |
| Auditor (holds a viewing bundle) | Every payment to that recipient: address, chain, balance, decrypted memo, swept or not | Cannot sweep: the bundle has `k_view` and the spend **public** key only (`ghost scan --viewing-key` prints "viewing key only: no spend key, cannot sweep") |
| Relayer | Each sweep request (`K`, path, destination chain transaction) and each announcement it posts; the caller's IP | The recipient's NEAR account (never sent to it). Cannot redirect funds: the destination is inside the signed digest. Can censor or delay; the user can always submit sweeps from their own account (that links the sweep to that account, and the CLI warns) |
| MPC operators | Exactly what the public sees: predecessor = the Ghost Paths contract, `path`, payload | Which recipient a path belongs to |
| NEAR validators / NEAR RPC providers | Same as the public, plus IPs of the clients they serve. Scanning downloads the whole announcement log, so a NEAR RPC does not learn which announcements are yours | |
| Target-chain RPC / indexer providers (EVM RPC, Solana RPC, esplora) | **The set of a recipient's one-time addresses, linked together and to the client's IP.** `ghost scan`, the web Scan/Auditor views and `ghost sweep` ask the chain's RPC for the balance of exactly the hits, in one burst, on every refresh (and the sweep destination's balance afterwards) | Nothing more than the addresses: not the NEAR account, unless the IP or timing gives it away. Mitigation (not built): run your own node or use Tor, or query a superset of addresses as decoys |

## What is hidden (Mode B)

1. **The link between a one-time address and the recipient**, before and after the sweep. The address is the
   MPC-derived key for `(v1.ghost-paths.testnet, "gp1/" + sha256(K))`, where `K = P_spend + h·G` and `h` comes from an X25519 shared
   secret that only the payer and the recipient can compute. Linking `A` to `P_spend` needs that shared secret
   (the Diffie-Hellman problem on X25519) or `d_spend`. The security argument is the same as ERC-5564's.
2. **Which registered recipient an announcement is for.** The announcement has no recipient field (the web UI shows
   `"recipient": none, ever`). Only the holder of `k_view` can recognise it.
3. **The recipient's income** across payments, because the addresses are unrelated to each other.
4. **At sweep time, the recipient's NEAR account.** The sweep is authorised by a signature from the per-payment key
   `K`, verified on chain with `ecrecover`, and submitted by the relayer. On NEAR the observable event is "the Ghost
   Paths contract requested a signature for path `gp1/...`"; no transaction names the recipient.
5. **Who may spend.** The recipient holds two keys (spend and view) and no Bitcoin, Ethereum or Solana key. The
   per-payment spend key `d_K = d_spend + h` is never stored.

The demo shows this literally: `ghost scan --as carol` (a different viewing key) finds 0 payments in a log that
contains Bob's two; the web UI's "As a stranger" view lists the whole public log with a
"recipient: not on chain" column.

## What is NOT hidden

- **That a NEAR account uses Ghost Paths, and when it registered.** `register` is a normal call by the recipient.
- **The announcer.** Each announcement stores the NEAR account that posted it. In the demo the relayer posts them, so the
  payer's NEAR identity does not appear; a payer who self-submits is visible. Timing is public either way.
- **Amounts and the payer's address on the target chain.** They are ordinary transactions. Ghost Paths hides *who*, not *how much*.
- **Timing correlation.** An announcement and the payment it belongs to appear within seconds of each other. An observer who
  watches both can often match them, which does not reveal the recipient but narrows who could have been paid.
  This is the same weakness as ERC-5564.
- **The view tag leaks one byte of the shared secret.** A scanner can skip 255/256 of foreign announcements, and an observer
  learns that an announcement matches one of 256 buckets. With a small registry (the demo has three accounts) that can identify
  the recipient. `--no-view-tag` (random tag, "bigger anonymity set") removes the leak at the price of a slower scan and a mandatory encrypted memo
  (the AEAD is the match test). It is off by default.
- **Consolidation.** Sweeping two stealth payments to the same destination links them to each other on chain
  (common-input ownership on Bitcoin, same recipient on Ethereum/Solana), and to the recipient if the destination is already known to be theirs.
  Mitigation: use a fresh destination **that you control** for every sweep. The Ghost Paths contract and CLI do not create one for you. (The web UI's
  "Fresh throwaway address" button is a demo helper: that address is unspendable, so it is offered only on the local demo chains.)
- **Sweep transactions on the target chain.** From `A` to the destination, amounts visible. Only the *recipient identity* is hidden, not the flow.
- **Memos are encrypted, but their length is visible** (the ciphertext is public).
- **Registry spam and storage.** Anyone can announce; the announcer pays the storage (about 0.0013 NEAR each). Foreign announcements show up as unfunded hits
  about 1/256 of the time when they carry no memo; scanners filter by balance.

## Trust assumptions and failure modes

- **MPC threshold trust (inherited).** Chain Signatures signs for any derived key if a supermajority of the network's nodes collude
  (the signer's `state` view lists the threshold; it was 11 on testnet and 10 on mainnet when we checked). A colluding supermajority
  could sign for any one-time address. Ghost Paths adds no trust beyond that, but removes none.
- **The Ghost Paths contract.** It has no owner and no upgrade method in v1. The only path to change it is a key on its account. **The testnet
  deployment `v1.ghost-paths.testnet` still has one full-access key**, kept for hot-fixes during the hackathon; it will be deleted
  before judging (see the README for the current state). Until then, whoever holds that key could redeploy the contract under the same account. Because the MPC derives every stealth address from the *contract account* as the predecessor,
a malicious redeploy could request signatures for any path and so spend from any one-time address of this deployment.
The contract itself holds no user funds, but this is the single most important trust item on testnet.
The mainnet deployment does not exist yet.
- **The relayer** can censor, delay, log requests and learn IP addresses. It cannot steal: the sweep digest binds contract id, path, domain, expiry and payload (hence the destination).
  A signed sweep can be replayed until `expires_block` (default current height + 600 blocks, about 10 minutes). That is harmless: the MPC would sign the same payload again, and the target chain's
  nonce or UTXO prevents a double spend. The relayer itself answers a repeated sweep from a cache instead of paying again, rate-limits POSTs per IP and in total,
  refuses foreign browser `Origin`s, and can require a shared secret (`RELAYER_TOKEN`) or an IP allowlist (`RELAYER_ALLOW_IPS`).
- **Which contract.** In Mode B the contract *is* the MPC predecessor of every stealth address, so the client must talk to the real one. Before `pay`, `register` and `sweep`
  the CLI checks the contract account's `code_hash` against a pinned value (testnet: the committed wasm, `Gep6ZYfa…`). Mainnet has no pinned hash yet, so live mainnet use
  is refused unless `GHOST_CODE_HASH` names the released build.
- **Key loss.** The seed in `~/.ghost/<profile>.json` (mode 0600) is the only thing that can sweep. There is no recovery. The viewing bundle cannot sweep.
- **Local files.** The keystore holds the seed in plaintext. Protect it like any wallet file.
- **Browser UI.** Spend keys never reach the browser; `ghost serve` runs the CLI in-process on 127.0.0.1 and refuses foreign `Host` and `Origin` headers.
  Every POST route (pay, sweep, scan) and `/api/viewing-bundle` also need a random per-session token, printed in the URL `ghost serve` shows (`/?token=…`), so other
  local processes and web pages cannot drive it. `ghost serve` refuses to bind anything but loopback unless `GHOST_SERVE_TOKEN` is set.
  An auditor's uploaded viewing bundle lives only in React state. The `/api/viewing-bundle` route that powers the demo shortcut chips returns a view-only secret over loopback HTTP.
- **1Click / NEAR Intents (mitigation for consolidation, mainnet only).** `confidentiality: basic` needs `ONECLICK_API_KEY`. Without it the CLI refuses and
  shows a *public* dry quote and says so. We have **not** run a confidential sweep. Where it works, the trust moves to the Intents solvers and 1Click, which see the deposit and the withdrawal.
- **Bitcoin** is derive-only in this release: the address is derived and shown, but there is no funded testnet payment in the demo, and the Bitcoin sweep path was tested offline against a fake esplora only.

## Mode A (fallback, not the default)

With `GHOST_MODE=account` the predecessor is the recipient's NEAR account and sweeping means the recipient calls `v1.signer.sign` directly.
That transaction is public and carries the path, so anyone can recompute the stealth address and link it to the account.
Privacy lasts only until the sweep. The CLI prints a warning. It is kept as a documented fallback; the demo's default is Mode B.

## What we did not verify

- No external audit. The KDF labels, low-s handling, `ecrecover` malleability flag and sweep-digest layout are covered by tests and cross-checked against
  an independent implementation (pyca/cryptography for the vectors; the Rust contract's k256 for the sweep digest), not by a cryptographer.
- The anonymity set on testnet is tiny (a handful of demo accounts), so the practical privacy of the *demo* is weaker than the protocol's.
- Network-level privacy (Tor, RPC provider logs) is out of scope.
- The view-tag trade-off, the announcer field and timing correlation are known design limits, not bugs we plan to fix before the deadline.
