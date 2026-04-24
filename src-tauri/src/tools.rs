//! Tool definitions and dispatcher for the agent's function-calling loop.
//!
//! Read tools (`read_file`, `list_directory`, `get_cwd`) are auto-approved.
//! Write tools (`write_file`, `edit_file`) currently also auto-execute, but
//! are gated on safety rails (workspace scoping, size caps, atomic writes).
//! The approval UI is the next increment — when it lands, this file's
//! `requires_approval()` helper is the hook the tool loop will check.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// OpenRouter slug for the backing web search model. Hardcoded here since
/// web_search is an internal tool, not a user-facing model choice.
const WEB_SEARCH_MODEL: &str = "perplexity/sonar";
/// Cap what we send back to the primary model so a single web_search call
/// can't blow the context window. Sized so Sonar's typical prose answer
/// plus its tail citations fit comfortably without truncation.
const MAX_WEB_SEARCH_BYTES: usize = 24 * 1024;

/// Maximum bytes returned from a single read_file call. Must be consistent
/// with file_ref.rs's cap so the agent sees the same truncation semantics.
const MAX_FILE_BYTES: usize = 128 * 1024; // 128 KB per tool call (tighter than @file)
const MAX_DIR_ENTRIES: usize = 200;
/// Maximum bytes accepted by write_file / produced by edit_file. Prevents a
/// runaway model from filling disk with a multi-megabyte payload.
const MAX_WRITE_BYTES: usize = 1024 * 1024; // 1 MB

/// Tools that must NOT auto-execute. Consulted by the tool loop in
/// `agent.rs` before each call. Wired to the approval UI.
pub fn requires_approval(tool_name: &str) -> bool {
    matches!(tool_name, "write_file" | "edit_file")
}

/// Generate a human-readable preview of what a write tool would do.
/// Used by the approval UI before executing the call. Returns a
/// plain-text string with optional diff-ish `--- old` / `+++ new`
/// markers that the frontend colorizes.
pub fn preview_write(tool_name: &str, args_json: &str) -> String {
    let parsed: Value = serde_json::from_str(args_json).unwrap_or(Value::Null);
    match tool_name {
        "write_file" => {
            let path = parsed.get("path").and_then(|v| v.as_str()).unwrap_or("?");
            let content = parsed
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            format!(
                "write_file: {}  ({})\n\n{}",
                path,
                format_bytes(content.len() as u64),
                truncate_preview(content, 800),
            )
        }
        "edit_file" => {
            let path = parsed.get("path").and_then(|v| v.as_str()).unwrap_or("?");
            let old = parsed
                .get("old_string")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let new = parsed
                .get("new_string")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let replace_all = parsed
                .get("replace_all")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            format!(
                "edit_file: {}{}\n\n--- old\n{}\n+++ new\n{}",
                path,
                if replace_all { " (replace_all)" } else { "" },
                truncate_preview(old, 400),
                truncate_preview(new, 400),
            )
        }
        _ => args_json.to_string(),
    }
}

fn truncate_preview(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push_str("\n\u{2026}[truncated]");
        out
    }
}

/// JSON schema for all tools, sent to OpenRouter with every request.
pub fn tool_schema() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a text file. Path is resolved relative to the shell's current working directory (or absolute). Files over 128 KB are truncated. Returns an error for binary files.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path to read. Can be relative (README.md), home-relative (~/notes.txt), or absolute (/etc/hosts)."
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "List the entries of a directory. Useful for exploring a project's structure. Returns name and type (file/dir/symlink) for up to 200 entries.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Directory path. Defaults to the shell's cwd if omitted."
                        }
                    },
                    "required": []
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_cwd",
                "description": "Return the shell's current working directory.",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create a new file or overwrite an existing one with the given content. Use this for brand-new files or when the entire contents should be replaced. For small targeted edits, prefer edit_file. Path must be inside the shell's current working directory tree. Content is limited to 1 MB. Parent directories are created automatically.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Destination file path, relative to cwd or absolute (but must resolve under cwd)."
                        },
                        "content": {
                            "type": "string",
                            "description": "Full file contents to write. UTF-8."
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Apply a targeted edit by replacing an exact substring. `old_string` MUST appear exactly once in the file (include enough surrounding context to be unique) unless `replace_all` is true. Errors if old_string is not found or is ambiguous. Prefer this over write_file for small changes \u{2014} it's safer because it forces the model to prove it has the right context.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File to edit. Must exist and be under cwd."
                        },
                        "old_string": {
                            "type": "string",
                            "description": "Exact substring to find. Include enough context to be unique in the file."
                        },
                        "new_string": {
                            "type": "string",
                            "description": "Replacement text."
                        },
                        "replace_all": {
                            "type": "boolean",
                            "description": "If true, replace every occurrence. Defaults to false (requires exactly one match)."
                        }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Perform a live web search via Perplexity Sonar. Use this for questions that require up-to-date information \u{2014} current events, release dates, prices, news, versions of software announced after your training cutoff, pop-up events, schedules, etc. Returns a prose answer grounded in web sources, with inline citations where Sonar provides them. You can call this multiple times in a single turn to refine or cross-reference (e.g. first a broad query, then a narrower follow-up). Do NOT use this for questions about local files or the user's project \u{2014} use read_file / list_directory for those.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural-language search query. Be specific; treat it like a Google-style search rather than a chat question."
                        }
                    },
                    "required": ["query"]
                }
            }
        }
    ])
}

/// Summary of a tool invocation suitable for displaying in xterm.
#[derive(Debug)]
pub struct ToolInvocation {
    /// Whether the call succeeded (for ANSI color decisions on the frontend).
    pub ok: bool,
    /// One-line summary (e.g. "read 1.2 KB", "listed 14 entries", "error: ...")
    pub summary: String,
    /// Full result payload sent back to the LLM (JSON-serialized).
    pub payload: String,
}

/// Execute a tool by name with the given (JSON-string) arguments and cwd.
///
/// The returned `payload` is what we send back to the LLM as the tool result.
/// `summary` is a short human-readable line we print in xterm.
///
/// This is synchronous and covers every filesystem tool. Network-backed
/// tools (currently just `web_search`) have their own async entry point
/// (`execute_web_search`) dispatched by the agent loop.
pub fn execute(name: &str, args_json: &str, cwd: &str) -> ToolInvocation {
    let result: Result<(String, String), String> = match name {
        "read_file" => tool_read_file(args_json, cwd),
        "list_directory" => tool_list_directory(args_json, cwd),
        "get_cwd" => Ok((format!("{}", cwd), json!({ "cwd": cwd }).to_string())),
        "write_file" => tool_write_file(args_json, cwd),
        "edit_file" => tool_edit_file(args_json, cwd),
        "web_search" => Err(
            "web_search is async; dispatch via execute_web_search instead of execute".into(),
        ),
        other => Err(format!("unknown tool: {}", other)),
    };
    match result {
        Ok((summary, payload)) => ToolInvocation { ok: true, summary, payload },
        Err(e) => {
            let payload = json!({ "error": e }).to_string();
            ToolInvocation {
                ok: false,
                summary: format!("error: {}", e),
                payload,
            }
        }
    }
}

/// True iff the tool must be dispatched through the async entry point.
pub fn is_async_tool(name: &str) -> bool {
    matches!(name, "web_search")
}

// ---------------------------------------------------------------------------
// web_search (async \u2014 network-backed)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct WebSearchArgs {
    query: String,
}

#[derive(Serialize)]
struct SonarRequest<'a> {
    model: &'a str,
    messages: Vec<SonarMessage<'a>>,
    stream: bool,
}

#[derive(Serialize)]
struct SonarMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct SonarResponse {
    #[serde(default)]
    choices: Vec<SonarChoice>,
}

#[derive(Deserialize)]
struct SonarChoice {
    message: SonarResponseMessage,
}

#[derive(Deserialize)]
struct SonarResponseMessage {
    #[serde(default)]
    content: String,
}

/// Execute `web_search` by posting the query to perplexity/sonar via
/// OpenRouter. Returns a ToolInvocation whose payload is the prose answer
/// (including whatever inline citations Sonar chose to emit).
///
/// Intentionally does NOT send the full conversation history \u2014 Sonar is
/// a one-shot search backend, not a chat participant. The primary agent
/// model handles synthesis across multiple searches.
pub async fn execute_web_search(
    args_json: &str,
    api_key: &str,
    base_url: &str,
) -> ToolInvocation {
    let args: WebSearchArgs = match serde_json::from_str(args_json) {
        Ok(a) => a,
        Err(e) => return err_invocation(format!("invalid arguments: {}", e)),
    };
    let query = args.query.trim();
    if query.is_empty() {
        return err_invocation("empty query".into());
    }

    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => return err_invocation(format!("http client: {}", e)),
    };

    let body = SonarRequest {
        model: WEB_SEARCH_MODEL,
        messages: vec![SonarMessage {
            role: "user",
            content: query,
        }],
        stream: false,
    };
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let resp = match client
        .post(&url)
        .bearer_auth(api_key)
        .header("HTTP-Referer", "https://prism.local")
        .header("X-Title", "Prism")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return err_invocation(format!("network: {}", e)),
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return err_invocation(format!(
            "Sonar {}: {}",
            status,
            truncate_preview(&text, 400)
        ));
    }

    let parsed: SonarResponse = match resp.json().await {
        Ok(p) => p,
        Err(e) => return err_invocation(format!("parse sonar response: {}", e)),
    };
    let Some(choice) = parsed.choices.into_iter().next() else {
        return err_invocation("sonar returned no choices".into());
    };
    let mut answer = choice.message.content;
    if answer.trim().is_empty() {
        return err_invocation("sonar returned empty answer".into());
    }
    let mut truncated = false;
    if answer.len() > MAX_WEB_SEARCH_BYTES {
        truncated = true;
        answer.truncate(MAX_WEB_SEARCH_BYTES);
        answer.push_str("\n\n[\u{2026} truncated]");
    }
    let summary = format!(
        "searched \"{}\" ({}{})",
        truncate_preview(query, 60),
        format_bytes(answer.len() as u64),
        if truncated { ", truncated" } else { "" }
    );
    let payload = json!({
        "query": query,
        "model": WEB_SEARCH_MODEL,
        "truncated": truncated,
        "answer": answer,
    })
    .to_string();
    ToolInvocation {
        ok: true,
        summary,
        payload,
    }
}

fn err_invocation(msg: String) -> ToolInvocation {
    let payload = json!({ "error": msg }).to_string();
    ToolInvocation {
        ok: false,
        summary: format!("error: {}", msg),
        payload,
    }
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ReadFileArgs {
    path: String,
}

fn tool_read_file(args_json: &str, cwd: &str) -> Result<(String, String), String> {
    let args: ReadFileArgs = serde_json::from_str(args_json)
        .map_err(|e| format!("invalid arguments: {}", e))?;
    let resolved = resolve_path(cwd, &args.path)?;
    let metadata = fs::metadata(&resolved)
        .map_err(|e| format!("cannot stat {}: {}", resolved.display(), e))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", resolved.display()));
    }
    let bytes = fs::read(&resolved)
        .map_err(|e| format!("cannot read {}: {}", resolved.display(), e))?;

    // Binary sniff.
    let sniff_len = bytes.len().min(8 * 1024);
    if bytes[..sniff_len].contains(&0) {
        return Err(format!("{} is a binary file", resolved.display()));
    }

    let mut truncated = false;
    let slice: &[u8] = if bytes.len() > MAX_FILE_BYTES {
        truncated = true;
        &bytes[..MAX_FILE_BYTES]
    } else {
        &bytes
    };
    let mut content = String::from_utf8_lossy(slice).into_owned();
    if truncated {
        content.push_str("\n\n[\u{2026} truncated]\n");
    }

    let size = metadata.len();
    let summary = format!(
        "read {} ({}{})",
        resolved.display(),
        format_bytes(size),
        if truncated { ", truncated" } else { "" }
    );
    let payload = json!({
        "path": resolved.to_string_lossy(),
        "size_bytes": size,
        "truncated": truncated,
        "content": content,
    })
    .to_string();
    Ok((summary, payload))
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ListDirArgs {
    #[serde(default)]
    path: Option<String>,
}

fn tool_list_directory(args_json: &str, cwd: &str) -> Result<(String, String), String> {
    let args: ListDirArgs = if args_json.trim().is_empty() {
        ListDirArgs::default()
    } else {
        serde_json::from_str(args_json).map_err(|e| format!("invalid arguments: {}", e))?
    };
    let raw = args.path.as_deref().unwrap_or(".");
    let resolved = resolve_path(cwd, raw)?;
    let metadata = fs::metadata(&resolved)
        .map_err(|e| format!("cannot stat {}: {}", resolved.display(), e))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", resolved.display()));
    }
    let mut entries: Vec<Value> = Vec::new();
    let mut count = 0usize;
    let mut truncated = false;
    for entry in fs::read_dir(&resolved).map_err(|e| e.to_string())? {
        if count >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        let file_type = entry.file_type().ok();
        let kind = match file_type {
            Some(t) if t.is_dir() => "dir",
            Some(t) if t.is_symlink() => "symlink",
            Some(t) if t.is_file() => "file",
            _ => "other",
        };
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(json!({ "name": name, "type": kind }));
        count += 1;
    }

    let summary = format!(
        "listed {} ({}{})",
        resolved.display(),
        format!("{} entries", entries.len()),
        if truncated { ", truncated" } else { "" }
    );
    let payload = json!({
        "path": resolved.to_string_lossy(),
        "truncated": truncated,
        "entries": entries,
    })
    .to_string();
    Ok((summary, payload))
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct WriteFileArgs {
    path: String,
    content: String,
}

fn tool_write_file(args_json: &str, cwd: &str) -> Result<(String, String), String> {
    let args: WriteFileArgs = serde_json::from_str(args_json)
        .map_err(|e| format!("invalid arguments: {}", e))?;
    if args.content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "content too large ({}); max is {}",
            format_bytes(args.content.len() as u64),
            format_bytes(MAX_WRITE_BYTES as u64)
        ));
    }
    let resolved = resolve_path(cwd, &args.path)?;
    validate_write_path(cwd, &args.path, &resolved)?;

    let existed = resolved.exists();
    let old_size = if existed {
        fs::metadata(&resolved).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    atomic_write(&resolved, args.content.as_bytes())?;

    let new_size = args.content.len() as u64;
    let summary = if existed {
        format!(
            "overwrote {} ({} \u{2192} {})",
            resolved.display(),
            format_bytes(old_size),
            format_bytes(new_size)
        )
    } else {
        format!(
            "created {} ({})",
            resolved.display(),
            format_bytes(new_size)
        )
    };
    let payload = json!({
        "path": resolved.to_string_lossy(),
        "created": !existed,
        "bytes_written": new_size,
        "previous_bytes": old_size,
    })
    .to_string();
    Ok((summary, payload))
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct EditFileArgs {
    path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

fn tool_edit_file(args_json: &str, cwd: &str) -> Result<(String, String), String> {
    let args: EditFileArgs = serde_json::from_str(args_json)
        .map_err(|e| format!("invalid arguments: {}", e))?;
    if args.old_string.is_empty() {
        return Err("old_string must not be empty".into());
    }
    let resolved = resolve_path(cwd, &args.path)?;
    validate_write_path(cwd, &args.path, &resolved)?;

    let metadata = fs::metadata(&resolved)
        .map_err(|e| format!("cannot stat {}: {}", resolved.display(), e))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", resolved.display()));
    }
    let bytes = fs::read(&resolved)
        .map_err(|e| format!("cannot read {}: {}", resolved.display(), e))?;
    let sniff_len = bytes.len().min(8 * 1024);
    if bytes[..sniff_len].contains(&0) {
        return Err(format!("{} is a binary file", resolved.display()));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("{} is not valid UTF-8", resolved.display()))?;

    let match_count = content.matches(&args.old_string).count();
    if match_count == 0 {
        return Err(format!(
            "old_string not found in {}. Include more surrounding context or verify the file was read correctly.",
            resolved.display()
        ));
    }
    if match_count > 1 && !args.replace_all {
        return Err(format!(
            "old_string matches {} times in {}; add more context to make it unique, or set replace_all=true.",
            match_count,
            resolved.display()
        ));
    }
    let new_content = if args.replace_all {
        content.replace(&args.old_string, &args.new_string)
    } else {
        // Exactly-one case: safe to use replacen with 1.
        content.replacen(&args.old_string, &args.new_string, 1)
    };
    if new_content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "post-edit size ({}) exceeds max ({}); edit rejected.",
            format_bytes(new_content.len() as u64),
            format_bytes(MAX_WRITE_BYTES as u64)
        ));
    }
    let replacements = if args.replace_all { match_count } else { 1 };
    atomic_write(&resolved, new_content.as_bytes())?;

    let summary = format!(
        "edited {} ({} replacement{})",
        resolved.display(),
        replacements,
        if replacements == 1 { "" } else { "s" }
    );
    let payload = json!({
        "path": resolved.to_string_lossy(),
        "replacements": replacements,
        "bytes_before": content.len(),
        "bytes_after": new_content.len(),
    })
    .to_string();
    Ok((summary, payload))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Write `bytes` to `path` atomically (tmp + rename). Creates parent dirs.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    if !parent.as_os_str().is_empty() && !parent.exists() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
    }
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    // Put the tmp file in the destination directory so rename is atomic on
    // the same filesystem. Dotted prefix keeps it out of casual ls output.
    let tmp = parent.join(format!(".{}.prism-tmp", file_name));
    fs::write(&tmp, bytes)
        .map_err(|e| format!("cannot write {}: {}", tmp.display(), e))?;
    if let Err(e) = fs::rename(&tmp, path) {
        // Best-effort cleanup of tmp on rename failure.
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot rename into {}: {}", path.display(), e));
    }
    Ok(())
}

/// Verify a resolved write target is safe: inside the shell's cwd subtree,
/// and the raw input path contains no `..` components. Symlinks inside cwd
/// are resolved and re-checked so a symlink to /etc doesn't slip through.
fn validate_write_path(cwd: &str, raw: &str, resolved: &Path) -> Result<(), String> {
    if cwd.is_empty() {
        return Err("cannot write: shell cwd is unknown (shell integration may not be started)".into());
    }
    if Path::new(raw)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!(
            "refusing to write to a path containing `..` ({}). Use an explicit path under the workspace.",
            raw
        ));
    }
    let cwd_canon = Path::new(cwd)
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize cwd {}: {}", cwd, e))?;
    // For non-existent targets, canonicalize the nearest existing ancestor
    // (walking up the path tree) so symlinks in the middle are resolved.
    let anchor_canon = resolved
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(|| format!("no existing ancestor for {}", resolved.display()))?
        .canonicalize()
        .map_err(|e| format!("canonicalize ancestor: {}", e))?;
    if !anchor_canon.starts_with(&cwd_canon) {
        return Err(format!(
            "refusing to write outside workspace ({} is not under {})",
            resolved.display(),
            cwd_canon.display()
        ));
    }
    Ok(())
}

fn resolve_path(cwd: &str, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty path".into());
    }
    let buf = if let Some(rest) = raw.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or("no home dir")?;
        home.join(rest)
    } else if raw == "~" {
        dirs::home_dir().ok_or("no home dir")?
    } else if std::path::Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        if cwd.is_empty() {
            return Err("cwd unknown".into());
        }
        PathBuf::from(cwd).join(raw)
    };
    Ok(buf.canonicalize().unwrap_or(buf))
}

fn format_bytes(n: u64) -> String {
    if n < 1024 {
        format!("{} B", n)
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_tmp() -> PathBuf {
        let dir = env::temp_dir().join(format!("prism-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create tmp dir");
        // Canonicalize so tests compare against the same form validate_write_path uses.
        fs::canonicalize(&dir).expect("canonicalize tmp")
    }

    fn cwd_of(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn write_file_creates_new_file() {
        let dir = fresh_tmp();
        let inv = execute(
            "write_file",
            &json!({ "path": "hello.txt", "content": "hi" }).to_string(),
            &cwd_of(&dir),
        );
        assert!(inv.ok, "failed: {}", inv.summary);
        assert_eq!(fs::read_to_string(dir.join("hello.txt")).unwrap(), "hi");
    }

    #[test]
    fn write_file_creates_parent_dirs() {
        let dir = fresh_tmp();
        let inv = execute(
            "write_file",
            &json!({ "path": "a/b/c.txt", "content": "nested" }).to_string(),
            &cwd_of(&dir),
        );
        assert!(inv.ok, "failed: {}", inv.summary);
        assert_eq!(fs::read_to_string(dir.join("a/b/c.txt")).unwrap(), "nested");
    }

    #[test]
    fn write_file_overwrites_existing() {
        let dir = fresh_tmp();
        fs::write(dir.join("f.txt"), "old").unwrap();
        let inv = execute(
            "write_file",
            &json!({ "path": "f.txt", "content": "new" }).to_string(),
            &cwd_of(&dir),
        );
        assert!(inv.ok, "failed: {}", inv.summary);
        assert_eq!(fs::read_to_string(dir.join("f.txt")).unwrap(), "new");
    }

    #[test]
    fn write_file_rejects_parent_dir_escape() {
        let dir = fresh_tmp();
        let inv = execute(
            "write_file",
            &json!({ "path": "../escape.txt", "content": "x" }).to_string(),
            &cwd_of(&dir),
        );
        assert!(!inv.ok, "should reject ..: {}", inv.summary);
    }

    #[test]
    fn write_file_rejects_absolute_path_outside_cwd() {
        let inside = fresh_tmp();
        let outside = fresh_tmp();
        let target = outside.join("x.txt").to_string_lossy().to_string();
        let inv = execute(
            "write_file",
            &json!({ "path": target, "content": "x" }).to_string(),
            &cwd_of(&inside),
        );
        assert!(!inv.ok, "should reject outside-cwd: {}", inv.summary);
    }

    #[test]
    fn write_file_does_not_leave_tmp_on_success() {
        let dir = fresh_tmp();
        let inv = execute(
            "write_file",
            &json!({ "path": "t.txt", "content": "x" }).to_string(),
            &cwd_of(&dir),
        );
        assert!(inv.ok);
        // No .t.txt.prism-tmp left behind.
        let tmp = dir.join(".t.txt.prism-tmp");
        assert!(!tmp.exists(), "tmp leaked: {}", tmp.display());
    }

    #[test]
    fn edit_file_replaces_unique_match() {
        let dir = fresh_tmp();
        fs::write(dir.join("a.txt"), "foo bar baz").unwrap();
        let inv = execute(
            "edit_file",
            &json!({
                "path": "a.txt",
                "old_string": "bar",
                "new_string": "BAR"
            })
            .to_string(),
            &cwd_of(&dir),
        );
        assert!(inv.ok, "failed: {}", inv.summary);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "foo BAR baz");
    }

    #[test]
    fn edit_file_rejects_zero_matches() {
        let dir = fresh_tmp();
        fs::write(dir.join("a.txt"), "foo").unwrap();
        let inv = execute(
            "edit_file",
            &json!({
                "path": "a.txt",
                "old_string": "missing",
                "new_string": "x"
            })
            .to_string(),
            &cwd_of(&dir),
        );
        assert!(!inv.ok);
        assert!(
            inv.summary.to_lowercase().contains("not found"),
            "unexpected summary: {}",
            inv.summary
        );
    }

    #[test]
    fn edit_file_rejects_multiple_matches_without_replace_all() {
        let dir = fresh_tmp();
        fs::write(dir.join("a.txt"), "x x x").unwrap();
        let inv = execute(
            "edit_file",
            &json!({
                "path": "a.txt",
                "old_string": "x",
                "new_string": "y"
            })
            .to_string(),
            &cwd_of(&dir),
        );
        assert!(!inv.ok);
        assert!(
            inv.summary.contains("3 times"),
            "unexpected summary: {}",
            inv.summary
        );
        // File must be untouched.
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "x x x");
    }

    #[test]
    fn edit_file_replace_all_allows_multiple_matches() {
        let dir = fresh_tmp();
        fs::write(dir.join("a.txt"), "x x x").unwrap();
        let inv = execute(
            "edit_file",
            &json!({
                "path": "a.txt",
                "old_string": "x",
                "new_string": "y",
                "replace_all": true
            })
            .to_string(),
            &cwd_of(&dir),
        );
        assert!(inv.ok, "failed: {}", inv.summary);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "y y y");
    }

    #[test]
    fn edit_file_rejects_empty_old_string() {
        let dir = fresh_tmp();
        fs::write(dir.join("a.txt"), "foo").unwrap();
        let inv = execute(
            "edit_file",
            &json!({
                "path": "a.txt",
                "old_string": "",
                "new_string": "x"
            })
            .to_string(),
            &cwd_of(&dir),
        );
        assert!(!inv.ok);
    }

    #[test]
    fn requires_approval_matches_writers() {
        assert!(requires_approval("write_file"));
        assert!(requires_approval("edit_file"));
        assert!(!requires_approval("read_file"));
        assert!(!requires_approval("list_directory"));
        assert!(!requires_approval("get_cwd"));
    }
}
