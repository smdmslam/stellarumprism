use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use serde::{Serialize, Deserialize};
use chrono::Utc;
use uuid::Uuid;

use crate::pricing::{get_pricing_basis, PricingBasis};

#[derive(Debug, Serialize, Deserialize)]
pub struct UsageEvent {
    #[serde(default)]
    pub schema_version: String,
    pub event_id: String,
    #[serde(default)]
    pub idempotency_key: String,
    pub timestamp: String,
    pub request_id: Option<String>,
    #[serde(default)]
    pub turn_id: String,
    pub chat_id: String,
    #[serde(default)]
    pub user_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub workspace_id_hash: String,
    pub mode: String,
    #[serde(default)]
    pub surface: String,
    #[serde(default)]
    pub trigger_source: String,
    #[serde(default)]
    pub lifecycle: String,
    #[serde(default)]
    pub feature_tags: Vec<String>,
    pub model: String,
    pub provider: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    pub duration_ms: u64,
    pub success: bool,
    pub cancelled: bool,
    pub estimated_cost_usd: f64,
    pub markup_cost_usd: f64,
    #[serde(default)]
    pub final_cost_usd: Option<f64>,
    pub pricing_basis: PricingBasis,
    #[serde(default)]
    pub pricing_basis_version: String,
}

#[derive(Debug, Serialize)]
pub struct UsageSummary {
    pub session_tokens: u32,
    pub session_cost_usd: f64,
    pub session_markup_cost_usd: f64,
    pub session_calls: u32,
    pub today_tokens: u32,
    pub today_cost_usd: f64,
    pub today_markup_cost_usd: f64,
    pub today_calls: u32,
    pub by_interaction: Vec<InteractionUsage>,
}

#[derive(Debug, Serialize)]
pub struct InteractionUsage {
    pub mode: String,
    pub model: String,
    pub tokens: u32,
    pub cost: f64,
    pub markup_cost: f64,
    pub calls: u32,
}

use tauri::Emitter;

pub fn emit_usage_event(
    app_handle: &tauri::AppHandle,
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
) -> f64 {
    eprintln!("[usage] emitting event: model={}, tokens={}+{}", model, prompt_tokens, completion_tokens);
    let total_tokens = prompt_tokens + completion_tokens;
    let pricing = get_pricing_basis(&model);
    
    let estimated_cost_usd = (prompt_tokens as f64 * pricing.input_per_m / 1_000_000.0) +
                             (completion_tokens as f64 * pricing.output_per_m / 1_000_000.0);
    let lifecycle = if cancelled {
        "cancelled"
    } else if success {
        "completed"
    } else {
        "failed"
    };
    let surface = infer_surface(&mode);
    let trigger_source = infer_trigger_source(&mode);
    let feature_tags = infer_feature_tags(&mode);
    let turn_id = request_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    let workspace_id_hash = hash_workspace_id(&workspace_id);
    let idempotency_key = format!(
        "{}:{}:{}:{}:{}:{}:{}",
        request_id.clone().unwrap_or_else(|| "none".into()),
        chat_id,
        mode,
        model,
        prompt_tokens,
        completion_tokens,
        lifecycle
    );

    let event = UsageEvent {
        schema_version: "v2".to_string(),
        event_id: Uuid::new_v4().to_string(),
        idempotency_key,
        timestamp: Utc::now().to_rfc3339(),
        request_id,
        turn_id,
        chat_id,
        user_id: "local".to_string(),
        workspace_id,
        workspace_id_hash,
        mode,
        surface,
        trigger_source,
        lifecycle: lifecycle.to_string(),
        feature_tags,
        model,
        provider,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        duration_ms,
        success,
        cancelled,
        estimated_cost_usd,
        markup_cost_usd: estimated_cost_usd * 20.0,
        final_cost_usd: None,
        pricing_basis: pricing,
        pricing_basis_version: "pricing_basis/v1".to_string(),
    };

    let _ = app_handle.emit("usage-event", &event);

    if let Some(path) = usage_file_path() {
        if let Ok(json) = serde_json::to_string(&event) {
            eprintln!("[usage] persisting to {:?}", path);
            let _ = append_to_file(path, format!("{}\n", json));
        }
    }

    estimated_cost_usd
}

fn infer_surface(mode: &str) -> String {
    match mode {
        "reviewer" => "verifier".to_string(),
        "web_search" => "web_search".to_string(),
        "audit" | "build" | "fix" | "new" | "refactor" | "review" | "test-gen" | "chat" => {
            "agent".to_string()
        }
        _ => "agent".to_string(),
    }
}

fn infer_trigger_source(mode: &str) -> String {
    match mode {
        "reviewer" => "auto_verifier".to_string(),
        "web_search" => "tool_call".to_string(),
        _ => "user".to_string(),
    }
}

fn infer_feature_tags(mode: &str) -> Vec<String> {
    let mut tags = vec!["usage".to_string(), mode.to_string()];
    match mode {
        "reviewer" => tags.push("verification".to_string()),
        "web_search" => tags.push("search".to_string()),
        "audit" => tags.push("diagnostic".to_string()),
        "fix" | "refactor" | "build" | "new" | "test-gen" => tags.push("generation".to_string()),
        _ => {}
    }
    tags
}

fn hash_workspace_id(workspace_id: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    workspace_id.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

#[tauri::command]
pub fn get_usage_summary(chat_id: String) -> Result<UsageSummary, String> {
    let path = usage_file_path().ok_or("cannot resolve usage file path")?;
    if !path.exists() {
        return Ok(UsageSummary {
            session_tokens: 0,
            session_cost_usd: 0.0,
            session_markup_cost_usd: 0.0,
            session_calls: 0,
            today_tokens: 0,
            today_cost_usd: 0.0,
            today_markup_cost_usd: 0.0,
            today_calls: 0,
            by_interaction: Vec::new(),
        });
    }

    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let now = Utc::now();
    let today_prefix = now.format("%Y-%m-%d").to_string();

    let mut session_tokens = 0;
    let mut session_cost = 0.0;
    let mut session_markup_cost = 0.0;
    let mut session_calls = 0;
    let mut today_tokens = 0;
    let mut today_cost = 0.0;
    let mut today_markup_cost = 0.0;
    let mut today_calls = 0;
    // Map: (mode, model) -> (tokens, cost, markup, calls)
    let mut interaction_map: std::collections::HashMap<(String, String), (u32, f64, f64, u32)> = std::collections::HashMap::new();
    let mut seen_dedupe_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in reader.lines() {
        let Ok(l) = line else { continue };
        let Ok(event) = serde_json::from_str::<UsageEvent>(&l) else { continue };
        let dedupe_key = usage_dedupe_key(&event);
        if !seen_dedupe_keys.insert(dedupe_key) {
            continue;
        }

        let is_today = event.timestamp.starts_with(&today_prefix);
        let is_session = event.chat_id == chat_id;

        if is_today {
            today_tokens += event.total_tokens;
            today_cost += event.estimated_cost_usd;
            today_markup_cost += event.markup_cost_usd;
            today_calls += 1;
        }

        if is_session {
            session_tokens += event.total_tokens;
            session_cost += event.estimated_cost_usd;
            session_markup_cost += event.markup_cost_usd;
            session_calls += 1;
        }

        let entry = interaction_map.entry((event.mode.clone(), event.model.clone())).or_insert((0, 0.0, 0.0, 0));
        entry.0 += event.total_tokens;
        entry.1 += event.estimated_cost_usd;
        entry.2 += event.markup_cost_usd;
        entry.3 += 1;
    }

    let mut by_interaction: Vec<InteractionUsage> = interaction_map
        .into_iter()
        .map(|((mode, model), (tokens, cost, markup_cost, calls))| InteractionUsage {
            mode,
            model,
            tokens,
            cost,
            markup_cost,
            calls,
        })
        .collect();

    by_interaction.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    Ok(UsageSummary {
        session_tokens,
        session_cost_usd: session_cost,
        session_markup_cost_usd: session_markup_cost,
        session_calls,
        today_tokens,
        today_cost_usd: today_cost,
        today_markup_cost_usd: today_markup_cost,
        today_calls,
        by_interaction,
    })
}

fn usage_file_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| {
        let p = d.join("prism");
        let _ = std::fs::create_dir_all(&p);
        let file_path = p.join("usage.jsonl");
        eprintln!("[usage] resolved path: {:?}", file_path);
        file_path
    })
}

fn append_to_file(path: PathBuf, data: String) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    if let Err(e) = file.write_all(data.as_bytes()) {
        eprintln!("[usage] failed to write to {:?}: {}", path, e);
        return Err(e);
    }
    Ok(())
}

pub fn get_total_today_tokens() -> u64 {
    let path = match usage_file_path() {
        Some(p) => p,
        None => return 0,
    };

    if !path.exists() {
        return 0;
    }

    let now = Utc::now();
    let today_str = now.format("%Y-%m-%d").to_string();
    let mut total = 0u64;
    let mut seen_dedupe_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Ok(file) = File::open(path) {
        let reader = BufReader::new(file);
        for line in reader.lines() {
            if let Ok(l) = line {
                if let Ok(event) = serde_json::from_str::<UsageEvent>(&l) {
                    let dedupe_key = usage_dedupe_key(&event);
                    if !seen_dedupe_keys.insert(dedupe_key) {
                        continue;
                    }
                    if event.timestamp.starts_with(&today_str) {
                        total += (event.prompt_tokens + event.completion_tokens) as u64;
                    }
                }
            }
        }
    }
    total
}

fn usage_dedupe_key(event: &UsageEvent) -> String {
    if !event.idempotency_key.is_empty() {
        return event.idempotency_key.clone();
    }
    if !event.event_id.is_empty() {
        return event.event_id.clone();
    }
    // Legacy fallback for older rows without explicit ids.
    format!(
        "{}:{}:{}:{}:{}:{}",
        event.timestamp,
        event.chat_id,
        event.mode,
        event.model,
        event.prompt_tokens,
        event.completion_tokens
    )
}
