//! Shared helpers for integration and live tests: wasm builds and stealth-key signing.
#![allow(dead_code)]

use k256::ecdsa::SigningKey;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

pub const SWEEP_TAG: &[u8] = b"ghost-paths/v1/sweep";

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn cargo_near(dir: PathBuf, extra: &[&str]) {
    let status = Command::new("cargo")
        .args(["near", "build", "non-reproducible-wasm"])
        .args(extra)
        .current_dir(dir)
        .status()
        .expect("cargo near not installed (cargo install cargo-near)");
    assert!(status.success(), "cargo near build failed");
}

/// Build both wasms once per test binary (skip with GHOST_SKIP_WASM_BUILD=1 to use existing ones).
fn build_all() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        if std::env::var("GHOST_SKIP_WASM_BUILD").is_err() {
            cargo_near(root(), &[]);
            cargo_near(root().join("tests/mock_signer"), &["--no-abi"]);
        }
    });
}

pub fn ghost_wasm() -> Vec<u8> {
    build_all();
    std::fs::read(root().join("target/near/ghost_paths.wasm")).unwrap()
}

pub fn mock_signer_wasm() -> Vec<u8> {
    build_all();
    std::fs::read(root().join("target/near/mock_signer/mock_signer.wasm")).unwrap()
}

/// 64-byte x||y of the stealth key.
pub fn k_unc(sk: &SigningKey) -> Vec<u8> {
    sk.verifying_key().to_encoded_point(false).as_bytes()[1..].to_vec()
}

pub fn path_of(k: &[u8]) -> String {
    format!("gp1/{}", hex::encode(Sha256::digest(k)))
}

/// Independent re-implementation of contract/SWEEP-MESSAGE.md (does not call the contract code).
pub fn digest(
    contract: &str,
    path: &str,
    domain: u8,
    expires: u64,
    payloads: &[Vec<u8>],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(SWEEP_TAG);
    h.update(contract.as_bytes());
    h.update(path.as_bytes());
    h.update([domain]);
    h.update(expires.to_be_bytes());
    h.update([payloads.len() as u8]);
    for p in payloads {
        h.update((p.len() as u16).to_be_bytes());
        h.update(p);
    }
    h.finalize().into()
}

/// `sweep` JSON args signed by `sk`.
pub fn sweep_args(
    sk: &SigningKey,
    contract: &str,
    domain: u8,
    payload: &[u8],
    expires: u64,
) -> serde_json::Value {
    let k = k_unc(sk);
    let path = path_of(&k);
    let d = digest(contract, &path, domain, expires, &[payload.to_vec()]);
    let (sig, rec) = sk.sign_prehash_recoverable(&d).unwrap();
    serde_json::json!({
        "path": path, "domain_id": domain, "payloads": [hex::encode(payload)],
        "expires_block": expires, "k_pub": hex::encode(&k),
        "sig": hex::encode(sig.to_bytes()), "v": rec.to_byte(),
    })
}
