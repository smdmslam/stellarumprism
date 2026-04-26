//! Save a chat session to disk as a Markdown file with YAML frontmatter.
//!
//! Two output formats:
//!   - **v1 (default)**: clean human-readable transcript with only user +
//!     assistant prose. Smaller, easier to browse, lossy on tool-loop turns.
//!   - **v2 (`full=true`)**: lossless. Preserves assistant `tool_calls`
//!     and `role=tool` results so a loaded session can be truly continued
//!     by another model. Slightly less human-friendly because tool
//!     payloads can be large, but round-trips perfectly through `load_chat`.
//!
//! v2 encodes the extra metadata in HTML comment blocks (`<!--prism:...-->`)
//! at the top of each section's body. They're invisible in standard
//! markdown viewers, so the file remains readable; the parser pulls them
//! out to reconstruct the full `Vec<Message>`.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::agent::{Message, SessionState};

#[derive(Serialize)]
pub struct SaveChatResult {
    pub path: String,
    pub bytes_written: usize,
    pub message_count: usize,
    /// `"prism-chat-v1"` or `"prism-chat-v2"`. Surfaced so the frontend
    /// can confirm to the user which mode wrote the file.
    pub format: String,
}

/// Render the chat for the given `chat_id` as markdown and write it to
/// `path`. When `full == Some(true)`, emits the v2 tool-aware format.
/// When `false` or `None`, emits the v1 clean transcript format.
#[tauri::command]
pub fn save_chat_markdown(
    chat_id: String,
    path: String,
    model: Option<String>,
    title: Option<String>,
    full: Option<bool>,
    session: State<'_, SessionState>,
) -> Result<SaveChatResult, String> {
    let want_full = full.unwrap_or(false);

    // Snapshot strategy differs by mode. v1 uses the user/assistant-only
    // history (current behavior). v2 uses the full unfiltered snapshot
    // and drops only the system message; everything else (assistant
    // tool_calls, tool results) is preserved.
    let history: Vec<Message> = if want_full {
        session
            .full_snapshot(&chat_id)
            .into_iter()
            .filter(|m| m.role != "system")
            .collect()
    } else {
        crate::agent::agent_get_history(chat_id.clone(), session)
    };

    if history.is_empty() {
        return Err("nothing to save \u{2014} chat is empty".into());
    }

    let out_path = PathBuf::from(&path);
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }

    let format_str = if want_full {
        "prism-chat-v2"
    } else {
        "prism-chat-v1"
    };

    let md = render_markdown(
        &chat_id,
        title.as_deref().unwrap_or("Prism Chat"),
        model.as_deref().unwrap_or("unknown"),
        format_str,
        &history,
        want_full,
    );
    let bytes_written = md.len();
    let message_count = history.len();

    fs::write(&out_path, md).map_err(|e| format!("write: {}", e))?;

    Ok(SaveChatResult {
        path: out_path.to_string_lossy().to_string(),
        bytes_written,
        message_count,
        format: format_str.to_string(),
    })
}

/// Public for unit tests; exposes the rendered markdown without touching disk.
pub fn render_markdown(
    chat_id: &str,
    title: &str,
    model: &str,
    format_str: &str,
    messages: &[Message],
    full: bool,
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
    out.push_str(&format!("format: {}\n", format_str));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n\n", title));

    for (i, m) in messages.iter().enumerate() {
        if full {
            render_message_v2(&mut out, m);
        } else {
            render_message_v1(&mut out, m);
        }
        if i + 1 < messages.len() {
            out.push_str("---\n\n");
        }
    }
    out
}

/// v1: render only the user-facing prose, dropping anything else.
/// Mirrors the historical behaviour exactly.
fn render_message_v1(out: &mut String, m: &Message) {
    let content = m.content.as_deref().unwrap_or("");
    let heading = match m.role.as_str() {
        "user" => "## User",
        "assistant" => "## Assistant",
        other => {
            // Fallback; ideally agent_get_history already strips system
            // and tool messages. But if one slips through, dump it raw.
            out.push_str(&format!("## {}\n\n{}\n\n", other, content));
            return;
        }
    };
    out.push_str(heading);
    out.push_str("\n\n");
    out.push_str(content.trim_end());
    out.push_str("\n\n");
}

/// v2: render with full role + metadata fidelity.
///
/// Roles map to headings:
///   user      → `## User`
///   assistant → `## Assistant`  (with optional tool_calls metadata block)
///   tool      → `## Tool`       (with required tool_call_id + name block)
///
/// Metadata travels in HTML comment blocks at the top of the body so a
/// human reading the markdown sees only the prose, while the loader can
/// reconstruct the wire-shape exactly.
fn render_message_v2(out: &mut String, m: &Message) {
    match m.role.as_str() {
        "user" => {
            out.push_str("## User\n\n");
            out.push_str(m.content.as_deref().unwrap_or("").trim_end());
            out.push_str("\n\n");
        }
        "assistant" => {
            out.push_str("## Assistant\n\n");
            if let Some(calls) = &m.tool_calls {
                let json = serde_json::to_string(calls).unwrap_or_else(|_| "[]".into());
                out.push_str("<!--prism:tool-calls\n");
                out.push_str(&json);
                out.push_str("\n-->\n\n");
            }
            let body = m.content.as_deref().unwrap_or("").trim_end();
            if !body.is_empty() {
                out.push_str(body);
                out.push_str("\n\n");
            }
        }
        "tool" => {
            out.push_str("## Tool\n\n");
            // tool_call_id + name are required by OpenAI's wire format
            // for any role=tool message; emit them so the load round-trip
            // produces a valid request.
            let meta = serde_json::json!({
                "tool_call_id": m.tool_call_id.as_deref().unwrap_or(""),
                "name": m.name.as_deref().unwrap_or(""),
            });
            out.push_str("<!--prism:tool-result\n");
            out.push_str(&meta.to_string());
            out.push_str("\n-->\n\n");
            out.push_str(m.content.as_deref().unwrap_or("").trim_end());
            out.push_str("\n\n");
        }
        other => {
            // Unknown role: dump raw so the file isn't lossy. The
            // loader will fall back to skipping these.
            out.push_str(&format!("## {}\n\n", other));
            out.push_str(m.content.as_deref().unwrap_or("").trim_end());
            out.push_str("\n\n");
        }
    }
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

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{ToolCall, ToolCallFunction};

    fn user(s: &str) -> Message {
        Message::user(s.to_string())
    }
    fn assistant(s: &str) -> Message {
        Message::assistant(s.to_string())
    }
    fn assistant_calls(text: &str, calls: Vec<ToolCall>) -> Message {
        Message::assistant_tool_calls(text.to_string(), calls)
    }
    fn tool_result(call_id: &str, name: &str, body: &str) -> Message {
        Message::tool_result(call_id.into(), name.into(), body.into())
    }
    fn call(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            call_type: "function".into(),
            function: ToolCallFunction {
                name: name.into(),
                arguments: args.into(),
            },
        }
    }

    #[test]
    fn v1_renders_only_user_assistant_prose() {
        let msgs = vec![user("hi"), assistant("hello back")];
        let md = render_markdown("c1", "Test", "kimi-k2.5", "prism-chat-v1", &msgs, false);
        assert!(md.contains("## User"));
        assert!(md.contains("## Assistant"));
        assert!(md.contains("hi"));
        assert!(md.contains("hello back"));
        assert!(!md.contains("prism:tool-calls"));
        assert!(md.contains("format: prism-chat-v1"));
    }

    #[test]
    fn v2_emits_tool_calls_metadata_block() {
        let msgs = vec![
            user("how many tests?"),
            assistant_calls(
                "let me check",
                vec![call("call_a", "read_file", "{\"path\":\"x.md\"}")],
            ),
            tool_result("call_a", "read_file", "file contents here"),
            assistant("113 tests"),
        ];
        let md = render_markdown("c2", "Test", "gpt-5.4", "prism-chat-v2", &msgs, true);
        assert!(md.contains("format: prism-chat-v2"));
        assert!(md.contains("## Tool"));
        assert!(md.contains("<!--prism:tool-calls"));
        assert!(md.contains("call_a"));
        assert!(md.contains("read_file"));
        assert!(md.contains("<!--prism:tool-result"));
        assert!(md.contains("file contents here"));
    }

    #[test]
    fn v2_handles_assistant_with_tool_calls_but_no_text() {
        // Common case: model emits tool_calls with empty content.
        let msgs = vec![
            user("read x.md"),
            assistant_calls("", vec![call("c1", "read_file", "{}")]),
            tool_result("c1", "read_file", "x"),
        ];
        let md = render_markdown("c3", "T", "m", "prism-chat-v2", &msgs, true);
        // Tool-calls block must appear even when content is empty.
        assert!(md.contains("<!--prism:tool-calls"));
        assert!(md.contains("\"id\":\"c1\""));
    }
}
