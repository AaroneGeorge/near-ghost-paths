//! Announcement log: `announce` / `announcement_count` / `get_announcements` (PLAN.md 1.5, 1.8).
//! An announcement has no recipient field, ever.

use near_sdk::serde_json::json;
use near_sdk::{AccountId, env, near, require};

use crate::util::{charge_storage, hex_exact};
use crate::{GhostPaths, GhostPathsExt, events};

/// Maximum `chain` tag length, e.g. `evm:11155111`, `btc:testnet4`, `sol:devnet`.
pub const MAX_CHAIN_LEN: usize = 32;
/// Maximum memo ciphertext length (characters of whatever text encoding the SDK uses).
pub const MAX_CT_LEN: usize = 1024;
/// Page size cap for `get_announcements`; larger `limit`s are clamped.
pub const MAX_PAGE: u32 = 200;

#[near(serializers = [borsh])]
pub struct StoredAnnouncement {
    pub chain: String,
    pub eph: [u8; 32],
    pub tag: u8,
    pub ct: Option<String>,
    pub block_height: u64,
    pub timestamp_ms: u64,
    pub announcer: AccountId,
}

/// JSON view, equal to `Announcement` in packages/sdk/src/types.ts.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Announcement {
    pub idx: u64,
    pub chain: String,
    pub eph: String,
    pub tag: u8,
    pub ct: Option<String>,
    pub block_height: u64,
    pub timestamp_ms: u64,
    pub announcer: AccountId,
}

impl Announcement {
    fn from_stored(idx: u64, a: &StoredAnnouncement) -> Self {
        Announcement {
            idx,
            chain: a.chain.clone(),
            eph: hex::encode(a.eph),
            tag: a.tag,
            ct: a.ct.clone(),
            block_height: a.block_height,
            timestamp_ms: a.timestamp_ms,
            announcer: a.announcer.clone(),
        }
    }
}

#[near]
impl GhostPaths {
    /// Append an announcement and return its index. Payable: attach storage (127 bytes =
    /// 0.00127 NEAR without a memo, +0.00001 NEAR per memo char; 0.003 NEAR covers a 160-char
    /// memo). The excess is refunded.
    /// `chain`: chain tag, `[a-z0-9:-]`, 1..=32 chars. `eph`: 32-byte X25519 ephemeral key, hex.
    /// `tag`: view tag. `ct`: optional memo ciphertext, printable ASCII, 1..=1024 chars.
    #[payable]
    pub fn announce(&mut self, chain: String, eph: String, tag: u8, ct: Option<String>) -> u64 {
        require!(
            !chain.is_empty()
                && chain.len() <= MAX_CHAIN_LEN
                && chain.bytes().all(|c| c.is_ascii_lowercase()
                    || c.is_ascii_digit()
                    || c == b':'
                    || c == b'-'),
            "invalid_argument: chain must match [a-z0-9:-]{1,32}"
        );
        let eph: [u8; 32] = hex_exact(&eph, 32, "eph").try_into().unwrap();
        if let Some(ct) = &ct {
            require!(
                !ct.is_empty()
                    && ct.len() <= MAX_CT_LEN
                    && ct.bytes().all(|c| c.is_ascii_graphic()),
                "invalid_argument: ct must be 1..=1024 printable ASCII chars"
            );
        }

        let before = env::storage_usage();
        let idx = self.announcements.len() as u64;
        let stored = StoredAnnouncement {
            chain,
            eph,
            tag,
            ct,
            block_height: env::block_height(),
            timestamp_ms: env::block_timestamp_ms(),
            announcer: env::predecessor_account_id(),
        };
        let data =
            json!({ "idx": idx, "chain": stored.chain, "eph": hex::encode(eph), "tag": tag });
        self.announcements.push(stored);
        self.announcements.flush();
        charge_storage(before);
        events::emit("announce", data);
        idx
    }

    pub fn announcement_count(&self) -> u64 {
        self.announcements.len() as u64
    }

    /// Announcements `[from, from + limit)`, `limit` clamped to 200. Empty past the end.
    pub fn get_announcements(&self, from: u64, limit: u32) -> Vec<Announcement> {
        let len = self.announcements.len() as u64;
        let end = len.min(from.saturating_add(limit.min(MAX_PAGE) as u64));
        (from..end)
            .map(|i| Announcement::from_stored(i, self.announcements.get(i as u32).unwrap()))
            .collect()
    }
}
