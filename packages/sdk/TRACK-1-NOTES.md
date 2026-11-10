# Track W1 (crypto SDK): notes, 2026-11-09

## Status

Done: PLAN §1.4–1.7 are implemented as pure functions plus a registry client. All of it is typechecked, lint-clean (biome) and tested.

| File | What |
|---|---|
| `src/types.ts` | Frozen interfaces (PLAN §3) plus the additions listed below |
| `src/constants.ts` | KDF labels, path prefix, MPC/Ghost contract ids, RPC URLs, gas/deposits, `domainForChain` |
| `src/keys.ts` | seed → `{dSpend, spendPub, viewPriv, viewPub}` (HKDF "spend"/"view"); meta, keystore (0600), viewing bundle, parsers |
| `src/stealth.ts` | `ecdh`, `viewTag`, `tweak`, `stealthPub`, `stealthPath`, `stealthPriv`, `makeTarget`, `targetFromSecret`, `predecessorFor`, `sweepPreimage`/`sweepMessage`, `signSweep`, `recoverSweepKey`, `buildSweepArgs`, `verifySweepArgs` |
| `src/derive.ts` | `derivePublicKey` / `deriveAddress` (local; chainsig.js epsilon KDF), evm/btc/sol address encoders, `networkOf`, `rootPublicKey` |
| `src/announce.ts` | memo XChaCha20-Poly1305 (`encryptMemo`/`decryptMemo`), `buildAnnouncement`, `validateAnnounceArgs`, `decodeAnnouncement` |
| `src/scan.ts` | `scanOne`, `scanAnnouncements`, `scanRegistry` (pagination), `toPayments`/`scan` (balances via adapters, `swept`) |
| `src/registry.ts` | `MemoryRegistry` (contract rules, fake MPC hook, `.as(account)`), `NearRegistry` (near-api-js 7.4; self or relayer), `toMpcSignature` |
| `src/near.ts` | failover RPC provider, `viewFunction`, `blockHeight`, `makeAccount`, `newKeyPair`, `createFaucetAccount`, `randomTestnetId`, `checkRootKeys`, `checkDerivation`, `fetchDerivedPublicKey` |
| `src/index.ts` | re-exports everything above. **W3**: add `export * from "./chains/index.ts"` / oneclick here |
| `docs/SPEC.md` | full spec plus test vectors (§8) |
| `contract/SWEEP-MESSAGE.md` | the one file I created in contract/ (see the deviation below) |
| `test/{stealth,announce-scan,derive}.test.ts`, `test/vectors.json`, `test/xcheck_vectors.py` | tests and vectors |

## Tests

- `cd packages/sdk && bun test`: **33 pass**. That includes live free view calls to `v1.signer-prod.testnet`:
  the root keys equal chainsig.js on domains 0 and 1, and `derivePublicKey(contract|account, gp1/… path)` equals the RPC `derived_public_key`
  byte for byte on domains 0 and 1 (5 cases, including the Mode A predecessor).
- `make test-ts` (GHOST_REPLAY=1) skips the 2 live tests. The offline test still checks against recorded RPC outputs.
- Covered: `K == (d_spend+h)·G` (60 random cases), the SPEC vectors (keys/S/tag/h/K/path/address/d_K for evm, sol, btc),
  `chain_tag` binding, the path format, Mode A vs B addresses, the view-tag pass rate (~1/256 over 4000 trials),
  zero-ECDH rejection, the sweep preimage/msg/sig vectors, low-s, high-s rejection, every sweep field bound,
  build/verify sweep args with rejections, memo round-trip and AEAD failures (wrong key, chain, E or byte),
  the announce codec and validation, scan over 302 announcements (recipient, auditor, stranger), the `full` (no-view-tag) mode,
  balances/swept, MemoryRegistry sweep rules (expired, tampered, 2 payloads), keystore 0600 round-trip and tamper detection,
  and MPC signature parsing.
- Cross-implementation checks:
  - `python3 -I packages/sdk/test/xcheck_vectors.py` re-derives every SPEC vector with pyca/cryptography: OK.
  - W2's Rust `canonical_vectors` (k256) printed the same digest and signature as the SDK for both domains
    (run with a separate CARGO_TARGET_DIR). The SDK test `W2 canonical inputs` pins them.
  - deriveAddress for evm/btc/sol equals chainsig.js's `EVM`/`Bitcoin`/`Solana` adapters' `deriveAddressAndPublicKey`.

## Deviations and decisions (please read: W2, W3, W4)

1. **Sweep message layout.** contract/SWEEP-MESSAGE.md didn't exist, so I wrote it at 02:10 UTC with u8 length
   prefixes before `contract_id` and `path`. W2 implemented PLAN §1.7's layout (no prefixes) in `sweep.rs` in parallel (02:11).
   I **switched the SDK to W2's/PLAN's layout** and rewrote SWEEP-MESSAGE.md to describe the code. The layout is injective,
   because NEAR account ids can't contain `/` and the path is a fixed 68-char `gp1/<hex>` string (the SDK enforces both).
   The two implementations now agree byte for byte (vectors above). **W2: please ack.** If you edit SWEEP-MESSAGE.md, keep the vectors.
2. **types.ts additions** (none changes the PLAN shapes): `Hex`, `Hex32/33/64`, `NearNetwork`, `DomainId`, `Mode`, `Memo`,
   `AnnounceArgs/Result`, `SweepArgs/Result`, `Via`, and the `Registry` interface (implemented by both registries).
   `ViewingBundle` gained the optional `mode?` and `network?` fields: Mode A scanning needs the predecessor, and the network comes from `signer` when absent.
   `Registry.announce(args, via?)` has an optional `via`.
3. **Hex convention:** lowercase, no `0x`, everywhere except EVM addresses (EIP-55).
4. **`MpcSignature` ECDSA `v`** is normalised to the recovery id **0|1** by `toMpcSignature`; chainsig's `toRSV` gives 27/28.
   W3's `chains/sig.ts` accepts both, so nothing breaks.
5. **`deriveAddress().publicKey` format** follows chainsig.js per chain: evm is uncompressed `04…` hex, btc is **compressed** hex, sol is base58.
6. **Memo `ct`** = hex(nonce24 ‖ ciphertext‖tag), capped at 512 hex chars (plaintext ≤ 216 B). The contract allows 1024; the SDK is stricter on purpose.
7. **`noViewTag`** (random tag): the recipient can find the payment only in `scan(..., {full: true})`, and only if the announcement
   has a memo, because the AEAD is the match test. CLI (W3): require a memo with `--no-view-tag`.
8. **Tag false positives:** about 1/256 of foreign announcements *without* a memo pass `scanOne`. They show up as unfunded hits,
   so filter by balance in the UI/CLI. With a memo there are no false positives.
9. **RPC URLs** (verified today): `rpc.testnet.pagoda.co` and `near.lava.build` are deprecated or dead. Using fastnear plus `rpc.*.near.org`.
   `NEAR_RPC_URL` env is tried first.
10. Mainnet Ghost contract default `ghost-paths.near` is a placeholder until Nov 13.
11. `packages/sdk/package.json` deps added: @noble/curves, hashes and ciphers 2.4.0, @scure/base 2.2.0, chainsig.js 1.1.16, near-api-js 7.4.0
    (this changed bun.lock). I deleted the scaffold's `test/placeholder.test.ts`.

## Perf

noble X25519 is pure JS at about 1 ms per op, so scanning runs about 1,000 announcements/s, and `makeTarget` is a few ms (most of it chainsig derivation).
That's fine for the demo; heavy registries would want a cursor (`scanRegistry` returns `next`).

## TODO / handoffs

- W3: export chains/oneclick from `src/index.ts`. Use `buildSweepArgs` + `NearRegistry.sweep(args, via)`, and print `SELF_SUBMIT_WARNING` for `via: "self"`.
  `blockHeight()` + `DEFAULT_SWEEP_TTL_BLOCKS` give `expires_block`.
- W5: THREAT-MODEL.md from PLAN §1.9. SPEC §7 links to it.
- W6: review KDF labels (constants.ts), low-s/ecrecover (stealth.ts `recoverSweepKey`), the memo nonce (random 24 B, XChaCha) and the injectivity argument in SWEEP-MESSAGE.md.

## Reuse

I searched the Code Garage three ways (stealth/ECDH/HKDF, NEAR RPC client, XChaCha helper). It had only general references, nothing applicable, so I used no Garage items.
Libraries do all the primitives: @noble/curves, @noble/hashes, @noble/ciphers, @scure/base, and chainsig.js for MPC derivation.
