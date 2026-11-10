# Ghost Paths protocol specification (v1)

Owner: W1. This file stays equal to PLAN.md §1.4–1.9 plus the exact encodings, and every decision a
second implementation needs. Code: `packages/sdk/src/{keys,stealth,derive,announce,scan}.ts`. The test
vectors (§8) are asserted in `packages/sdk/test/*.test.ts` and re-derived independently with
pyca/cryptography in `packages/sdk/test/xcheck_vectors.py`.

Ghost Paths adapts ERC-5564 stealth addresses ([EIP-5564](https://eips.ethereum.org/EIPS/eip-5564),
scheme 1: secp256k1 with view tags) to NEAR Chain Signatures. The differences from ERC-5564 are in §9.

## 1. Conventions

- **Hex**: every binary value in JSON, contract args and keystores is lowercase hex **without** `0x`.
  The one exception is EVM addresses, which are `0x` + EIP-55 checksum.
- **Strings** are hashed as their UTF-8/ASCII bytes. `||` means concatenation.
- **HKDF** is HKDF-SHA256 (RFC 5869) with `salt = "ghost-paths/v1"`. Each derived value has its own `info` label.
- **Scalars**: `int(x)` is the big-endian integer. `n` is the secp256k1 group order. `G` is the secp256k1 generator.
- **Chain tags** (`chain_tag`): `evm:<chainId>` (e.g. `evm:31337` anvil, `evm:11155111` Sepolia, `evm:84532`
  Base Sepolia, `evm:8453` Base), `btc:regtest|testnet4|mainnet`, `sol:local|devnet|mainnet`.
  Domain 0 (secp256k1) serves `evm:*` and `btc:*`. Domain 1 (ed25519) serves `sol:*`.
- Libraries: @noble/curves 2.4 (secp256k1, x25519), @noble/hashes 2.4 (sha256, HKDF, keccak, ripemd160),
  @noble/ciphers 2.4 (XChaCha20-Poly1305), @scure/base (base58, bech32), chainsig.js 1.1.16 (MPC
  derivation). None of the primitives are hand-rolled.

## 2. Keys

| Key | Derivation | Encoding |
|---|---|---|
| `seed` | 32 bytes from the platform CSPRNG | keystore `seed` (hex32), file mode 0600 |
| `d_spend` | `int(HKDF(ikm=seed, info="spend", 32)) mod n`; reject 0 | never stored, recomputed from `seed` |
| `P_spend` | `d_spend·G` | 33-byte compressed (`spend_pub`, hex33) |
| `k_view` | `HKDF(ikm=seed, info="view", 32)`; X25519 clamps it on use | `view_priv` (hex32) |
| `P_view` | `X25519(k_view, 9)` | `view_pub` (hex32) |

- **Meta-address** (registry entry, keyed by the NEAR account id; human form `ghost:<account>`):
  `{"v":1, "mode":"contract"|"account", "spend_pub":hex33, "view_pub":hex32}`.
  `mode = "contract"` is Mode B (the product): the MPC predecessor is the Ghost Paths contract.
  `mode = "account"` is Mode A (fallback): the predecessor is the recipient's account, and the sweep is
  publicly linkable to it.
- **Viewing bundle** (auditor export; can scan, can never sweep):
  `{"v":1, "account", "view_priv":hex32, "spend_pub":hex33, "signer":<ghost contract id>, "mode"?, "network"?}`.
  `network` defaults to `testnet` if `signer` ends in `.testnet`, else `mainnet`.
- **Keystore** = viewing bundle + `seed`. On load, the stored `spend_pub`/`view_priv` must match what the seed derives.

## 3. Pay (sender; needs only the registry entry)

```
e        = 32 random bytes;   E = X25519(e, 9)
S        = X25519(e, P_view); reject all-zero S
tag      = sha256("ghost-paths/v1/view-tag" || S)[0]                              (u8)
h        = int(HKDF(ikm=S, info="tweak" || E || P_spend(33) || utf8(chain_tag), 32)) mod n; reject 0
K        = P_spend + h·G;     reject infinity
K_unc    = x || y             (64 bytes, K uncompressed without the 0x04 prefix)
path     = "gp1/" || hex(sha256(K_unc))                                            (68 ASCII chars)
pred     = mode == "contract" ? <ghost contract id> : <recipient account id>
A        = address of derive(pred, path) on chain_tag (§4)
memo_ct  = optional, §5
announce(chain_tag, E, tag, memo_ct)          # no recipient field, ever
```

Putting `chain_tag` into `h` means one announcement yields one address on one chain. `--no-view-tag`
replaces `tag` with a random byte; the sender must then attach a memo (§5).

## 4. Chain Signatures derivation

Verified against near/mpc `kdf.rs` and chainsig.js:
`epsilon = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" || predecessor || "," || path)`.
- Domain 0 (secp256k1): `child = Root_secp + int(epsilon)·G`.
- Domain 1 (ed25519): `child = Root_ed + (int_LE(epsilon) mod L)·B`.

The SDK calls chainsig.js `utils.cryptography.deriveChildPublicKey[Ed25519]` with the root keys
hardcoded in chainsig.js. Those match the signer's `public_key` view; `checkRootKeys()` is a live test.
The derived keys equal `v1.signer-prod.testnet`'s `derived_public_key({path, predecessor, domain_id})`
byte for byte; that is a live test on both domains.

Addresses (cross-checked against chainsig.js's EVM, Bitcoin and Solana adapters):
- `evm:*`: `0x` + EIP-55 of `keccak256(child_x || child_y)[12..32]`.
- `btc:*`: P2WPKH, `bech32(hrp, 0, ripemd160(sha256(compressed child)))`, with hrp `bc` (mainnet),
  `tb` (testnet4) or `bcrt` (regtest).
- `sol:*`: `base58(child_ed25519)`.

| Network | MPC signer | Ghost Paths contract (default) |
|---|---|---|
| testnet | `v1.signer-prod.testnet` | `v1.ghost-paths.testnet` |
| mainnet | `v1.signer` | `ghost-paths.near` (TBD on Nov 13) |

## 5. Announcement, memo, scan

Contract record: `{idx:u64, chain, eph:hex32 (E), tag:u8, ct:hex|null, block_height, timestamp_ms, announcer}`.

**Memo** (optional, authenticated):
```
key   = HKDF(ikm=S, info="memo", 32)
nonce = 24 random bytes
ct    = hex( nonce || XChaCha20-Poly1305(key, nonce, aad = E || utf8(chain_tag), pt = JSON) )
JSON  = {"amount"?, "asset"?, "note"?, "txid"?}  (all strings; plaintext ≤ 216 bytes, so ct ≤ 512 hex chars)
```

**Scan** (recipient, or an auditor holding `k_view` + `P_spend`):
```
for a in get_announcements(from, ≤200) ...:
  S' = X25519(k_view, a.eph); skip if all-zero
  skip if tag(S') != a.tag                      # unless full mode
  if a.ct: memo = decrypt(...) ; skip if the AEAD fails   # drops view-tag false positives
  elif full mode: skip                          # untagged announcements must carry a memo
  recompute h, K, path, A with a.chain → hit
```
About 1/256 of foreign announcements without a memo pass the tag check. They show up as unfunded hits,
and callers filter them by balance. A foreign announcement with a memo never passes, because its AEAD fails. `swept` = balance 0 and the payment
was seen funded before.

## 6. Sweep (recipient only; needs `d_spend`)

```
d_K      = (d_spend + h) mod n                 # never stored; d_K·G == K
payloads = chain adapter hashes to sign        # ECDSA: 32-byte hash; EdDSA: Solana message bytes
msg      = sha256( "ghost-paths/v1/sweep" || contract_id || path || u8(domain_id)
                   || u64be(expires_block) || u8(n) || Σ (u16be(len_i) || payload_i) )
(sig, v) = ECDSA_secp256k1(msg, d_K)           # 64-byte r||s, low-s, RFC 6979, v ∈ {0,1}, no prehash
sweep({path, domain_id, payloads:[hex], expires_block, k_pub: hex(K_unc), sig, v})  1 yocto/payload, 300 Tgas
```

The byte layout, the reason it needs no length prefixes, and the contract's check order are in
[`contract/SWEEP-MESSAGE.md`](../contract/SWEEP-MESSAGE.md). The contract recomputes `msg` using its own
`current_account_id`, so a sweep authorisation is bound to one deployment, one path, one domain, one
expiry and the exact payload (and hence the destination). A relayer can only censor or delay.
`expires_block` defaults to the current height + 600. v1 allows one payload per call.

## 7. Threat model

See `docs/THREAT-MODEL.md` (W5, from PLAN §1.9). In short: Mode B hides the link between a stealth
address and the recipient before and after the sweep, assuming DDH on X25519. Not hidden: the registry
membership, the announcer and timing, the amounts, the 1-byte view-tag leak in small anonymity sets,
consolidation when sweeping to a shared destination, the MPC threshold trust, and everything in Mode A.

## 8. Test vectors

All values are hex. Inputs: `seed = 11×32`, ephemeral `e = 33×32`, contract (predecessor)
`v1.ghost-paths.testnet`, network testnet.

```
seed      = 1111111111111111111111111111111111111111111111111111111111111111
d_spend   = 98d560ca6ef1968f5caaef310bc89fa5d51db56907c00e8915538a676a0ae847
P_spend   = 03ccc43764817557313980788b759f5807f3c9af2f17d1e7f602c2f89e4803558d
k_view    = ce8989ed0da639cb8ed5694302fd6c4487a71837911336df85046a9b14c3efde
P_view    = 08f8e42e8083f74a6106c34f22107e4485b564193671c39817b2e34d93804f7f
E         = 7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14
S         = ef125673ca28dd59642004e4e2aac168f8f88299fb4ba8f25abe8a11f0e04c2a
tag       = 76  (0x4c)
```

**evm:31337** (`chain_tag = "evm:31337"`, domain 0)

```
h       = ddd431dc16da1d14572c8528bcf7d8b392839f183f43eb2c35495124ea08a981
K       = 04f04f6c87828514eae033703a853125d77e14fa3eb8cec8c8e4bf5e4c42cd6965bbc17e6f05276ccca1e74ac37b29a70029968a939aebb5a4c66ecadc9379c11b
path    = gp1/75e9c9993f552e3c028f6c4fb38126f587d243a96ca03103486b15cc14a9167a
address = 0x7a580e9A1559FD4299B5527B55dcbD19528fCa62
d_K     = 76a992a685cbb3a3b3d77459c8c0785aacf2779a97bb59798aca7cff83dd5087
```

**sol:local** (`chain_tag = "sol:local"`, domain 1)

```
h       = 97f4309d7a34887e606a806b7e0a222f7a7f2c33bc69c9e29d17643257e12d11
K       = 047edb575296378df86591adb269caf425b58208a8b21078f644a195ab3096a083dde0d48aa4ca2cfa149ada67311aa3831083dcf273b884e57fc1c8c8b24779c3
path    = gp1/2f6f899532784bae8096c0971f4d0fae62bd15e3f4cc904e365ad3c6664e00ba
address = uyXXoCBdkuguTYGotFafM9YtDKksCgt5fN3dqh3MNWC
d_K     = 30c99167e9261f0dbd156f9c89d2c1d694ee04b614e1382ff298900cf1b5d417
```

**btc:testnet4** (`chain_tag = "btc:testnet4"`, domain 0)

```
h       = b86d030e4348eeac578ee90ab764e764b229895f5871544f02b09ed45ade316c
K       = 04909c3be1b59e9d4be48f0368178b081823ff393622899731b07d48b2c888051c647076e1f0a49497e17ed711469b019722ee7061e8712ef1a49a54885439df2e
path    = gp1/9e340e04fdef1ba9ec470a3ad731c180c3afda81b178fb184f8f296df3785849
address = tb1q4lu05ekh6dnrd50vs27wng2lzfywdn22d9u0hv
d_K     = 514263d8b23a853bb439d83bc32d870bcc9861e1b0e8c29c5831caaef4b2d872
```

**Memo** for `evm:31337`, nonce `44×24`, memo `{"amount":"0.01","asset":"ETH","note":"invoice #42"}`:

```
ct = 4444444444444444444444444444444444444444444444449792b847bb34e6924dbcc99816120d2d9017d9504bd7900f0942620fb25a970a42059ad8c6181df504142227eae4c21279cecbd451568c2e6ba7363c624cb70101f40e7c
```

**Sweep message** for the `evm:31337` target: contract `v1.ghost-paths.testnet`, domain 0,
`expires_block = 123456789`, payload `55×32`, signed with its `d_K`:

```
preimage = 67686f73742d70617468732f76312f737765657076312e67686f73742d70617468732e746573746e65746770312f373565396339393933663535326533633032386636633466623338313236663538376432343361393663613033313033343836623135636331346139313637610000000000075bcd150100205555555555555555555555555555555555555555555555555555555555555555
msg      = d00384e20163563d0df51c54a34621daeaa407d7f822c6c2631a370cc2f5f5a3
k_pub    = f04f6c87828514eae033703a853125d77e14fa3eb8cec8c8e4bf5e4c42cd6965bbc17e6f05276ccca1e74ac37b29a70029968a939aebb5a4c66ecadc9379c11b
sig      = b4d4ad250666f73ea1a75c4735b0bddba4b872321199bca343987585e7fa353c4100656111521553c07b6da8a261ac3064df7352e225ca5e966322b9fc409308
v        = 0
```

**Contract canonical inputs** (same as `contract/src/tests.rs::canonical_vectors`): `d_K = 11×32`,
`k_pub = 4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1`, `path = gp1/b4e84a53cd74a3ed9bf15e1edd92c2a69e567462c58aa8265f89d24c2204e1d7`, contract `v1.ghost-paths.testnet`, `expires_block = 123456789`:

```
domain_id = 0
payload   = 4242424242424242424242424242424242424242424242424242424242424242
digest    = 0f1553c69325651e7dd263e43dab28be665c748b7eee30c165d3ae072ca4c7ae
sig       = 59a99076a539298e344dd846e5d0f0acf038baf06882d309818c467689434c4f10e2d7e3f681517b9d415b0b23643acf5c7d9697efb6d4c6625be81b64319cc3
v         = 0
```
```
domain_id = 1
payload   = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60616263
digest    = d433113a59e0bc5cc384a858379ef10978a08637badff8fdc0e0c94dd9869555
sig       = 2bb41c172241f2926ba10209896c5dcf2de2c248599fd2f3b6b9767f7b85d274026549e31c15672b5eb43ef7f2a8f23e59b48d5c53b32e1d3e5eebbddfd52d6d
v         = 0
```

**MPC derivation** (recorded from `v1.signer-prod.testnet` `derived_public_key`, 2026-11-09):

```
predecessor = v1.ghost-paths.testnet, path = gp1/abab…ab (ab×32)
domain 0 → secp256k1:BSjeAgh1CBr9Cm196WNVyNpsFTfWRAGqeNDtZCfswfuk6XcQL2zqpVx7efXQDUmGBRpwU3svvnfXvQs1MGrHLwv
           evm 0x5c7dad9d2e0B89E71F3ceB876c270AB1013CcAb9, btc:testnet4 tb1qshvntagprslsmtj9306x4nlwgkwq54fl8xucmu
domain 1 → ed25519:8f6Pmk8tuN6sFbMXoSF1FFz2wGmZkk1q72PMdw7zpUvm  (= Solana address)
```

## 9. Differences from ERC-5564 and from the first plan

- ERC-5564 scheme 1 uses secp256k1 ECDH for the viewing key. We use **X25519** (`P_view`) and
  **HKDF** with labels instead of a bare `keccak(S)`. The spend side stays secp256k1 (`K = P_spend + h·G`).
- The stealth key `K` is not the on-chain address. It is the **authorisation key** for the Ghost Paths
  contract, and the address comes from MPC derivation of `(contract, hash(K))`. This is how one secp256k1
  spend key serves ed25519 chains (Solana) as well.
- The `chain_tag` is bound into `h`, and announcements live in a NEAR contract instead of an ERC-5564 announcer.
- The view tag is the first byte of a labelled `sha256(S)`, as in ERC-5564's `hash(S)[0]`.
- Sweep message: PLAN §1.7's layout is kept as-is. An early W1 draft added length prefixes; it was
  dropped to match the contract (see SWEEP-MESSAGE.md, which explains why the layout is injective).
