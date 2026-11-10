//! Ghost Paths contract: one account, three concerns (PLAN.md 1.8).
//!
//! - registry: `register` / `get_meta` — a recipient's meta-address (secp256k1 spend key + X25519
//!   viewing key), keyed by the NEAR account that registered it.
//! - announcements: `announce` / `get_announcements` — an append-only log of `(chain, eph, tag, ct)`
//!   with no recipient field, plus NEP-297 events.
//! - sweep gateway: `sweep` — verifies an ECDSA signature by the per-payment stealth key `K`
//!   (`env::ecrecover`) and forwards `sign` to the Chain Signatures MPC contract with 1 yoctoNEAR.
//!   This contract is the MPC predecessor for every user, so derived addresses are
//!   `derive(this_contract, "gp1/" + hex(sha256(K)))`.
//!
//! No owner, no upgrade method, no admin (v1). Panics use short codes: `invalid_argument: ...`,
//! `insufficient_deposit: ...`, `insufficient_gas: ...`, `expired`, `path_mismatch`,
//! `bad_signature`.

// `sweep` takes 8 arguments: that list is the frozen ABI (PLAN.md 1.8).
#![allow(clippy::too_many_arguments)]

use near_sdk::store::{LookupMap, Vector};
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, near};

mod announce;
mod events;
mod registry;
mod sweep;
mod util;

pub use announce::{Announcement, MAX_CHAIN_LEN, MAX_CT_LEN, MAX_PAGE, StoredAnnouncement};
pub use registry::{Meta, StoredMeta};
pub use sweep::{
    EDDSA_MAX_PAYLOAD, MIN_SWEEP_GAS, SIGN_GAS, SWEEP_TAG, sweep_digest_bytes, sweep_preimage,
};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Metas,
    Announcements,
}

#[near(
    contract_state,
    contract_metadata(standard(standard = "ghost-paths", version = "1.0.0"))
)]
#[derive(PanicOnDefault)]
pub struct GhostPaths {
    /// Chain Signatures MPC contract (`v1.signer-prod.testnet` / `v1.signer`). Fixed at init.
    signer_id: AccountId,
    metas: LookupMap<AccountId, StoredMeta>,
    announcements: Vector<StoredAnnouncement>,
}

#[near]
impl GhostPaths {
    #[init]
    pub fn new(signer_id: AccountId) -> Self {
        Self {
            signer_id,
            metas: LookupMap::new(StorageKey::Metas),
            announcements: Vector::new(StorageKey::Announcements),
        }
    }

    /// The MPC signer this contract forwards `sign` to.
    pub fn signer_id(&self) -> AccountId {
        self.signer_id.clone()
    }
}

#[cfg(test)]
mod tests;
