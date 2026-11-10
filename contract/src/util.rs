//! Small shared helpers: hex decoding with field-named errors and storage charging.

use near_sdk::{Promise, env, require};

/// Decode hex (either case, optional `0x` prefix) and require an exact byte length.
pub(crate) fn hex_exact(s: &str, len: usize, field: &str) -> Vec<u8> {
    let b = hex_any(s, field);
    if b.len() != len {
        env::panic_str(&format!(
            "invalid_argument: {field} must be {len} bytes, got {}",
            b.len()
        ));
    }
    b
}

/// Decode hex (either case, optional `0x` prefix) of any length.
pub(crate) fn hex_any(s: &str, field: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s)
        .unwrap_or_else(|_| env::panic_str(&format!("invalid_argument: {field} is not hex")))
}

/// Charge the attached deposit for storage added since `before` and refund the rest to the caller.
/// Storage freed by an overwrite is not refunded (v1).
pub(crate) fn charge_storage(before: u64) {
    let added = env::storage_usage().saturating_sub(before);
    let cost = env::storage_byte_cost().saturating_mul(added as u128);
    let deposit = env::attached_deposit();
    require!(
        deposit >= cost,
        format!(
            "insufficient_deposit: need {} yoctoNEAR for {added} bytes",
            cost.as_yoctonear()
        )
    );
    refund(deposit.saturating_sub(cost));
}

pub(crate) fn refund(amount: near_sdk::NearToken) {
    if !amount.is_zero() {
        Promise::new(env::predecessor_account_id())
            .transfer(amount)
            .detach();
    }
}
