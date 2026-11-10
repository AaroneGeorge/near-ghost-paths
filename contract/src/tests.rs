//! Unit tests (mocked blockchain). End-to-end tests with a mock signer: tests/integration.rs.

use super::*;
use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{Gas, NearToken, env, testing_env};
use sha2::{Digest, Sha256};

const CONTRACT: &str = "v1.ghost-paths.testnet";

fn ctx(pred: &str, deposit: u128, height: u64) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300))
            .block_height(height)
            .build()
    );
}

fn contract() -> GhostPaths {
    ctx("deployer.testnet", 0, 100);
    GhostPaths::new("v1.signer-prod.testnet".parse().unwrap())
}

const MILLI: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR

// ---------- sweep message layout (canonical vector, mirrored in SWEEP-MESSAGE.md) ----------

pub(crate) fn vector_key() -> SigningKey {
    SigningKey::from_slice(&[0x11u8; 32]).unwrap()
}

pub(crate) fn k_unc(sk: &SigningKey) -> Vec<u8> {
    sk.verifying_key().to_encoded_point(false).as_bytes()[1..].to_vec()
}

pub(crate) fn path_of(k: &[u8]) -> String {
    format!("gp1/{}", hex::encode(Sha256::digest(k)))
}

#[test]
fn preimage_layout_matches_spec_by_hand() {
    let payloads = vec![vec![0xabu8; 32]];
    let path = "gp1/".to_string() + &"0".repeat(64);
    let got = sweep_preimage(CONTRACT, &path, 0, 0x0102030405060708, &payloads);
    let mut want = b"ghost-paths/v1/sweep".to_vec();
    want.extend_from_slice(b"v1.ghost-paths.testnet");
    want.extend_from_slice(path.as_bytes());
    want.extend_from_slice(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 1, 0, 32]);
    want.extend_from_slice(&[0xab; 32]);
    assert_eq!(got, want);
    assert_eq!(got.len(), 20 + 22 + 68 + 1 + 8 + 1 + 2 + 32);
}

#[test]
fn canonical_vectors() {
    // Deterministic vectors for W1 (packages/sdk sweepMessage/signSweep). Printed with --nocapture.
    ctx("relayer.testnet", 1, 100);
    let sk = vector_key();
    let k = k_unc(&sk);
    let path = path_of(&k);
    for (domain, payload) in [
        (0u8, vec![0x42u8; 32]),
        (1u8, (0u8..=99).collect::<Vec<u8>>()),
    ] {
        let pre = sweep_preimage(
            CONTRACT,
            &path,
            domain,
            123_456_789,
            std::slice::from_ref(&payload),
        );
        let digest = sweep_digest_bytes(
            CONTRACT,
            &path,
            domain,
            123_456_789,
            std::slice::from_ref(&payload),
        );
        assert_eq!(digest.to_vec(), Sha256::digest(&pre).to_vec());
        let (sig, rec): (Signature, RecoveryId) = sk.sign_prehash_recoverable(&digest).unwrap();
        // RFC6979 is deterministic, so these are stable; k256 normalises to low-s.
        assert!(sig.normalize_s().is_none());
        println!(
            "domain={domain}\n d_K=1111..11\n k_pub={}\n path={path}\n payload={}\n preimage={}\n digest={}\n sig={}\n v={}",
            hex::encode(&k),
            hex::encode(&payload),
            hex::encode(&pre),
            hex::encode(digest),
            hex::encode(sig.to_bytes()),
            rec.to_byte()
        );
        let rec_k = env::ecrecover(&digest, &sig.to_bytes(), rec.to_byte(), true).unwrap();
        assert_eq!(rec_k.to_vec(), k);
    }
}

// ---------- registry ----------

fn meta_hex() -> (String, String) {
    let spend = vector_key()
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .to_vec();
    (hex::encode(spend), hex::encode([7u8; 32]))
}

#[test]
fn register_and_get_meta() {
    let mut c = contract();
    let (s, v) = meta_hex();
    ctx("bob.testnet", 10 * MILLI, 100);
    c.register(s.to_uppercase(), v.clone(), "contract".into());
    let m = c.get_meta("bob.testnet".parse().unwrap()).unwrap();
    assert_eq!(
        m,
        Meta {
            v: 1,
            mode: "contract".into(),
            spend_pub: s.clone(),
            view_pub: v.clone()
        }
    );
    let log = &get_logs()[0];
    assert!(
        log.starts_with("EVENT_JSON:{\"standard\":\"ghost-paths\"")
            && log.contains("\"event\":\"register\""),
        "{log}"
    );
    // overwrite costs no new storage; zero deposit is fine
    ctx("bob.testnet", 0, 101);
    c.register(s, v, "account".into());
    assert_eq!(
        c.get_meta("bob.testnet".parse().unwrap()).unwrap().mode,
        "account"
    );
    assert!(c.get_meta("carol.testnet".parse().unwrap()).is_none());
}

#[test]
#[should_panic(expected = "insufficient_deposit")]
fn register_needs_storage_deposit() {
    let mut c = contract();
    let (s, v) = meta_hex();
    ctx("bob.testnet", 0, 100);
    c.register(s, v, "contract".into());
}

#[test]
#[should_panic(expected = "spend_pub must be compressed")]
fn register_rejects_uncompressed_prefix() {
    let mut c = contract();
    let (_, v) = meta_hex();
    ctx("bob.testnet", 10 * MILLI, 100);
    c.register(format!("04{}", "11".repeat(32)), v, "contract".into());
}

#[test]
#[should_panic(expected = "mode must be")]
fn register_rejects_bad_mode() {
    let mut c = contract();
    let (s, v) = meta_hex();
    ctx("bob.testnet", 10 * MILLI, 100);
    c.register(s, v, "stealth".into());
}

// ---------- announcements ----------

#[test]
fn announce_and_paginate() {
    let mut c = contract();
    for i in 0..5u8 {
        ctx("alice.testnet", 10 * MILLI, 200 + i as u64);
        let idx = c.announce(
            "evm:31337".into(),
            hex::encode([i; 32]),
            i,
            if i == 2 {
                Some("bWVtbw==".into())
            } else {
                None
            },
        );
        assert_eq!(idx, i as u64);
    }
    let log = &get_logs()[0];
    assert!(
        log.contains("\"event\":\"announce\"") && log.contains("\"standard\":\"ghost-paths\""),
        "{log}"
    );
    assert_eq!(c.announcement_count(), 5);
    let page = c.get_announcements(1, 2);
    assert_eq!(page.iter().map(|a| a.idx).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(page[1].ct.as_deref(), Some("bWVtbw=="));
    assert_eq!(page[0].eph, hex::encode([1u8; 32]));
    assert_eq!(page[0].block_height, 201);
    assert_eq!(page[0].announcer.as_str(), "alice.testnet");
    assert_eq!(c.get_announcements(4, 100).len(), 1);
    assert!(c.get_announcements(5, 10).is_empty());
    assert!(c.get_announcements(u64::MAX, u32::MAX).is_empty());
}

#[test]
fn announce_limit_clamped_to_200() {
    let mut c = contract();
    for i in 0..205u32 {
        ctx("alice.testnet", 10 * MILLI, 200);
        c.announce(
            "sol:local".into(),
            hex::encode([(i % 256) as u8; 32]),
            0,
            None,
        );
    }
    assert_eq!(c.get_announcements(0, 1000).len(), 200);
}

#[test]
#[should_panic(expected = "insufficient_deposit")]
fn announce_needs_storage_deposit() {
    let mut c = contract();
    ctx("alice.testnet", 1, 200);
    c.announce("evm:1".into(), hex::encode([1u8; 32]), 0, None);
}

#[test]
#[should_panic(expected = "chain must match")]
fn announce_rejects_bad_chain() {
    let mut c = contract();
    ctx("alice.testnet", 10 * MILLI, 200);
    c.announce("EVM 1".into(), hex::encode([1u8; 32]), 0, None);
}

#[test]
#[should_panic(expected = "ct must be")]
fn announce_rejects_long_memo() {
    let mut c = contract();
    ctx("alice.testnet", 100 * MILLI, 200);
    c.announce(
        "evm:1".into(),
        hex::encode([1u8; 32]),
        0,
        Some("a".repeat(1025)),
    );
}

// ---------- sweep ----------

struct Sweep {
    path: String,
    domain: u8,
    payloads: Vec<String>,
    expires: u64,
    k_pub: String,
    sig: String,
    v: u8,
}

fn signed(sk: &SigningKey, domain: u8, payload: Vec<u8>, expires: u64) -> Sweep {
    let k = k_unc(sk);
    let path = path_of(&k);
    let digest = sweep_digest_bytes(
        CONTRACT,
        &path,
        domain,
        expires,
        std::slice::from_ref(&payload),
    );
    let (sig, rec) = sk.sign_prehash_recoverable(&digest).unwrap();
    Sweep {
        path,
        domain,
        payloads: vec![hex::encode(payload)],
        expires,
        k_pub: hex::encode(k),
        sig: hex::encode(sig.to_bytes()),
        v: rec.to_byte(),
    }
}

fn call(c: &mut GhostPaths, s: Sweep) {
    let _ = c.sweep(s.path, s.domain, s.payloads, s.expires, s.k_pub, s.sig, s.v);
}

#[test]
fn sweep_good_signature_ecdsa_and_eddsa() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    call(&mut c, signed(&vector_key(), 0, vec![0x42; 32], 150));
    assert!(get_logs()[0].contains("\"event\":\"sweep\""));
    ctx("relayer.testnet", 1, 150); // expiry is inclusive
    call(&mut c, signed(&vector_key(), 1, vec![9; 700], 150));
}

#[test]
#[should_panic(expected = "bad_signature")]
fn sweep_rejects_signature_by_other_key() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    let mut s = signed(
        &SigningKey::from_slice(&[0x22; 32]).unwrap(),
        0,
        vec![0x42; 32],
        150,
    );
    let k = k_unc(&vector_key());
    s.path = path_of(&k);
    s.k_pub = hex::encode(k);
    call(&mut c, s);
}

#[test]
#[should_panic(expected = "bad_signature")]
fn sweep_rejects_tampered_payload() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    let mut s = signed(&vector_key(), 0, vec![0x42; 32], 150);
    s.payloads = vec![hex::encode([0x43u8; 32])];
    call(&mut c, s);
}

#[test]
#[should_panic(expected = "bad_signature")]
fn sweep_rejects_tampered_expiry() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    let mut s = signed(&vector_key(), 0, vec![0x42; 32], 150);
    s.expires = 151;
    call(&mut c, s);
}

#[test]
#[should_panic(expected = "bad_signature")]
fn sweep_rejects_high_s() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    let mut s = signed(&vector_key(), 0, vec![0x42; 32], 150);
    let sig = Signature::from_slice(&hex::decode(&s.sig).unwrap()).unwrap();
    let (r, lo_s) = sig.split_scalars();
    let high = Signature::from_scalars(r, -*lo_s).unwrap();
    s.sig = hex::encode(high.to_bytes());
    s.v ^= 1;
    call(&mut c, s);
}

#[test]
#[should_panic(expected = "expired")]
fn sweep_rejects_expired() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 151);
    call(&mut c, signed(&vector_key(), 0, vec![0x42; 32], 150));
}

#[test]
#[should_panic(expected = "path_mismatch")]
fn sweep_rejects_wrong_k_pub() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    let mut s = signed(&vector_key(), 0, vec![0x42; 32], 150);
    s.k_pub = hex::encode(k_unc(&SigningKey::from_slice(&[0x22; 32]).unwrap()));
    call(&mut c, s);
}

#[test]
#[should_panic(expected = "insufficient_deposit")]
fn sweep_requires_one_yocto() {
    let mut c = contract();
    ctx("relayer.testnet", 0, 100);
    call(&mut c, signed(&vector_key(), 0, vec![0x42; 32], 150));
}

#[test]
#[should_panic(expected = "v must be")]
fn sweep_rejects_v_27() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    let mut s = signed(&vector_key(), 0, vec![0x42; 32], 150);
    s.v = 27;
    call(&mut c, s);
}

#[test]
#[should_panic(expected = "domain_id must be")]
fn sweep_rejects_domain_2() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    call(&mut c, signed(&vector_key(), 2, vec![0x42; 32], 150));
}

#[test]
#[should_panic(expected = "ECDSA payload >= n")]
fn sweep_rejects_ecdsa_payload_over_order() {
    let mut c = contract();
    ctx("relayer.testnet", 1, 100);
    call(&mut c, signed(&vector_key(), 0, vec![0xff; 32], 150));
}

#[test]
#[should_panic(expected = "exactly one payload")]
fn sweep_rejects_two_payloads() {
    let mut c = contract();
    ctx("relayer.testnet", 2, 100);
    let mut s = signed(&vector_key(), 0, vec![0x42; 32], 150);
    s.payloads.push(s.payloads[0].clone());
    call(&mut c, s);
}

#[test]
fn sweep_digest_view_matches() {
    let c = contract();
    let sk = vector_key();
    let path = path_of(&k_unc(&sk));
    let d = c.sweep_digest(path.clone(), 0, vec![hex::encode([0x42u8; 32])], 150);
    assert_eq!(
        d,
        hex::encode(sweep_digest_bytes(
            CONTRACT,
            &path,
            0,
            150,
            &[vec![0x42; 32]]
        ))
    );
}
