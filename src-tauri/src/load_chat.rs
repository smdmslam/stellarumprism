//! Round-trip companion to `save_chat`. Reads a Prism chat markdown file
//! from disk, parses the YAML frontmatter and `## User` / `## Assistant`
//! sections back into a `Vec<Message>`, and seeds an existing chat
//! session with the result so the conversation can be continued.
//!
//! The parser is intentionally tolerant: anything we can't recognise is
//! either ignored (frontmatter) or handed back verbatim (message
//! bodies). Save → load round-trips losslessly for the standard format
//! produced by `save_chat::render_markdown`; deviations (extra
//! sections, unknown roles, missing frontmatter) degrade gracefully
//! without panicking.

use std::fs;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agent::{Message, SessionState, ToolCall};
use crate::approval::ApprovalState;
use crate::config::ConfigState;

/// Sentinel emitted by save_chat for the v2 (tool-aware) format. v1
/// files either omit the field entirely or explicitly say `prism-chat-v1`.
const FORMAT_V2: &str = "prism-chat-v2";

#[derive(Debug, Serialize)]
pub struct LoadChatResult {
    /// Number of user + assistant messages parsed.
    pub message_count: usize,
    /// Title pulled from the frontmatter, if any.
    pub title: Option<String>,
    /// Model slug pulled from the frontmatter, if any.
    pub model: Option<String>,
    /// `chat_id` recorded in the source file. NOT used to seed the
    /// session (the caller supplies the live chat id); surfaced so the
    /// frontend can show provenance.
    pub source_chat_id: Option<String>,
    /// `created` timestamp recorded in the source file.
    pub created: Option<String>,
}

/// Read a markdown chat file, parse it, and replace the session's
/// rolling history with the parsed messages.
///
/// Behaviour:
///   - The session for `chat_id` is reset (`SessionHandle::clear`).
///   - The user's configured system prompt is re-primed at index 0 so
///     subsequent `agent_query` calls behave as if the conversation
///     started fresh in this tab.
///   - Each parsed user / assistant message is appended in order.
///   - The associated approval state for `chat_id` is cleared so the
///     loaded chat starts from a clean approval slate.
///
/// The `chat_id` parameter intentionally identifies the LIVE tab to
/// receive the messages \u2014 NOT the chat_id from the file's frontmatter.
/// This lets a user load any saved chat into the current tab without
/// stomping a different tab that happens to share the saved file's id.
#[tauri::command]
pub fn load_chat_markdown(
    chat_id: String,
    path: String,
    cfg: State<'_, ConfigState>,
    session: State<'_, SessionState>,
    approval: State<'_, ApprovalState>,
) -> Result<LoadChatResult, String> {
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {}", path, e))?;
    let parsed = parse_chat_markdown(&raw);

    if parsed.messages.is_empty() {
        return Err(format!(
            "no messages found in {} \u{2014} file may not be a Prism chat export",
            path
        ));
    }

    // Replace the session in lockstep:
    //   1. clear (drops any in-memory history)
    //   2. re-prime system prompt
    //   3. append loaded user/assistant messages
    let snapshot = cfg.snapshot();
    session.seed_from_messages(
        &chat_id,
        &snapshot.agent.system_prompt,
        parsed.messages.clone(),
    );
    approval.clear_session(&chat_id);

    Ok(LoadChatResult {
        message_count: parsed.messages.len(),
        title: parsed.frontmatter.title,
        model: parsed.frontmatter.model,
        source_chat_id: parsed.frontmatter.chat_id,
        created: parsed.frontmatter.created,
    })
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/// Pure parser output. Public for unit tests; no Tauri state involved.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ParsedChat {
    pub frontmatter: ChatFrontmatter,
    pub messages: Vec<Message>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ChatFrontmatter {
    pub title: Option<String>,
    pub model: Option<String>,
    pub chat_id: Option<String>,
    pub created: Option<String>,
    /// `"prism-chat-v1"` (or absent) for the legacy clean-transcript
    /// format; `"prism-chat-v2"` for the tool-aware full format that
    /// preserves assistant `tool_calls` + `role=tool` results.
    pub format: Option<String>,
}

/// Parse a chat markdown file into structured form. Always succeeds;
/// missing or malformed pieces fall through to defaults. The parser
/// switches between v1 and v2 modes based on the `format` field in the
/// frontmatter; absent or `prism-chat-v1` \u2192 v1 mode, `prism-chat-v2`
/// \u2192 v2 mode.
pub fn parse_chat_markdown(text: &str) -> ParsedChat {
    let lines: Vec<&str> = text.lines().collect();
    let mut idx = 0usize;

    let frontmatter = if let Some((fm, end)) = parse_frontmatter(&lines, idx) {
        idx = end;
        fm
    } else {
        ChatFrontmatter::default()
    };

    // Skip blank lines + an optional `# Title` heading + blank lines.
    skip_blank(&lines, &mut idx);
    if idx < lines.len() && lines[idx].starts_with("# ") {
        idx += 1;
    }
    skip_blank(&lines, &mut idx);

    let is_v2 = frontmatter.format.as_deref() == Some(FORMAT_V2);
    let messages = if is_v2 {
        parse_message_sections_v2(&lines, idx)
    } else {
        parse_message_sections(&lines, idx)
    };

    ParsedChat {
        frontmatter,
        messages,
    }
}

/// Try to parse a YAML frontmatter block delimited by `---` lines at
/// the very top of the file. Returns the parsed frontmatter and the
/// line index immediately after the closing delimiter, or None when no
/// block is present at the start.
fn parse_frontmatter(
    lines: &[&str],
    start: usize,
) -> Option<(ChatFrontmatter, usize)> {
    if lines.get(start)?.trim() != "---" {
        return None;
    }
    let mut fm = ChatFrontmatter::default();
    let mut i = start + 1;
    while i < lines.len() {
        let line = lines[i];
        if line.trim() == "---" {
            return Some((fm, i + 1));
        }
        if let Some((k, v)) = split_kv(line) {
            let value = unquote(v.trim());
            match k.trim() {
                "title" => fm.title = Some(value),
                "model" => fm.model = Some(value),
                "chat_id" => fm.chat_id = Some(value),
                "created" => fm.created = Some(value),
                "format" => fm.format = Some(value),
                // Any other key (e.g. `messages: 4`) is ignored \u2014 it's
                // metadata for human readers, not load semantics.
                _ => {}
            }
        }
        i += 1;
    }
    // Reached EOF without a closing `---`: not a valid frontmatter
    // block. Treat as no frontmatter so we don't swallow body content.
    None
}

fn split_kv(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    Some((&line[..colon], &line[colon + 1..]))
}

/// Strip surrounding double quotes (and unescape any `\"` and `\\`)
/// from a YAML scalar that may have been quoted by the writer.
fn unquote(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        let inner = &s[1..s.len() - 1];
        // Manually unescape the two sequences `save_chat` produces.
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        return out;
    }
    s.to_string()
}

fn skip_blank(lines: &[&str], idx: &mut usize) {
    while *idx < lines.len() && lines[*idx].trim().is_empty() {
        *idx += 1;
    }
}

/// Walk the remaining lines and collect every `## User` / `## Assistant`
/// section. Bodies run from the line after the heading up to the next
/// heading or EOF, with one trailing `---` separator (and surrounding
/// blank lines) trimmed off.
fn parse_message_sections(lines: &[&str], start: usize) -> Vec<Message> {
    let mut messages: Vec<Message> = Vec::new();
    let mut i = start;
    while i < lines.len() {
        let line = lines[i];
        let role = match heading_role(line) {
            Some(r) => r,
            None => {
                i += 1;
                continue;
            }
        };
        i += 1;
        // Body: collect lines until we hit the next message heading or EOF.
        let body_start = i;
        while i < lines.len() && heading_role(lines[i]).is_none() {
            i += 1;
        }
        let body = trim_message_body(&lines[body_start..i]);
        match role.as_str() {
            "user" => messages.push(Message::user(body)),
            "assistant" => messages.push(Message::assistant(body)),
            // Roles other than user/assistant are tracked verbatim. The
            // `agent_get_history` path filters these out of /history,
            // but persisting them keeps the round-trip honest.
            _ => messages.push(Message {
                role,
                content: Some(body),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }),
        }
    }
    messages
}

/// Recognize a `## Role` heading. Returns the lowercased role name when
/// the line is a level-2 ATX heading, otherwise None. Trailing
/// whitespace is tolerated but a heading with body content on the same
/// line is rejected so `## Steps executed` (build-report style) doesn't
/// accidentally split a chat body. v1 only knows user/assistant.
fn heading_role(line: &str) -> Option<String> {
    let stripped = line.strip_prefix("## ")?;
    let role = stripped.trim().to_lowercase();
    if role == "user" || role == "assistant" {
        Some(role)
    } else {
        None
    }
}

/// v2 variant: also recognises `## Tool` as a role section. Kept
/// separate from `heading_role` so v1 files (which never have `## Tool`
/// from save_chat but might from a user's pasted prose) keep their
/// freeform-body tolerance.
fn heading_role_v2(line: &str) -> Option<String> {
    let stripped = line.strip_prefix("## ")?;
    let role = stripped.trim().to_lowercase();
    match role.as_str() {
        "user" | "assistant" | "tool" => Some(role),
        _ => None,
    }
}

/// v2 walker: collect every `## User` / `## Assistant` / `## Tool`
/// section, parse the leading metadata-comment block (if any), and
/// reconstruct the full `Message` including `tool_calls`, `tool_call_id`,
/// and `name` fields. Anything we can't parse falls back to a
/// content-only message so the round-trip degrades gracefully.
fn parse_message_sections_v2(lines: &[&str], start: usize) -> Vec<Message> {
    let mut messages: Vec<Message> = Vec::new();
    let mut i = start;
    while i < lines.len() {
        let line = lines[i];
        let role = match heading_role_v2(line) {
            Some(r) => r,
            None => {
                i += 1;
                continue;
            }
        };
        i += 1;
        // Body: collect lines until we hit the next message heading or EOF.
        let body_start = i;
        while i < lines.len() && heading_role_v2(lines[i]).is_none() {
            i += 1;
        }
        let raw_body = &lines[body_start..i];
        let (meta, body_text) = extract_prism_meta(raw_body);
        let trimmed = trim_message_body_slice_str(&body_text);
        let msg = match (role.as_str(), meta) {
            ("user", _) => Message::user(trimmed),
            ("assistant", Some(PrismMeta::ToolCalls(calls))) => {
                Message::assistant_tool_calls(trimmed, calls)
            }
            ("assistant", _) => Message::assistant(trimmed),
            ("tool", Some(PrismMeta::ToolResult { tool_call_id, name })) => {
                Message::tool_result(tool_call_id, name, trimmed)
            }
            ("tool", _) => {
                // Tool section without a metadata block: salvage as a
                // tool message with empty call_id rather than dropping.
                // Will be filtered as an orphan by build_out_messages.
                Message::tool_result(String::new(), String::new(), trimmed)
            }
            (other, _) => Message {
                role: other.to_string(),
                content: Some(trimmed),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            },
        };
        messages.push(msg);
    }
    messages
}

/// Decoded `<!--prism:...-->` metadata block.
enum PrismMeta {
    ToolCalls(Vec<ToolCall>),
    ToolResult { tool_call_id: String, name: String },
}

/// Look for a leading `<!--prism:tool-calls\n<json>\n-->` or
/// `<!--prism:tool-result\n<json>\n-->` block at the start of a section
/// body. Returns the decoded metadata (if present) plus the remaining
/// body lines as a String. The metadata block is consumed; everything
/// else is preserved verbatim so the body still round-trips.
fn extract_prism_meta(lines: &[&str]) -> (Option<PrismMeta>, String) {
    let mut i = 0usize;
    while i < lines.len() && lines[i].trim().is_empty() {
        i += 1;
    }
    if i >= lines.len() {
        return (None, lines.join("\n"));
    }
    let header = lines[i].trim();
    let kind = if header == "<!--prism:tool-calls" {
        "tool-calls"
    } else if header == "<!--prism:tool-result" {
        "tool-result"
    } else {
        return (None, lines.join("\n"));
    };
    let payload_start = i + 1;
    let mut j = payload_start;
    while j < lines.len() && lines[j].trim() != "-->" {
        j += 1;
    }
    if j >= lines.len() {
        // Unterminated metadata block; leave body untouched.
        return (None, lines.join("\n"));
    }
    let payload = lines[payload_start..j].join("\n");
    let after = if j + 1 < lines.len() {
        lines[j + 1..].join("\n")
    } else {
        String::new()
    };
    let meta = match kind {
        "tool-calls" => serde_json::from_str::<Vec<ToolCall>>(&payload)
            .ok()
            .map(PrismMeta::ToolCalls),
        "tool-result" => serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| {
                let id = v.get("tool_call_id")?.as_str()?.to_string();
                let name = v.get("name")?.as_str()?.to_string();
                Some(PrismMeta::ToolResult {
                    tool_call_id: id,
                    name,
                })
            }),
        _ => None,
    };
    (meta, after)
}

/// String-input variant of `trim_message_body` for the v2 path \u2014
/// joins lines back into a single string for further trimming and
/// removes a trailing `---` boundary as v1 does.
fn trim_message_body_slice_str(s: &str) -> String {
    let lines: Vec<&str> = s.lines().collect();
    trim_message_body(&lines)
}

/// Trim leading + trailing blank lines, plus a single trailing `---`
/// separator (with adjacent blanks) that `save_chat::render_markdown`
/// emits between messages. A `---` inside the body (e.g. user pasted
/// markdown content) is preserved \u2014 only a `---` that hugs the section
/// boundary is removed.
fn trim_message_body(lines: &[&str]) -> String {
    let mut start = 0usize;
    let mut end = lines.len();
    while start < end && lines[start].trim().is_empty() {
        start += 1;
    }
    while end > start && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    if end > start && lines[end - 1].trim() == "---" {
        end -= 1;
        while end > start && lines[end - 1].trim().is_empty() {
            end -= 1;
        }
    }
    lines[start..end].join("\n")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_CHAT: &str = "---\ntitle: \"Refactor PitchPerfect with StellarumAtlas\"\nmodel: anthropic/claude-haiku-4.5\nchat_id: 11111111-aaaa-bbbb-cccc-222222222222\ncreated: 2026-04-25T12:34:56Z\nmessages: 4\n---\n\n# Refactor PitchPerfect with StellarumAtlas\n\n## User\n\nCan we rework the audit loop?\n\n---\n\n## Assistant\n\nYes \u{2014} here's the plan.\n\n1. Step one\n2. Step two\n\n---\n\n## User\n\nTry --max-rounds=80.\n\n---\n\n## Assistant\n\nDone.\n";

    #[test]
    fn parses_full_round_trip_chat() {
        let parsed = parse_chat_markdown(FULL_CHAT);
        let fm = &parsed.frontmatter;
        assert_eq!(
            fm.title.as_deref(),
            Some("Refactor PitchPerfect with StellarumAtlas")
        );
        assert_eq!(fm.model.as_deref(), Some("anthropic/claude-haiku-4.5"));
        assert_eq!(
            fm.chat_id.as_deref(),
            Some("11111111-aaaa-bbbb-cccc-222222222222")
        );
        assert_eq!(parsed.messages.len(), 4);
        assert_eq!(parsed.messages[0].role, "user");
        assert_eq!(
            parsed.messages[0].content.as_deref(),
            Some("Can we rework the audit loop?")
        );
        assert_eq!(parsed.messages[1].role, "assistant");
        assert!(parsed.messages[1]
            .content
            .as_deref()
            .unwrap()
            .contains("1. Step one"));
        assert_eq!(parsed.messages[3].role, "assistant");
        assert_eq!(parsed.messages[3].content.as_deref(), Some("Done."));
    }

    #[test]
    fn parses_chat_with_no_frontmatter() {
        let src = "## User\n\nhello\n\n## Assistant\n\nhi back\n";
        let parsed = parse_chat_markdown(src);
        assert!(parsed.frontmatter.title.is_none());
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[0].content.as_deref(), Some("hello"));
        assert_eq!(parsed.messages[1].content.as_deref(), Some("hi back"));
    }

    #[test]
    fn preserves_internal_horizontal_rule_inside_message_body() {
        // A `---` inside a body, NOT at the section boundary, must stay.
        let src = "## User\n\nfirst line\n\n---\n\nsecond line\n\n## Assistant\n\nok\n";
        let parsed = parse_chat_markdown(src);
        assert_eq!(parsed.messages.len(), 2);
        let body = parsed.messages[0].content.as_deref().unwrap();
        assert!(
            body.contains("first line") && body.contains("second line"),
            "body should keep both halves, got: {:?}",
            body
        );
    }

    #[test]
    fn ignores_freeform_subheadings_inside_body() {
        // A `## Steps executed` (build report) inside a chat body must NOT
        // be treated as a new role section.
        let src = "## Assistant\n\nHere is a plan:\n\n## Steps executed\n\n- step one\n";
        let parsed = parse_chat_markdown(src);
        assert_eq!(parsed.messages.len(), 1);
        assert_eq!(parsed.messages[0].role, "assistant");
        let body = parsed.messages[0].content.as_deref().unwrap();
        assert!(body.contains("## Steps executed"));
        assert!(body.contains("step one"));
    }

    #[test]
    fn unquotes_yaml_scalar_with_escape_sequence() {
        let src = "---\ntitle: \"He said \\\"hi\\\"\"\n---\n\n## User\n\nhi\n";
        let parsed = parse_chat_markdown(src);
        assert_eq!(parsed.frontmatter.title.as_deref(), Some("He said \"hi\""));
    }

    #[test]
    fn empty_input_yields_no_messages_and_default_frontmatter() {
        let parsed = parse_chat_markdown("");
        assert!(parsed.messages.is_empty());
        assert!(parsed.frontmatter.title.is_none());
    }

    #[test]
    fn unterminated_frontmatter_is_treated_as_no_frontmatter() {
        let src = "---\ntitle: oops\n## User\n\nhello\n";
        let parsed = parse_chat_markdown(src);
        // Without a closing `---`, the block is rejected; the `## User`
        // section is still detectable so we get one message.
        assert!(parsed.frontmatter.title.is_none());
        assert_eq!(parsed.messages.len(), 1);
    }

    #[test]
    fn v2_round_trip_preserves_tool_calls_and_tool_result() {
        // Render via save_chat::render_markdown in v2 mode, parse back
        // here, and verify the full Vec<Message> shape is reconstructed.
        use crate::agent::{ToolCall, ToolCallFunction};
        let calls = vec![ToolCall {
            id: "call_x".into(),
            call_type: "function".into(),
            function: ToolCallFunction {
                name: "read_file".into(),
                arguments: "{\"path\":\"foo.md\"}".into(),
            },
        }];
        let msgs: Vec<Message> = vec![
            Message::user("how many?".to_string()),
            Message::assistant_tool_calls("checking".to_string(), calls.clone()),
            Message::tool_result(
                "call_x".to_string(),
                "read_file".to_string(),
                "file body".to_string(),
            ),
            Message::assistant("7".to_string()),
        ];
        let md = crate::save_chat::render_markdown(
            "chat-1",
            "Round trip",
            "gpt-5.4",
            "prism-chat-v2",
            &msgs,
            true,
        );
        let parsed = parse_chat_markdown(&md);
        assert_eq!(parsed.frontmatter.format.as_deref(), Some("prism-chat-v2"));
        assert_eq!(parsed.messages.len(), 4);
        assert_eq!(parsed.messages[0].role, "user");
        assert_eq!(parsed.messages[0].content.as_deref(), Some("how many?"));
        assert_eq!(parsed.messages[1].role, "assistant");
        assert_eq!(parsed.messages[1].content.as_deref(), Some("checking"));
        let parsed_calls = parsed.messages[1].tool_calls.as_ref().expect("tool_calls should round-trip");
        assert_eq!(parsed_calls.len(), 1);
        assert_eq!(parsed_calls[0].id, "call_x");
        assert_eq!(parsed_calls[0].function.name, "read_file");
        assert_eq!(parsed.messages[2].role, "tool");
        assert_eq!(parsed.messages[2].tool_call_id.as_deref(), Some("call_x"));
        assert_eq!(parsed.messages[2].name.as_deref(), Some("read_file"));
        assert_eq!(parsed.messages[2].content.as_deref(), Some("file body"));
        assert_eq!(parsed.messages[3].role, "assistant");
        assert_eq!(parsed.messages[3].content.as_deref(), Some("7"));
        assert!(parsed.messages[3].tool_calls.is_none());
    }

    #[test]
    fn v1_files_still_parse_when_format_field_is_added_later() {
        // Backward-compat: a file written under v1 (no `format:` field)
        // continues to parse exactly as before. v2 logic must not
        // accidentally activate.
        let parsed = parse_chat_markdown(FULL_CHAT);
        assert!(parsed.frontmatter.format.is_none());
        assert_eq!(parsed.messages.len(), 4);
        assert!(parsed.messages.iter().all(|m| m.tool_calls.is_none()));
        assert!(parsed.messages.iter().all(|m| m.tool_call_id.is_none()));
    }
}
