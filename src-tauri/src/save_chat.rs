//! Save a chat session to disk as a Markdown file with YAML frontmatter.
//!
//! The format is human-readable and trivial to re-parse later if we want an
//! `/open` command. See `docs/chat-format.md` for the schema.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::agent::SessionState;

#[derive(Serialize)]
pub struct SaveChatResult {
    pub path: String,
    pub bytes_written: usize,
    pub message_count: usize,
}

/// Render the chat for the given `chat_id` as markdown and write it to `path`.
#[tauri::command]
pub fn save_chat_markdown(
    chat_id: String,
    path: String,
    model: Option<String>,
    title: Option<String>,
    session: State<'_, SessionState>,
) -> Result<SaveChatResult, String> {
    let history = crate::agent::agent_get_history(chat_id.clone(), session);
    if history.is_empty() {
        return Err("nothing to save \u{2014} chat is empty".into());
    }

    let out_path = PathBuf::from(&path);
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }

    let md = render_markdown(
        &chat_id,
        title.as_deref().unwrap_or("Prism Chat"),
        model.as_deref().unwrap_or("unknown"),
        &history,
    );
    let bytes_written = md.len();
    let message_count = history.len();

    fs::write(&out_path, md).map_err(|e| format!("write: {}", e))?;

    Ok(SaveChatResult {
        path: out_path.to_string_lossy().to_string(),
        bytes_written,
        message_count,
    })
}

fn render_markdown(
    chat_id: &str,
    title: &str,
    model: &str,
    messages: &[crate::agent::Message],
) -> String {
    let now = current_iso8601();
    let escaped_title = title.replace('"', "\\\"");
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("title: \"{}\"\n", escaped_title));
    out.push_str(&format!("model: {}\n", model));
    out.push_str(&format!("chat_id: {}\n", chat_id));
    out.push_str(&format!("created: {}\n", now));
    out.push_str(&format!("messages: {}\n", messages.len()));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", title));

    for (i, m) in messages.iter().enumerate() {
        let content = m.content.as_deref().unwrap_or("");
        let heading = match m.role.as_str() {
            "user" => "## User",
            "assistant" => "## Assistant",
            other => {
                // Fallback; ideally agent_get_history already strips system
                // and tool messages. But if one slips through, dump it raw.
                out.push_str(&format!("## {}\n\n{}\n\n", other, content));
                continue;
            }
        };
        out.push_str(heading);
        out.push_str("\n\n");
        out.push_str(content.trim_end());
        out.push_str("\n\n");
        if i + 1 < messages.len() {
            out.push_str("---\n\n");
        }
    }
    out
}

fn current_iso8601() -> String {
    // Avoid pulling in chrono just for this. Produces e.g. "2026-04-23T22:15:00Z".
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = epoch_to_utc(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, mo, d, h, mi, s
    )
}

/// Converts seconds-since-epoch to (year, month, day, hour, minute, second) in UTC.
/// Algorithm from Howard Hinnant's date library (public domain).
fn epoch_to_utc(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86400) as i64;
    let tod = secs % 86400;
    let h = (tod / 3600) as u32;
    let mi = ((tod % 3600) / 60) as u32;
    let s = (tod % 60) as u32;

    // Civil-from-days (Hinnant).
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, h, mi, s)
}
