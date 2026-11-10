# Ghost Paths contract ABI (v1)

Deployed: `v1.ghost-paths.testnet` (signer `v1.signer-prod.testnet`). Machine-readable ABI:
`res/ghost_paths_abi.json` (also embedded in the wasm, `cargo near abi`). Changes need W1 + W3 ack.
Panics start with a short code: `invalid_argument:`, `insufficient_deposit:`, `insufficient_gas:`,
`expired`, `path_mismatch`, `bad_signature`.

| Method | Kind | Args (JSON) | Returns | Deposit / gas |
|---|---|---|---|---|
| `new` | init | `signer_id: AccountId` | — | once, at deploy |
| `signer_id` | view | — | `AccountId` | — |
| `register` | call, payable | `spend_pub: hex33` (compressed, 02/03), `view_pub: hex32` (X25519), `mode: "contract"\|"account"` | — | 126 bytes = 0.00126 NEAR first time (attach 0.002; excess refunded); overwrite free. ~2.5 Tgas |
| `get_meta` | view | `account_id` | `{v:1, mode, spend_pub, view_pub} \| null` | — |
| `announce` | call, payable | `chain: [a-z0-9:-]{1,32}`, `eph: hex32`, `tag: u8`, `ct?: printable ASCII 1..=1024` | `u64` idx | 127 bytes + 1 per memo char (0.00127 NEAR + 0.00001/char; attach 0.003 or more, excess refunded). ~2.5 Tgas |
| `announcement_count` | view | — | `u64` | — |
| `get_announcements` | view | `from: u64`, `limit: u32` (clamped to 200) | `[{idx, chain, eph, tag, ct, block_height, timestamp_ms, announcer}]` | — |
| `sweep` | call, payable | `path`, `domain_id: 0\|1`, `payloads: [hex]` (exactly 1), `expires_block: u64`, `k_pub: hex64`, `sig: hex64`, `v: 0..=3` | the MPC `sign` result: `{"scheme":"Secp256k1","big_r":{"affine_point":hex33},"s":{"scalar":hex32},"recovery_id":0\|1}` or `{"scheme":"Ed25519","signature":[64 numbers]}` | ≥ 1 yocto (exactly 1 is forwarded, rest refunded); ≥ 50 Tgas, attach 300; burns ~11 Tgas end-to-end on testnet; MPC latency ~13 s |
| `sweep_digest` | view | `path`, `domain_id`, `payloads`, `expires_block` | hex32 digest `K` must sign | — |
| `contract_source_metadata` | view | — | NEP-330 metadata | — |

Byte layout of the sweep digest: `SWEEP-MESSAGE.md`.

Events (NEP-297, `EVENT_JSON:` logs, `standard: "ghost-paths"`, `version: "1.0.0"`):
- `announce` — `data: [{idx, chain, eph, tag}]` (no recipient field)
- `register` — `data: [{account_id, mode}]`
- `sweep` — `data: [{path, domain_id}]` (both already public in the transaction arguments)
