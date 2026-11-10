//! Meta-address registry: `register` / `get_meta` (PLAN.md 1.4, 1.8).

use near_sdk::serde_json::json;
use near_sdk::{AccountId, env, near, require};

use crate::util::{charge_storage, hex_exact};
use crate::{GhostPaths, GhostPathsExt, events};

const MODES: [&str; 2] = ["contract", "account"];

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct StoredMeta {
    /// Index into `MODES`.
    pub mode: u8,
    /// Compressed secp256k1 spend public key (0x02/0x03 prefix).
    pub spend_pub: [u8; 33],
    /// X25519 viewing public key.
    pub view_pub: [u8; 32],
}

/// JSON view, equal to `Meta` in packages/sdk/src/types.ts.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Meta {
    pub v: u8,
    pub mode: String,
    pub spend_pub: String,
    pub view_pub: String,
}

impl From<&StoredMeta> for Meta {
    fn from(m: &StoredMeta) -> Self {
        Meta {
            v: 1,
            mode: MODES[m.mode as usize].to_string(),
            spend_pub: hex::encode(m.spend_pub),
            view_pub: hex::encode(m.view_pub),
        }
    }
}

#[near]
impl GhostPaths {
    /// Register (or overwrite) the caller's meta-address. Payable: attach storage
    /// (126 bytes = 0.00126 NEAR the first time; overwrites cost nothing); the excess is refunded.
    /// `spend_pub`: 33-byte compressed secp256k1 hex. `view_pub`: 32-byte X25519 hex.
    /// `mode`: "contract" (Mode B, default) or "account" (Mode A fallback).
    #[payable]
    pub fn register(&mut self, spend_pub: String, view_pub: String, mode: String) {
        let mode_idx = MODES.iter().position(|m| *m == mode).unwrap_or_else(|| {
            env::panic_str("invalid_argument: mode must be \"contract\" or \"account\"")
        });
        let spend: [u8; 33] = hex_exact(&spend_pub, 33, "spend_pub").try_into().unwrap();
        require!(
            spend[0] == 2 || spend[0] == 3,
            "invalid_argument: spend_pub must be compressed (02/03 prefix)"
        );
        let view: [u8; 32] = hex_exact(&view_pub, 32, "view_pub").try_into().unwrap();
        require!(view != [0u8; 32], "invalid_argument: view_pub is zero");

        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        self.metas.insert(
            account.clone(),
            StoredMeta {
                mode: mode_idx as u8,
                spend_pub: spend,
                view_pub: view,
            },
        );
        self.metas.flush();
        charge_storage(before);
        events::emit("register", json!({ "account_id": account, "mode": mode }));
    }

    pub fn get_meta(&self, account_id: AccountId) -> Option<Meta> {
        self.metas.get(&account_id).map(Meta::from)
    }
}
