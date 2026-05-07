use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use serde::{Serialize, Deserialize};
use chrono::Utc;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct AuditEntry {
    pub audit_id: String,
    pub timestamp: String,
    pub chat_id: String,
    pub request_id: Option<String>,
    pub tool: String,
    pub arguments: serde_json::Value,
    pub decision: String, // "approve" | "approve-session" | "reject"
    pub round: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuditEventEntry {
    pub audit_id: String,
    pub timestamp: String,
    pub chat_id: String,
    pub request_id: Option<String>,
    pub event_type: String,
    pub payload: serde_json::Value,
}

pub fn log_approval(
    cwd: &str,
    chat_id: String,
    request_id: Option<String>,
    tool: String,
    arguments: String,
    decision: &str,
    round: usize,
) {
    let args_json: serde_json::Value = serde_json::from_str(&arguments).unwrap_or(serde_json::json!({ "raw": arguments }));
    
    let entry = AuditEntry {
        audit_id: Uuid::new_v4().to_string(),
        timestamp: Utc::now().to_rfc3339(),
        chat_id,
        request_id,
        tool,
        arguments: args_json,
        decision: decision.to_string(),
        round,
    };

    if let Some(path) = audit_trail_path(cwd) {
        if let Ok(json) = serde_json::to_string(&entry) {
            let _ = append_to_file(path, format!("{}\n", json));
        }
    }
}

pub fn log_event(
    cwd: &str,
    chat_id: String,
    request_id: Option<String>,
    event_type: &str,
    payload: serde_json::Value,
) {
    let entry = AuditEventEntry {
        audit_id: Uuid::new_v4().to_string(),
        timestamp: Utc::now().to_rfc3339(),
        chat_id,
        request_id,
        event_type: event_type.to_string(),
        payload,
    };
    if let Some(path) = audit_trail_path(cwd) {
        if let Ok(json) = serde_json::to_string(&entry) {
            let _ = append_to_file(path, format!("{}\n", json));
        }
    }
}

fn audit_trail_path(cwd: &str) -> Option<PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    let p = PathBuf::from(cwd).join("prism");
    let _ = std::fs::create_dir_all(&p);
    Some(p.join("audit-trail.jsonl"))
}

fn append_to_file(path: PathBuf, data: String) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(data.as_bytes())?;
    Ok(())
}
