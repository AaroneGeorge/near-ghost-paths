//! LIVE check (opt-in: `LIVE=1 cargo test --test live_testnet -- --nocapture`).
//! Calls `sweep` on the deployed Ghost Paths contract against the real `v1.signer-prod.testnet`
//! (one ECDSA, one EdDSA request, ~15-30 s each) and checks that the MPC signature verifies under
//! `derive(contract, path)`: computed locally from the MPC root key (secp256k1) and fetched with the
//! signer's `derived_public_key` view (both domains). Writes contract/fixtures/live-sweep-testnet.json.
//!
//! Env: GHOST_CONTRACT (default v1.ghost-paths.testnet), GHOST_SIGNER (v1.signer-prod.testnet),
//! GHOST_CALLER_KEY (default ../.secrets/near/ghost-paths.testnet.json, near-cli key-file format),
//! NEAR_RPC (default https://rpc.testnet.near.org).

mod common;

use common::*;
use ed25519_dalek::{Signature as EdSig, Verifier, VerifyingKey as EdKey};
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use k256::elliptic_curve::PrimeField;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{AffinePoint, ProjectivePoint, Scalar};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Worker, network::Testnet};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256, Sha3_256};
use std::time::Instant;

fn var(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn b58_key(s: &str, prefix: &str) -> Vec<u8> {
    bs58::decode(s.strip_prefix(prefix).expect("key prefix"))
        .into_vec()
        .unwrap()
}

fn secp_point(xy: &[u8]) -> AffinePoint {
    let mut sec1 = vec![4u8];
    sec1.extend_from_slice(xy);
    *VerifyingKey::from_sec1_bytes(&sec1).unwrap().as_affine()
}

fn uncompressed(p: &AffinePoint) -> Vec<u8> {
    p.to_encoded_point(false).as_bytes()[1..].to_vec()
}

/// K = Root + eps·G, eps = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + pred + "," + path)
fn derive_secp_local(root_xy: &[u8], predecessor: &str, path: &str) -> Vec<u8> {
    let eps: [u8; 32] = Sha3_256::digest(format!(
        "near-mpc-recovery v0.1.0 epsilon derivation:{predecessor},{path}"
    ))
    .into();
    let eps = Scalar::from_repr(eps.into()).unwrap();
    let k = ProjectivePoint::GENERATOR * eps + ProjectivePoint::from(secp_point(root_xy));
    uncompressed(&k.to_affine())
}

async fn view(
    w: &Worker<Testnet>,
    id: &AccountId,
    method: &str,
    args: Value,
) -> anyhow::Result<Value> {
    Ok(w.view(id, method).args_json(args).await?.json()?)
}

struct Outcome {
    result: Value,
    tx_hash: String,
    total_tgas: f64,
    per_receipt: Vec<Value>,
    latency_s: f64,
}

async fn sweep(caller: &Account, ghost: &AccountId, args: &Value) -> anyhow::Result<Outcome> {
    let t = Instant::now();
    let status = caller
        .call(ghost, "sweep")
        .args_json(args)
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    let tx_hash = status.hash().to_string();
    println!("  submitted {tx_hash}, waiting for the MPC...");
    let r = status.await?;
    let latency_s = t.elapsed().as_secs_f64();
    let per_receipt = r
        .outcomes()
        .iter()
        .map(|o| json!({ "executor": o.executor_id, "tgas": o.gas_burnt.as_gas() as f64 / 1e12 }))
        .collect();
    let total_tgas = r.total_gas_burnt.as_gas() as f64 / 1e12;
    let result: Value = r
        .into_result()
        .map_err(|e| anyhow::anyhow!("sweep failed: {e:?}"))?
        .json()?;
    Ok(Outcome {
        result,
        tx_hash,
        total_tgas,
        per_receipt,
        latency_s,
    })
}

#[tokio::test]
async fn live_sweep_recovers_to_derived_key() -> anyhow::Result<()> {
    if std::env::var("LIVE").as_deref() != Ok("1") {
        println!("skipped: set LIVE=1 to call the real testnet MPC");
        return Ok(());
    }
    let ghost: AccountId = var("GHOST_CONTRACT", "v1.ghost-paths.testnet").parse()?;
    let signer: AccountId = var("GHOST_SIGNER", "v1.signer-prod.testnet").parse()?;
    let key_file = var(
        "GHOST_CALLER_KEY",
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../.secrets/near/ghost-paths.testnet.json"
        ),
    );
    let worker = near_workspaces::testnet()
        .rpc_addr(&var("NEAR_RPC", "https://rpc.testnet.near.org"))
        .await?;
    let caller = Account::from_file(&key_file, &worker)?;
    println!(
        "caller (relayer role) {}, contract {ghost}, signer {signer}",
        caller.id()
    );

    let on_chain_signer: String = view(&worker, &ghost, "signer_id", json!({}))
        .await?
        .as_str()
        .unwrap()
        .into();
    assert_eq!(on_chain_signer, signer.as_str());
    let root0 = view(&worker, &signer, "public_key", json!({ "domain_id": 0 })).await?;
    let root1 = view(&worker, &signer, "public_key", json!({ "domain_id": 1 })).await?;
    let root0 = root0.as_str().unwrap().to_string();
    let root1 = root1.as_str().unwrap().to_string();
    let height = worker.view_block().await?.height();

    // fresh stealth key per run
    let sk = SigningKey::random(&mut rand::rngs::OsRng);
    let k = k_unc(&sk);
    let path = path_of(&k);
    println!("K = {}\npath = {path}", hex::encode(&k));
    let mut cases = vec![];

    // ---- domain 0: ECDSA (EVM/BTC) ----
    let payload: [u8; 32] = rand::random::<[u8; 32]>().map(|b| b & 0x7f); // < n
    let args = sweep_args(&sk, ghost.as_str(), 0, &payload, height + 200);
    println!("ECDSA sweep...");
    let o = sweep(&caller, &ghost, &args).await?;
    println!(
        "  result {} in {:.1} s, {:.2} Tgas burnt",
        o.result, o.latency_s, o.total_tgas
    );
    assert_eq!(o.result["scheme"], "Secp256k1");
    let big_r = hex::decode(o.result["big_r"]["affine_point"].as_str().unwrap())?;
    let s = hex::decode(o.result["s"]["scalar"].as_str().unwrap())?;
    let sig = Signature::from_scalars(
        <[u8; 32]>::try_from(&big_r[1..33])?,
        <[u8; 32]>::try_from(&s[..])?,
    )?;
    let recid = RecoveryId::from_byte(o.result["recovery_id"].as_u64().unwrap() as u8).unwrap();
    let recovered =
        uncompressed(VerifyingKey::recover_from_prehash(&payload, &sig, recid)?.as_affine());
    let derived_rpc = b58_key(
        view(
            &worker,
            &signer,
            "derived_public_key",
            json!({ "path": path, "predecessor": ghost, "domain_id": 0 }),
        )
        .await?
        .as_str()
        .unwrap(),
        "secp256k1:",
    );
    let derived_local = derive_secp_local(&b58_key(&root0, "secp256k1:"), ghost.as_str(), &path);
    let derived_caller =
        derive_secp_local(&b58_key(&root0, "secp256k1:"), caller.id().as_str(), &path);
    assert_eq!(
        derived_local, derived_rpc,
        "local derivation != derived_public_key view"
    );
    assert_eq!(
        recovered, derived_rpc,
        "MPC signature does not recover to derive(contract, path)"
    );
    assert_ne!(
        recovered, derived_caller,
        "signature keyed on the caller, not the contract"
    );
    let evm = format!("0x{}", hex::encode(&Keccak256::digest(&derived_rpc)[12..]));
    println!(
        "  OK: recovered == derive({ghost}, path) (local and RPC); != derive(caller, path). EVM address {evm}"
    );
    cases.push(json!({
        "predecessor": ghost, "predecessor_type": "contract (Ghost Paths, via sweep)", "caller": caller.id(),
        "path": path, "domain_id": 0, "derived_pub": format!("secp256k1:{}", bs58::encode(&derived_rpc).into_string()),
        "address": evm, "payload": hex::encode(payload), "signature": o.result, "recovered_ok": true,
        "sweep_args": args, "tx_hash": o.tx_hash, "gas_burnt_tgas": o.total_tgas, "receipts": o.per_receipt,
        "latency_s": (o.latency_s * 10.0).round() / 10.0,
    }));

    // ---- domain 1: EdDSA (Solana) with a Solana-message-sized payload ----
    let msg: Vec<u8> = (0..215u32).map(|_| rand::random::<u8>()).collect();
    let args = sweep_args(&sk, ghost.as_str(), 1, &msg, height + 200);
    println!("EdDSA sweep ({} byte payload)...", msg.len());
    let o = sweep(&caller, &ghost, &args).await?;
    println!(
        "  result {} in {:.1} s, {:.2} Tgas burnt",
        o.result, o.latency_s, o.total_tgas
    );
    assert_eq!(o.result["scheme"], "Ed25519");
    let sig_bytes: Vec<u8> = o.result["signature"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect();
    let derived_ed = b58_key(
        view(
            &worker,
            &signer,
            "derived_public_key",
            json!({ "path": path, "predecessor": ghost, "domain_id": 1 }),
        )
        .await?
        .as_str()
        .unwrap(),
        "ed25519:",
    );
    let vk = EdKey::from_bytes(&derived_ed[..].try_into()?)?;
    vk.verify(&msg, &EdSig::from_slice(&sig_bytes)?)
        .map_err(|e| anyhow::anyhow!("ed25519 verify failed: {e}"))?;
    let sol = bs58::encode(&derived_ed).into_string();
    println!(
        "  OK: ed25519 signature verifies under derive({ghost}, path, domain 1) = Solana address {sol}"
    );
    cases.push(json!({
        "predecessor": ghost, "predecessor_type": "contract (Ghost Paths, via sweep)", "caller": caller.id(),
        "path": path, "domain_id": 1, "derived_pub": format!("ed25519:{sol}"), "address": sol,
        "payload": hex::encode(&msg), "signature": o.result, "recovered_ok": true,
        "sweep_args": args, "tx_hash": o.tx_hash, "gas_burnt_tgas": o.total_tgas, "receipts": o.per_receipt,
        "latency_s": (o.latency_s * 10.0).round() / 10.0,
    }));

    let fixture = json!({
        "network": "testnet", "signer": signer, "contract": ghost,
        "root_keys": { "0": root0, "1": root1 },
        "recorded_at_block": height, "k_pub": hex::encode(&k),
        "note": "Recorded by contract/tests/live_testnet.rs. The stealth private key is not stored.",
        "cases": cases,
    });
    let out = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/live-sweep-testnet.json"
    );
    std::fs::write(out, serde_json::to_string_pretty(&fixture)? + "\n")?;
    println!("fixture written: {out}");
    Ok(())
}
