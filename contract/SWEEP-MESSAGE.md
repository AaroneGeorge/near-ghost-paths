# Sweep message byte layout

Shared by the SDK (`packages/sdk/src/stealth.ts`: `sweepPreimage`, `sweepMessage`, `signSweep`,
`verifySweepArgs`) and the contract (`contract/src/sweep.rs`: `sweep_preimage`, `sweep`, `sweep_digest`).
Mirrored in `docs/SPEC.md` §6. Any change needs W1 + W2 ack.

History: W1 first drafted this file (2026-11-09 02:10 UTC) with u8 length prefixes before `contract_id`
and `path`. W2 had already implemented PLAN.md §1.7's layout (no prefixes) in parallel. W1 then switched
the SDK to W2's layout, because it is already injective under the contract's checks (below). This file
now describes what both implementations do.

## Preimage

All integers are big-endian. Strings are their ASCII bytes. Payloads are the raw bytes obtained by
hex-decoding the `payloads[i]` strings passed to `sweep`.

| # | Field | Bytes | Notes |
|---|---|---|---|
| 1 | `"ghost-paths/v1/sweep"` | 20 | domain tag |
| 2 | `contract_id` | var (2..64) | `env::current_account_id()`, e.g. `v1.ghost-paths.testnet`; no length prefix |
| 3 | `path` | 68 | `"gp1/" + 64 lowercase hex`; no length prefix |
| 4 | `u8(domain_id)` | 1 | 0 = secp256k1/ECDSA, 1 = ed25519/EdDSA |
| 5 | `u64be(expires_block)` | 8 | last block height at which the sweep is valid |
| 6 | `u8(n)` | 1 | number of payloads (v1: exactly 1) |
| 7 | n × (`u16be(len_i)` ‖ `payload_i`) | var | ECDSA: 32-byte hash (< n); EdDSA: 1..=1232 bytes of the Solana message |

`msg = sha256(preimage)`, 32 bytes. The contract's `sweep_digest` view returns it as hex.

Why fields 2 and 3 need no length prefix: NEAR account ids use only `[a-z0-9._-]` and never contain
`/`. The path always has the form `gp1/<64 hex>`, which the contract checks against `sha256(k_pub)` and
the SDK checks before hashing. So the first `/` in the preimage after byte 20 is always `path[3]`, and
the boundary between contract and path is unambiguous.

## Signature

- `sig`: the 64-byte compact `r ‖ s` as 128 lowercase hex chars (no `0x`), **low-s**.
- `v`: the recovery id, 0 or 1 (the contract accepts 0..=3 but rejects 27/28).
- The signature is over the 32-byte `msg` directly (no further hashing), with an RFC 6979 deterministic nonce.
  noble `secp256k1.sign(msg, d, {prehash:false, lowS:true, format:"recovered"})` and
  k256 `sign_prehash_recoverable` produce identical signatures.

## Contract checks (`sweep.rs`)

1. `env::block_height() <= expires_block`, else `"expired"`.
2. Prepaid gas ≥ 50 Tgas (clients attach 300), deposit ≥ 1 yocto.
3. `domain_id ∈ {0,1}`, exactly one payload; ECDSA payload is 32 bytes and < n; EdDSA payload is 1..=1232 bytes.
4. `k_pub` is 64 bytes (128 hex, uncompressed x ‖ y **without** `04`), and `path == "gp1/" + hex(sha256(k_pub))`.
5. `env::ecrecover(msg, sig, v, malleability_flag = true) == k_pub`. A high-s signature is rejected.
6. Forward `sign({request:{payload_v2:{Ecdsa|Eddsa: hex}, path, domain_id}})` to the signer with 1 yocto.

## Test vectors

`packages/sdk/test/vectors.json` (`sweep`, `contract_vectors`), reproduced in `docs/SPEC.md` §8.
`contract_vectors` uses the same inputs as `contract/src/tests.rs::canonical_vectors`
(d_K = 0x11…11, expires 123456789, payloads 0x42×32 for domain 0 and 0x00..0x63 for domain 1).
The SDK test `sweep message > W2 canonical inputs` asserts them, and
`packages/sdk/test/xcheck_vectors.py` re-derives the main vector with pyca/cryptography.

## W2 acknowledgement (2026-11-09)

W2 checked this file against `contract/src/sweep.rs` (deployed to `v1.ghost-paths.testnet`, code hash
`Gep6ZYfa43r5ZJk97EAma1GjyPfuXrfcvTDPbJXN1fF6`): it matches. The SDK's `contract_vectors` digests and
signatures equal the Rust `canonical_vectors` output (domain 0 digest `0f1553c6…c4c7ae`, domain 1
digest `d433113a…869555`). Notes the SDK should keep in mind:

- The contract accepts upper- or lower-case hex and an optional `0x` in `payloads`, `k_pub` and `sig`;
  the digest uses the decoded bytes. `path` must be exactly `gp1/` + **lowercase** hex.
- JSON argument types: `domain_id`, `expires_block` and `v` are JSON numbers (not strings).
- `expires_block` is inclusive. Unused deposit above 1 yocto is refunded to the caller.
- A valid sweep can be resubmitted until it expires; the MPC then signs the same payload again
  (harmless: same transaction). Pick `expires_block` = current height + ~200.
- noble's `format:"recovered"` returns `v ‖ r ‖ s` (recovery byte first); send `sig = r ‖ s`, `v` separately.
