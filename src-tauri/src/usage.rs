use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use serde::{Serialize, Deserialize};
use chrono::Utc;
use uuid::Uuid;

use crate::pricing::{get_pricing_basis, PricingBasis};

#[derive(Debug, Serialize, Deserialize)]
pub struct UsageEvent {
    pub event_id: String,
    pub timestamp: String,
    pub request_id: Option<String>,
    pub chat_id: String,
    pub workspace_id: String,
    pub mode: String,
    pub model: String,
    pub provider: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    pub duration_ms: u64,
    pub success: bool,
    pub cancelled: bool,
    pub estimated_cost_usd: f64,
    pub pricing_basis: PricingBasis,
}

pub fn emit_usage_event(
    request_id: Option<String>,
    chat_id: String,
    workspace_id: String,
    mode: String,
    model: String,
    provider: String,
    prompt_tokens: u32,
    completion_tokens: u32,
    duration_ms: u64,
    success: bool,
    cancelled: bool,
) {
    let total_tokens = prompt_tokens + completion_tokens;
    let pricing = get_pricing_basis(&model);
    
    let estimated_cost_usd = (prompt_tokens as f64 * pricing.input_per_m / 1_000_000.0) +
                             (completion_tokens as f64 * pricing.output_per_m / 1_000_000.0);

    let event = UsageEvent {
        event_id: Uuid::new_v4().to_string(),
        timestamp: Utc::now().to_rfc3339(),
        request_id,
        chat_id,
        workspace_id,
        mode,
        model,
        provider,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        duration_ms,
        success,
        cancelled,
        estimated_cost_usd,
        pricing_basis: pricing,
    };

    if let Some(path) = usage_file_path() {
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = append_to_file(path, format!("{}\n", json));
        }
    }
}

fn usage_file_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| {
        let p = d.join("prism");
        let _ = std::fs::create_dir_all(&p);
        p.join("usage.jsonl")
    })
}

fn append_to_file(path: PathBuf, data: String) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(data.as_bytes())
}
