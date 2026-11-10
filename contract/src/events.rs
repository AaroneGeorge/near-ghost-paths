//! NEP-297 events (`EVENT_JSON:{"standard":"ghost-paths","version":"1.0.0",...}`).

use near_sdk::env;
use near_sdk::serde_json::{self, Value, json};

pub(crate) const STANDARD: &str = "ghost-paths";
pub(crate) const VERSION: &str = "1.0.0";

pub(crate) fn emit(event: &str, data: Value) {
    let ev = json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] });
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::to_string(&ev).unwrap()
    ));
}
