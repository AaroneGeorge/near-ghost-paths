//! near-workspaces sandbox tests: the real wasm against a mock MPC signer (tests/mock_signer).
//! Prints a gas report (run with `-- --nocapture`).

mod common;

use common::*;
use k256::ecdsa::SigningKey;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};

struct Env {
    worker: Worker<Sandbox>,
    ghost: Contract,
    signer: Contract,
    alice: Account,
    relayer: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await
                .map(|r| r.into_result().unwrap())
        }
    };
    let signer = sub("signer", 10)
        .await?
        .deploy(&mock_signer_wasm())
        .await?
        .into_result()?;
    signer.call("new").transact().await?.into_result()?;
    let ghost = sub("ghost", 10)
        .await?
        .deploy(&ghost_wasm())
        .await?
        .into_result()?;
    ghost
        .call("new")
        .args_json(json!({ "signer_id": signer.id() }))
        .transact()
        .await?
        .into_result()?;
    let alice = sub("alice", 10).await?;
    let relayer = sub("relayer", 10).await?;
    Ok(Env {
        worker,
        ghost,
        signer,
        alice,
        relayer,
    })
}

fn report(label: &str, r: &ExecutionFinalResult) {
    let per: Vec<String> = r
        .outcomes()
        .iter()
        .map(|o| {
            format!(
                "{}={:.2}",
                o.executor_id,
                o.gas_burnt.as_gas() as f64 / 1e12
            )
        })
        .collect();
    println!(
        "GAS {label}: total {:.2} Tgas burnt [{}]",
        r.total_gas_burnt.as_gas() as f64 / 1e12,
        per.join(", ")
    );
}

fn failure_text(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.clone().into_result().err())
}

async fn height(w: &Worker<Sandbox>) -> anyhow::Result<u64> {
    Ok(w.view_block().await?.height())
}

#[tokio::test]
async fn register_announce_pagination_and_refunds() -> anyhow::Result<()> {
    let e = setup().await?;
    let spend = SigningKey::from_slice(&[0x11; 32])?
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .to_vec();

    // register with a 1 NEAR deposit: storage is charged, the rest is refunded
    let before = e.alice.view_account().await?.balance;
    let storage0 = e.ghost.view_account().await?.storage_usage;
    let r = e.alice.call(e.ghost.id(), "register")
        .args_json(json!({ "spend_pub": hex::encode(&spend), "view_pub": hex::encode([7u8; 32]), "mode": "contract" }))
        .deposit(NearToken::from_near(1))
        .transact().await?;
    report("register", &r);
    assert!(r.is_success(), "{r:?}");
    let spent = before.as_yoctonear() - e.alice.view_account().await?.balance.as_yoctonear();
    let storage1 = e.ghost.view_account().await?.storage_usage;
    println!(
        "STORAGE register: {} bytes; caller paid {:.5} NEAR incl. gas",
        storage1 - storage0,
        spent as f64 / 1e24
    );
    assert!(
        spent < NearToken::from_millinear(10).as_yoctonear(),
        "refund missing: spent {spent}"
    );
    let meta: Value = e
        .ghost
        .view("get_meta")
        .args_json(json!({ "account_id": e.alice.id() }))
        .await?
        .json()?;
    assert_eq!(meta["v"], 1);
    assert_eq!(meta["spend_pub"], hex::encode(&spend));

    // register without deposit fails
    let r = e.relayer.call(e.ghost.id(), "register")
        .args_json(json!({ "spend_pub": hex::encode(&spend), "view_pub": hex::encode([7u8; 32]), "mode": "contract" }))
        .transact().await?;
    assert!(failure_text(&r).contains("insufficient_deposit"));

    // announce x3, one with a memo; check refund, event, pagination
    let before = e.alice.view_account().await?.balance;
    for i in 0..3u8 {
        let s0 = e.ghost.view_account().await?.storage_usage;
        let ct = if i == 1 {
            Some("bm9uY2U6Y2lwaGVydGV4dA==")
        } else {
            None
        };
        let r = e
            .alice
            .call(e.ghost.id(), "announce")
            .args_json(
                json!({ "chain": "evm:31337", "eph": hex::encode([i; 32]), "tag": i, "ct": ct }),
            )
            .deposit(NearToken::from_near(1))
            .transact()
            .await?;
        report(
            if i == 1 {
                "announce (with 24-char memo)"
            } else {
                "announce"
            },
            &r,
        );
        assert!(r.is_success(), "{r:?}");
        assert!(
            r.logs()
                .iter()
                .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"announce\""))
        );
        assert_eq!(r.json::<u64>()?, i as u64);
        println!(
            "STORAGE announce #{i}: {} bytes",
            e.ghost.view_account().await?.storage_usage - s0
        );
    }
    let spent = before.as_yoctonear() - e.alice.view_account().await?.balance.as_yoctonear();
    println!(
        "announce x3: caller paid {:.5} NEAR incl. gas",
        spent as f64 / 1e24
    );
    assert!(
        spent < NearToken::from_millinear(20).as_yoctonear(),
        "refund missing: spent {spent}"
    );

    let count: u64 = e.ghost.view("announcement_count").await?.json()?;
    assert_eq!(count, 3);
    let page: Vec<Value> = e
        .ghost
        .view("get_announcements")
        .args_json(json!({ "from": 1, "limit": 5 }))
        .await?
        .json()?;
    assert_eq!(page.len(), 2);
    assert_eq!(page[0]["idx"], 1);
    assert_eq!(page[0]["ct"], "bm9uY2U6Y2lwaGVydGV4dA==");
    assert_eq!(page[0]["announcer"], e.alice.id().as_str());
    assert!(page[0].get("recipient").is_none());
    let signer_id: String = e.ghost.view("signer_id").await?.json()?;
    assert_eq!(signer_id, e.signer.id().as_str());
    Ok(())
}

#[tokio::test]
async fn sweep_paths() -> anyhow::Result<()> {
    let e = setup().await?;
    let gid = e.ghost.id().as_str().to_string();
    let sk = SigningKey::from_slice(&[0x11; 32])?;
    let h = height(&e.worker).await?;

    // good ECDSA sweep: the mock sees the ghost contract as predecessor, 1 yocto, the same request
    let args = sweep_args(&sk, &gid, 0, &[0x42; 32], h + 100);
    let r = e
        .relayer
        .call(e.ghost.id(), "sweep")
        .args_json(&args)
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    report("sweep ECDSA (mock signer, 300 Tgas attached)", &r);
    assert!(r.is_success(), "{r:?}");
    let out: Value = r.json()?;
    assert_eq!(out["scheme"], "Mock");
    assert_eq!(out["predecessor"], gid);
    assert_eq!(out["deposit"], "1");
    assert_eq!(
        out["request"],
        json!({ "payload_v2": { "Ecdsa": "42".repeat(32) }, "path": args["path"], "domain_id": 0 })
    );
    println!(
        "sweep: sign was given {:.1} Tgas",
        out["prepaid_gas"].as_u64().unwrap() as f64 / 1e12
    );

    // the client-side helper view agrees with our independent digest
    let d: String = e.ghost.view("sweep_digest")
        .args_json(json!({ "path": args["path"], "domain_id": 0, "payloads": args["payloads"], "expires_block": args["expires_block"] }))
        .await?.json()?;
    assert_eq!(
        d,
        hex::encode(digest(
            &gid,
            args["path"].as_str().unwrap(),
            0,
            h + 100,
            &[vec![0x42; 32]]
        ))
    );

    // good EdDSA sweep with a Solana-sized message; minimum gas (50 Tgas) is enough
    let msg: Vec<u8> = (0..700u32).map(|i| i as u8).collect();
    let args = sweep_args(&sk, &gid, 1, &msg, h + 100);
    let r = e
        .relayer
        .call(e.ghost.id(), "sweep")
        .args_json(&args)
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    report(
        "sweep EdDSA 700-byte payload (mock signer, 50 Tgas attached)",
        &r,
    );
    assert!(r.is_success(), "{r:?}");
    let out: Value = r.json()?;
    assert_eq!(out["request"]["payload_v2"]["Eddsa"], hex::encode(&msg));

    let calls: u64 = e.signer.view("calls").await?.json()?;
    assert_eq!(calls, 2);

    // rejections: bad signature, expired, wrong k_pub, no deposit
    let bad_cases: Vec<(&str, Value, u128)> = vec![
        (
            "bad_signature",
            {
                let mut a = sweep_args(&sk, &gid, 0, &[0x42; 32], h + 100);
                a["payloads"] = json!([hex::encode([0x43u8; 32])]);
                a
            },
            1,
        ),
        (
            "bad_signature",
            {
                // signed for a different contract id (replay across deployments)
                sweep_args(&sk, "other.test.near", 0, &[0x42; 32], h + 100)
            },
            1,
        ),
        (
            "expired",
            sweep_args(&sk, &gid, 0, &[0x42; 32], h.saturating_sub(1)),
            1,
        ),
        (
            "path_mismatch",
            {
                let mut a = sweep_args(&sk, &gid, 0, &[0x42; 32], h + 100);
                a["k_pub"] = json!(hex::encode(k_unc(&SigningKey::from_slice(&[0x22; 32])?)));
                a
            },
            1,
        ),
        (
            "insufficient_deposit",
            sweep_args(&sk, &gid, 0, &[0x42; 32], h + 100),
            0,
        ),
    ];
    for (want, args, deposit) in bad_cases {
        let r = e
            .relayer
            .call(e.ghost.id(), "sweep")
            .args_json(&args)
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        let f = failure_text(&r);
        assert!(f.contains(want), "expected {want}, got {f}");
    }
    let r = e
        .relayer
        .call(e.ghost.id(), "sweep")
        .args_json(sweep_args(&sk, &gid, 0, &[0x42; 32], h + 100))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(40))
        .transact()
        .await?;
    assert!(failure_text(&r).contains("insufficient_gas"));
    let calls: u64 = e.signer.view("calls").await?.json()?;
    assert_eq!(calls, 2, "rejected sweeps must not reach the signer");
    Ok(())
}
