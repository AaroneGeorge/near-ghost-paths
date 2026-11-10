//! Test double for the Chain Signatures MPC contract (`v1.signer`). `sign` enforces the same
//! preconditions the real one does (>= 1 yoctoNEAR, >= 15 Tgas prepaid) and echoes the request,
//! the predecessor (the key the real MPC derives on) and what was attached, so tests can assert
//! exactly what Ghost Paths forwarded. It answers synchronously; the real one uses yield/resume.

use near_sdk::serde_json::{Value, json};
use near_sdk::{Gas, NearToken, PanicOnDefault, env, near, require};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    calls: u64,
}

#[near]
impl MockSigner {
    #[init]
    pub fn new() -> Self {
        Self { calls: 0 }
    }

    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "mock: deposit < 1 yocto"
        );
        require!(
            env::prepaid_gas() >= Gas::from_tgas(15),
            "mock: prepaid gas < 15 Tgas"
        );
        self.calls += 1;
        json!({
            "scheme": "Mock",
            "predecessor": env::predecessor_account_id(),
            "request": request,
            "deposit": env::attached_deposit().as_yoctonear().to_string(),
            "prepaid_gas": env::prepaid_gas().as_gas(),
        })
    }

    pub fn calls(&self) -> u64 {
        self.calls
    }
}
