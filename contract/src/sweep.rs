//! Sweep gateway (Mode B, PLAN.md 1.7). Byte layout: contract/SWEEP-MESSAGE.md.

use near_sdk::serde_json::{self, json};
use near_sdk::{Gas, GasWeight, NearToken, Promise, env, near, require};

use crate::util::{hex_any, hex_exact, refund};
use crate::{GhostPaths, GhostPathsExt, events};

/// Domain-separation prefix of the sweep message (20 ASCII bytes, no terminator).
pub const SWEEP_TAG: &[u8] = b"ghost-paths/v1/sweep";
/// MPC limit for an EdDSA payload (a whole Solana message).
pub const EDDSA_MAX_PAYLOAD: usize = 1232;
/// Static gas attached to `sign`; all unused gas of `sweep` is added on top (weight 1).
/// The MPC contract requires 15 Tgas (`sign_call_gas_attachment_requirement_tera_gas`).
pub const SIGN_GAS: Gas = Gas::from_tgas(30);
/// Minimum prepaid gas for `sweep` (verification + SIGN_GAS + margin). Clients should attach 300 Tgas.
pub const MIN_SWEEP_GAS: Gas = Gas::from_tgas(50);
/// secp256k1 group order n, big-endian. The MPC rejects ECDSA payloads >= n.
const SECP256K1_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// The exact bytes that are SHA-256 hashed into the sweep digest:
/// `"ghost-paths/v1/sweep" || contract_id || path || u8(domain_id) || u64be(expires_block)
///  || u8(n) || for each payload: u16be(len) || payload`.
pub fn sweep_preimage(
    contract_id: &str,
    path: &str,
    domain_id: u8,
    expires_block: u64,
    payloads: &[Vec<u8>],
) -> Vec<u8> {
    let mut m = Vec::with_capacity(128 + payloads.iter().map(|p| p.len() + 2).sum::<usize>());
    m.extend_from_slice(SWEEP_TAG);
    m.extend_from_slice(contract_id.as_bytes());
    m.extend_from_slice(path.as_bytes());
    m.push(domain_id);
    m.extend_from_slice(&expires_block.to_be_bytes());
    m.push(u8::try_from(payloads.len()).expect("too many payloads"));
    for p in payloads {
        m.extend_from_slice(
            &u16::try_from(p.len())
                .expect("payload too long")
                .to_be_bytes(),
        );
        m.extend_from_slice(p);
    }
    m
}

/// SHA-256 of `sweep_preimage(...)`: the 32-byte digest `K` signs with ECDSA (no further hashing).
pub fn sweep_digest_bytes(
    contract_id: &str,
    path: &str,
    domain_id: u8,
    expires_block: u64,
    payloads: &[Vec<u8>],
) -> [u8; 32] {
    env::sha256_array(sweep_preimage(
        contract_id,
        path,
        domain_id,
        expires_block,
        payloads,
    ))
}

fn decode_payloads(domain_id: u8, payloads: &[String]) -> Vec<Vec<u8>> {
    require!(
        domain_id <= 1,
        "invalid_argument: domain_id must be 0 (secp256k1) or 1 (ed25519)"
    );
    require!(
        payloads.len() == 1,
        "invalid_argument: exactly one payload per sweep (v1)"
    );
    payloads
        .iter()
        .map(|p| {
            if domain_id == 0 {
                let b = hex_exact(p, 32, "payload");
                require!(
                    b.as_slice() < SECP256K1_N.as_slice(),
                    "invalid_argument: ECDSA payload >= n"
                );
                b
            } else {
                let b = hex_any(p, "payload");
                require!(
                    !b.is_empty() && b.len() <= EDDSA_MAX_PAYLOAD,
                    "invalid_argument: EdDSA payload must be 1..=1232 bytes"
                );
                b
            }
        })
        .collect()
}

#[near]
impl GhostPaths {
    /// Ask the MPC signer to sign `payloads[0]` for `derive(this_contract, path)`, authorised by an
    /// ECDSA signature `(sig, v)` over `sweep_digest(...)` by the stealth key `k_pub`.
    /// Anyone may submit (a relayer); the signature binds contract, path, domain, expiry and
    /// payload, so the submitter cannot change what gets signed. Attach >= 1 yoctoNEAR (excess
    /// refunded) and 300 Tgas. Returns the MPC `sign` result unchanged
    /// (`{"scheme":"Secp256k1",big_r,s,recovery_id}` or `{"scheme":"Ed25519",signature}`).
    #[payable]
    pub fn sweep(
        &mut self,
        path: String,
        domain_id: u8,
        payloads: Vec<String>,
        expires_block: u64,
        k_pub: String,
        sig: String,
        v: u8,
    ) -> Promise {
        require!(env::block_height() <= expires_block, "expired");
        require!(
            env::prepaid_gas() >= MIN_SWEEP_GAS,
            format!(
                "insufficient_gas: attach at least {} Tgas (300 recommended)",
                MIN_SWEEP_GAS.as_tgas()
            )
        );
        let deposit = env::attached_deposit();
        require!(
            deposit >= NearToken::from_yoctonear(1),
            "insufficient_deposit: attach 1 yoctoNEAR for the MPC sign fee"
        );
        let payload_bytes = decode_payloads(domain_id, &payloads);

        let k = hex_exact(&k_pub, 64, "k_pub");
        require!(
            path == format!("gp1/{}", hex::encode(env::sha256_array(&k))),
            "path_mismatch: path must be gp1/ + lowercase hex(sha256(k_pub))"
        );
        let sig = hex_exact(&sig, 64, "sig");
        require!(
            v <= 3,
            "invalid_argument: v must be the recovery id 0..=3 (not 27/28)"
        );

        let me = env::current_account_id();
        let digest =
            sweep_digest_bytes(me.as_str(), &path, domain_id, expires_block, &payload_bytes);
        // malleability_flag = true: high-s signatures are rejected (noble signs low-s by default).
        let recovered = env::ecrecover(&digest, &sig, v, true);
        require!(
            recovered.map(|r| r[..] == k[..]).unwrap_or(false),
            "bad_signature"
        );

        refund(deposit.saturating_sub(NearToken::from_yoctonear(1)));
        events::emit("sweep", json!({ "path": path, "domain_id": domain_id }));

        let payload_hex = hex::encode(&payload_bytes[0]);
        let payload_v2 = if domain_id == 0 {
            json!({ "Ecdsa": payload_hex })
        } else {
            json!({ "Eddsa": payload_hex })
        };
        let args = json!({ "request": { "payload_v2": payload_v2, "path": path, "domain_id": domain_id } });
        Promise::new(self.signer_id.clone()).function_call_weight(
            "sign",
            serde_json::to_vec(&args).unwrap(),
            NearToken::from_yoctonear(1),
            SIGN_GAS,
            GasWeight(1),
        )
    }

    /// Helper for clients: the hex digest `sweep` expects `K` to sign (same inputs, no auth).
    pub fn sweep_digest(
        &self,
        path: String,
        domain_id: u8,
        payloads: Vec<String>,
        expires_block: u64,
    ) -> String {
        let payload_bytes = decode_payloads(domain_id, &payloads);
        let me = env::current_account_id();
        hex::encode(sweep_digest_bytes(
            me.as_str(),
            &path,
            domain_id,
            expires_block,
            &payload_bytes,
        ))
    }
}
