//! LSP substrate cell (substrate v5).
//!
//! A generic Language Server Protocol client used by `/audit` and `/build`
//! to gather richer, language-agnostic diagnostics than the bare compiler
//! command produces. The cell:
//!
//!   1. Detects (or accepts an override for) which LSP server to spawn,
//!      based on project shape (Cargo.toml → rust-analyzer, pyproject.toml
//!      → pyright-langserver, go.mod → gopls, tsconfig.json/package.json
//!      → typescript-language-server).
//!   2. Spawns the server, performs the LSP `initialize` handshake, opens
//!      the requested files via `textDocument/didOpen`, and collects every
//!      `textDocument/publishDiagnostics` notification the server emits.
//!   3. Shuts the server down cleanly (`shutdown` → `exit`) and returns
//!      the diagnostics as our unified `Diagnostic` shape with
//!      `source = "lsp"`. The grader treats LSP evidence as confirmed.
//!
//! Design rules (mirrors the rest of `diagnostics.rs`):
//!   - Substrate calls are deterministic for a given repo state. The LLM
//!     does not influence what they return.
//!   - Read-only: opens documents in-memory; no filesystem writes.
//!   - Caps: `MAX_DIAGNOSTICS` total across all files; `LSP_QUIET_*` for
//!     when "we've heard enough" so the server's incremental analysis
//!     doesn't make the cell run forever.
//!   - Transport failures (server didn't start, init timed out, server
//!     crashed) are surfaced as `Err` so the agent can decide what to do
//!     instead of being silently treated as "no diagnostics".

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::diagnostics::{Diagnostic, Severity};

/// Hard cap on diagnostics returned to the LLM in one call. A noisy
/// rust-analyzer pass can otherwise emit hundreds of style-level
/// warnings; we'd rather truncate than blow the context window.
const MAX_DIAGNOSTICS: usize = 200;

/// Maximum bytes of raw stderr from the LSP server we forward to the
/// caller. Servers occasionally print useful diagnostics on stderr
/// (e.g. "no project found") that aren't part of the LSP stream; we
/// surface a slice so the model can interpret startup failures.
const MAX_RAW_BYTES: usize = 8 * 1024;

/// Default per-call timeout. LSP analysis is incremental, so we have to
/// pick a reasonable budget: long enough for rust-analyzer to chew on
/// a medium project, short enough that a hung server doesn't stall the
/// agent indefinitely. Configurable via `agent.lsp_timeout_secs`.
pub const DEFAULT_LSP_TIMEOUT_SECS: u64 = 30;

/// After receiving the initialize response, wait at most this long for
/// each round of diagnostics to settle. If no new messages arrive in this
/// window AND we've received at least one publishDiagnostics, return.
const LSP_QUIET_AFTER_DIAG_MS: u64 = 1500;

/// If the server hasn't published any diagnostics by this point, give it
/// a longer settling window before declaring "no diagnostics found". Some
/// servers analyze for several seconds before emitting anything.
const LSP_QUIET_NO_DIAG_MS: u64 = 4000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Outcome of one `lsp_diagnostics` substrate call. Mirrors
/// `DiagnosticRun` but adds an `lsp_server` label so the model knows
/// which server produced the evidence.
#[derive(Debug, Clone, Serialize)]
pub struct LspRun {
    /// argv that was actually executed (after detection / overrides).
    pub command: Vec<String>,
    /// e.g. "rust-analyzer", "pyright-langserver", or "lsp".
    pub server: String,
    /// True iff the LSP handshake completed successfully.
    pub initialized: bool,
    pub duration_ms: u128,
    pub diagnostics: Vec<Diagnostic>,
    /// True iff `diagnostics` was capped at `MAX_DIAGNOSTICS`.
    pub diagnostics_truncated: bool,
    /// Any stderr / unparseable output from the server, capped.
    pub raw: String,
    pub raw_truncated: bool,
    /// True iff we hit the timeout before the server went quiet.
    pub timed_out: bool,
}

/// Translate an `LspRun` into the JSON payload sent back to the LLM.
/// Mirrors `diagnostics::to_finding_payload` so the audit consumer can
/// treat both substrate cells uniformly. Each diagnostic carries the
/// `evidence_detail` line the model can paste verbatim into a
/// Finding's `evidence: source=lsp; detail=\u{2026}` stanza.
pub fn to_lsp_payload(run: &LspRun) -> Value {
    let diagnostics: Vec<Value> = run
        .diagnostics
        .iter()
        .map(|d| {
            let severity = match d.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
                Severity::Info => "info",
            };
            let evidence_detail = format!(
                "lsp ({}): {} {}{} {}",
                run.server,
                severity,
                d.file,
                if d.line > 0 {
                    format!(":{}", d.line)
                } else {
                    String::new()
                },
                d.message,
            );
            json!({
                "source": d.source,
                "file": d.file,
                "line": d.line,
                "col": d.col,
                "severity": severity,
                "code": d.code,
                "message": d.message,
                "confidence": "confirmed",
                "evidence": [
                    {
                        "source": "lsp",
                        "detail": evidence_detail,
                    }
                ],
            })
        })
        .collect();
    json!({
        "command": run.command,
        "server": run.server,
        "initialized": run.initialized,
        "duration_ms": run.duration_ms,
        "diagnostics": diagnostics,
        "diagnostics_truncated": run.diagnostics_truncated,
        "raw": run.raw,
        "raw_truncated": run.raw_truncated,
        "timed_out": run.timed_out,
    })
}

/// Specification for an LSP server: what argv to spawn and which short
/// label to attach to its diagnostics. Detection narrows from project
/// shape; users can override via `agent.lsp_command` in config.
#[derive(Debug, Clone)]
pub struct LspSpec {
    pub server: String,
    pub argv: Vec<String>,
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Pick a sensible LSP server for `cwd`. Returns None if nothing matches
/// or the relevant binary isn't on PATH; the caller surfaces that as a
/// clean error so the user can install / configure the server manually.
pub fn detect_lsp_command(cwd: &Path) -> Option<LspSpec> {
    // Order: most-specific signal first. A repo with both Cargo.toml and
    // a tsconfig.json (this very repo, in fact) is overwhelmingly Rust
    // for LSP purposes — rust-analyzer covers way more diagnostics than
    // typescript-language-server here.
    if cwd.join("Cargo.toml").is_file() {
        if which_simple("rust-analyzer").is_some() {
            return Some(LspSpec {
                server: "rust-analyzer".into(),
                argv: vec!["rust-analyzer".into()],
            });
        }
    }
    if cwd.join("go.mod").is_file() {
        if which_simple("gopls").is_some() {
            return Some(LspSpec {
                server: "gopls".into(),
                argv: vec!["gopls".into()],
            });
        }
    }
    if cwd.join("pyproject.toml").is_file()
        || cwd.join("requirements.txt").is_file()
        || cwd.join("setup.py").is_file()
    {
        // Prefer pyright-langserver when both are installed: it produces
        // richer diagnostics than pylsp for typed Python.
        if let Some(_) = which_simple("pyright-langserver") {
            return Some(LspSpec {
                server: "pyright-langserver".into(),
                argv: vec![
                    "pyright-langserver".into(),
                    "--stdio".into(),
                ],
            });
        }
        if let Some(_) = which_simple("pylsp") {
            return Some(LspSpec {
                server: "pylsp".into(),
                argv: vec!["pylsp".into()],
            });
        }
    }
    if cwd.join("tsconfig.json").is_file() || cwd.join("package.json").is_file() {
        let local_bin = cwd.join("node_modules/.bin/typescript-language-server");
        if local_bin.is_file() {
            return Some(LspSpec {
                server: "typescript-language-server".into(),
                argv: vec![
                    local_bin.to_string_lossy().into(),
                    "--stdio".into(),
                ],
            });
        }
        if let Some(_) = which_simple("typescript-language-server") {
            return Some(LspSpec {
                server: "typescript-language-server".into(),
                argv: vec![
                    "typescript-language-server".into(),
                    "--stdio".into(),
                ],
            });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run an LSP diagnostic pass against `cwd`. `files` is the list of
/// project-relative (or absolute) paths to open with `didOpen`; if empty,
/// the cell opens nothing and just collects whatever the server pushes
/// after `initialized` (some servers do project-wide analysis on init).
///
/// `override_argv` (from config or per-call args) wins over the auto-
/// detect branches in `detect_lsp_command`.
pub fn run_lsp_diagnostics(
    cwd: &str,
    files: &[String],
    override_argv: Option<&[String]>,
    override_server_label: Option<&str>,
    timeout: Option<Duration>,
) -> Result<LspRun, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is unknown (shell integration may not be started)".into());
    }
    let cwd_path = Path::new(cwd);

    // -----------------------------------------------------------------------
    // PATH GUARD: Shield internal binaries from agent gaze.
    // -----------------------------------------------------------------------
    let path_str = cwd_path.to_string_lossy();
    if path_str.contains("/Applications/Prism.app") {
        return Err("Access Denied: Self-inspection of Prism binary is forbidden".into());
    }
    for f in files {
        if f.contains("/Applications/Prism.app") {
            return Err("Access Denied: Path is forbidden".into());
        }
    }

    let spec = match override_argv {
        Some(argv) => {
            crate::diagnostics::validate_argv_public(argv)?;
            LspSpec {
                server: override_server_label
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        Path::new(&argv[0])
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("lsp")
                            .to_string()
                    }),
                argv: argv.to_vec(),
            }
        }
        None => detect_lsp_command(cwd_path).ok_or_else(|| {
            "no LSP server detected; install rust-analyzer / pyright-langserver / gopls / \
             typescript-language-server, or set `agent.lsp_command` in config"
                .to_string()
        })?,
    };

    let timeout = timeout.unwrap_or(Duration::from_secs(DEFAULT_LSP_TIMEOUT_SECS));

    let started = Instant::now();
    let mut child = Command::new(&spec.argv[0])
        .args(&spec.argv[1..])
        .current_dir(cwd_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {:?}: {}", spec.argv[0], e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to acquire LSP server stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to acquire LSP server stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to acquire LSP server stderr".to_string())?;

    // Drain stderr on a background thread so the server doesn't block on
    // a full pipe. We collect up to MAX_RAW_BYTES for the model to read
    // when a startup failure produces only stderr output.
    let stderr_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_buf_thread = Arc::clone(&stderr_buf);
    let stderr_thread = thread::spawn(move || {
        let mut chunk = [0u8; 4 * 1024];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let mut guard = stderr_buf_thread.lock().expect("stderr buf");
                    if guard.len() < MAX_RAW_BYTES {
                        let take = (MAX_RAW_BYTES - guard.len()).min(n);
                        guard.extend_from_slice(&chunk[..take]);
                    }
                }
                Err(_) => break,
            }
        }
    });

    let session_result = run_lsp_session(
        cwd_path,
        files,
        stdin,
        stdout,
        timeout,
        &spec.server,
    );

    // Best-effort cleanup: shutdown was attempted inside the session, so
    // here we just make sure the process is gone before we return.
    let _ = child.kill();
    let _ = child.wait();
    let _ = stderr_thread.join();

    let stderr_bytes = stderr_buf.lock().expect("stderr buf").clone();
    let raw = String::from_utf8_lossy(&stderr_bytes).into_owned();
    let raw_truncated = stderr_bytes.len() >= MAX_RAW_BYTES;

    let duration_ms = started.elapsed().as_millis();

    match session_result {
        Ok((diagnostics, initialized, timed_out)) => {
            let diagnostics_truncated = diagnostics.len() > MAX_DIAGNOSTICS;
            let mut diagnostics = diagnostics;
            if diagnostics_truncated {
                diagnostics.truncate(MAX_DIAGNOSTICS);
            }
            Ok(LspRun {
                command: spec.argv,
                server: spec.server,
                initialized,
                duration_ms,
                diagnostics,
                diagnostics_truncated,
                raw,
                raw_truncated,
                timed_out,
            })
        }
        Err(e) => Err(format!(
            "{} ({}{})",
            e,
            spec.server,
            if raw.is_empty() {
                String::new()
            } else {
                format!("; stderr: {}", crate::diagnostics::truncate_for_log(&raw, 200))
            }
        )),
    }
}

// ---------------------------------------------------------------------------
// Session orchestration
// ---------------------------------------------------------------------------

/// One LSP session: handshake + open files + collect diagnostics +
/// graceful shutdown. Generic over the reader/writer so tests can drive
/// the protocol without spawning a real subprocess.
///
/// Returns (diagnostics, initialized, timed_out). `initialized=false`
/// means the server didn't respond to the `initialize` request within
/// the budget.
pub fn run_lsp_session<R, W>(
    cwd: &Path,
    files: &[String],
    writer: W,
    reader: R,
    timeout: Duration,
    _server_label: &str,
) -> Result<(Vec<Diagnostic>, bool, bool), String>
where
    R: Read + Send + 'static,
    W: Write,
{
    let mut writer = writer;
    let deadline = Instant::now() + timeout;
    let (tx, rx) = mpsc::channel::<Result<Value, String>>();
    // Spawn a reader thread that frames messages off the wire and pushes
    // them onto a channel. The thread exits when the reader hits EOF,
    // which happens when we close stdin and the server exits.
    let reader_handle = thread::spawn(move || {
        let mut reader = reader;
        loop {
            match read_message(&mut reader) {
                Ok(msg) => {
                    if tx.send(Ok(msg)).is_err() {
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                    return;
                }
            }
        }
    });

    // 1. Send initialize request.
    let mut next_id: u64 = 1;
    let init_id = next_id;
    next_id += 1;
    let cwd_uri = path_to_uri(cwd);
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "processId": std::process::id(),
            "rootUri": cwd_uri,
            "capabilities": {
                "textDocument": {
                    "publishDiagnostics": {
                        "relatedInformation": false,
                        "versionSupport": false,
                        "tagSupport": { "valueSet": [] }
                    },
                    "synchronization": {
                        "didOpen": true
                    }
                },
                "workspace": {
                    "workspaceFolders": true,
                    "configuration": true
                }
            },
            "initializationOptions": null,
            "workspaceFolders": [
                {
                    "uri": cwd_uri,
                    "name": cwd.file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("workspace")
                }
            ]
        }
    });
    write_message(&mut writer, &init_req)
        .map_err(|e| format!("send initialize: {}", e))?;

    // 2. Wait for initialize response (must come back with id == init_id).
    let mut diagnostics_by_uri: HashMap<String, Vec<Diagnostic>> = HashMap::new();
    let mut initialized = false;
    let init_deadline = Instant::now() + Duration::from_secs(10).min(timeout);
    while Instant::now() < init_deadline {
        let remaining = init_deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(Ok(msg)) => {
                if msg.get("method").is_some() {
                    // Server-initiated request or notification. We just
                    // need to handle ones that block startup; ignore the
                    // rest until init completes.
                    handle_server_request_or_notification(
                        &msg,
                        &mut writer,
                        &mut diagnostics_by_uri,
                    );
                    continue;
                }
                if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                    if id == init_id {
                        initialized = true;
                        break;
                    }
                }
            }
            Ok(Err(e)) => {
                let _ = reader_handle.join();
                return Err(format!("read during initialize: {}", e));
            }
            Err(_) => break,
        }
    }
    if !initialized {
        // Try to drive shutdown anyway so we don't leave the server hung.
        let _ = write_message(
            &mut writer,
            &json!({ "jsonrpc": "2.0", "method": "exit" }),
        );
        let _ = reader_handle.join();
        return Ok((flatten(diagnostics_by_uri), false, true));
    }

    // 3. Send `initialized` notification.
    write_message(
        &mut writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        }),
    )
    .map_err(|e| format!("send initialized: {}", e))?;

    // 4. didOpen each requested file.
    for f in files {
        let abs = if Path::new(f).is_absolute() {
            PathBuf::from(f)
        } else {
            cwd.join(f)
        };
        let text = std::fs::read_to_string(&abs).unwrap_or_default();
        let language_id = guess_language_id(&abs);
        let uri = path_to_uri(&abs);
        let did_open = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": 1,
                    "text": text
                }
            }
        });
        if let Err(e) = write_message(&mut writer, &did_open) {
            let _ = reader_handle.join();
            return Err(format!("send didOpen for {}: {}", abs.display(), e));
        }
    }

    // 5. Collect publishDiagnostics until we hit a quiet window.
    let mut last_message_at = Instant::now();
    let mut received_any_diag = false;
    let mut timed_out = false;
    loop {
        let now = Instant::now();
        if now >= deadline {
            timed_out = true;
            break;
        }
        let quiet_window = if received_any_diag {
            Duration::from_millis(LSP_QUIET_AFTER_DIAG_MS)
        } else {
            Duration::from_millis(LSP_QUIET_NO_DIAG_MS)
        };
        let since_last = now.saturating_duration_since(last_message_at);
        if since_last >= quiet_window {
            break;
        }
        let wait = (quiet_window - since_last).min(deadline - now);
        match rx.recv_timeout(wait) {
            Ok(Ok(msg)) => {
                last_message_at = Instant::now();
                if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
                    if method == "textDocument/publishDiagnostics" {
                        received_any_diag = true;
                        if let Some((uri, diags)) = parse_publish_diagnostics(&msg) {
                            diagnostics_by_uri.insert(uri, diags);
                        }
                    } else {
                        handle_server_request_or_notification(
                            &msg,
                            &mut writer,
                            &mut diagnostics_by_uri,
                        );
                    }
                }
                // Server responses to our requests (with `id`) are
                // currently ignored; only initialize is correlated.
            }
            Ok(Err(_)) => {
                // Reader hit EOF or framing error; assume the server
                // closed and stop waiting for more diagnostics.
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Loop and re-evaluate quiet window.
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // 6. Graceful shutdown. If the server doesn't respond, we still
    //    return what we collected — the caller will kill the process.
    let shutdown_id = next_id;
    let _ = write_message(
        &mut writer,
        &json!({
            "jsonrpc": "2.0",
            "id": shutdown_id,
            "method": "shutdown"
        }),
    );
    // Wait briefly for the shutdown response, then send `exit`.
    let shutdown_deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < shutdown_deadline {
        let remaining = shutdown_deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(Ok(msg)) => {
                if msg.get("id").and_then(|v| v.as_u64()) == Some(shutdown_id) {
                    break;
                }
            }
            _ => break,
        }
    }
    let _ = write_message(
        &mut writer,
        &json!({ "jsonrpc": "2.0", "method": "exit" }),
    );

    // Drop the writer so stdin closes; the reader thread will exit.
    drop(writer);
    let _ = reader_handle.join();

    Ok((flatten(diagnostics_by_uri), true, timed_out))
}

/// Handle the small set of server-initiated messages that block startup
/// or that we want to silently acknowledge so the server doesn't hang.
fn handle_server_request_or_notification(
    msg: &Value,
    writer: &mut impl Write,
    diagnostics_by_uri: &mut HashMap<String, Vec<Diagnostic>>,
) {
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let id = msg.get("id");
    match method {
        "textDocument/publishDiagnostics" => {
            if let Some((uri, diags)) = parse_publish_diagnostics(msg) {
                diagnostics_by_uri.insert(uri, diags);
            }
        }
        "workspace/configuration" if id.is_some() => {
            // Reply with an array of nulls — one per requested item — so
            // servers like rust-analyzer/pyright don't block.
            let items_len = msg
                .get("params")
                .and_then(|p| p.get("items"))
                .and_then(|i| i.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let nulls: Vec<Value> = (0..items_len.max(1)).map(|_| Value::Null).collect();
            let _ = write_message(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": nulls,
                }),
            );
        }
        "client/registerCapability" | "client/unregisterCapability" if id.is_some() => {
            let _ = write_message(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": null,
                }),
            );
        }
        "window/workDoneProgress/create" if id.is_some() => {
            let _ = write_message(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": null,
                }),
            );
        }
        _ => {
            // Unknown server-side request: respond with a method-not-found
            // error so the server doesn't hang waiting on us.
            if id.is_some() {
                let _ = write_message(
                    writer,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32601,
                            "message": "method not handled by Prism LSP client"
                        }
                    }),
                );
            }
        }
    }
}

fn flatten(by_uri: HashMap<String, Vec<Diagnostic>>) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    for (_, mut v) in by_uri {
        out.append(&mut v);
    }
    // Stable order: by file then line. Diagnostics from a HashMap are
    // otherwise non-deterministic, which would make tests flaky.
    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    out
}

/// Parse a `textDocument/publishDiagnostics` notification into the
/// substrate's unified `Diagnostic` shape.
fn parse_publish_diagnostics(msg: &Value) -> Option<(String, Vec<Diagnostic>)> {
    let params = msg.get("params")?;
    let uri = params.get("uri").and_then(|v| v.as_str())?.to_string();
    let file = uri_to_file(&uri);
    let arr = params.get("diagnostics").and_then(|v| v.as_array())?;
    let mut out = Vec::with_capacity(arr.len());
    for d in arr {
        let line = d
            .get("range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("line"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32 + 1)
            .unwrap_or(0);
        let col = d
            .get("range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("character"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32 + 1)
            .unwrap_or(0);
        let severity = match d.get("severity").and_then(|v| v.as_u64()).unwrap_or(1) {
            1 => Severity::Error,
            2 => Severity::Warning,
            _ => Severity::Info,
        };
        let code = d
            .get("code")
            .and_then(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            })
            .unwrap_or_default();
        let message = d
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out.push(Diagnostic {
            source: "lsp".into(),
            file: file.clone(),
            line,
            col,
            severity,
            code,
            message,
        });
    }
    Some((uri, out))
}

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

/// Read one Content-Length-framed JSON-RPC message from `reader`.
/// Errors with a string message on framing or JSON parse failure; on
/// EOF the inner io::Error is mapped to a clean string so the session
/// loop can detect "server exited" as a natural terminator.
pub(crate) fn read_message<R: Read>(reader: &mut R) -> Result<Value, String> {
    // Read the header line by line until we hit a blank line.
    let mut header = Vec::with_capacity(64);
    let mut content_length: Option<usize> = None;
    loop {
        let mut byte = [0u8; 1];
        let n = reader
            .read(&mut byte)
            .map_err(|e| format!("read header: {}", e))?;
        if n == 0 {
            return Err("EOF in LSP header".into());
        }
        header.push(byte[0]);
        if header.ends_with(b"\r\n") {
            if header.len() == 2 {
                // Empty line — header terminator.
                break;
            }
            let line = String::from_utf8_lossy(&header[..header.len() - 2]).to_string();
            if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                let n: usize = rest
                    .trim()
                    .parse()
                    .map_err(|e| format!("invalid Content-Length: {}", e))?;
                content_length = Some(n);
            }
            header.clear();
        }
    }
    let n = content_length.ok_or_else(|| "missing Content-Length header".to_string())?;
    let mut body = vec![0u8; n];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("read body: {}", e))?;
    serde_json::from_slice::<Value>(&body).map_err(|e| format!("parse body: {}", e))
}

/// Write one Content-Length-framed JSON-RPC message to `writer`.
pub(crate) fn write_message<W: Write>(writer: &mut W, msg: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(msg).expect("serialize JSON value");
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn guess_language_id(path: &Path) -> String {
    match path.extension().and_then(|s| s.to_str()) {
        Some("rs") => "rust".into(),
        Some("ts") => "typescript".into(),
        Some("tsx") => "typescriptreact".into(),
        Some("js") | Some("mjs") | Some("cjs") => "javascript".into(),
        Some("jsx") => "javascriptreact".into(),
        Some("py") => "python".into(),
        Some("go") => "go".into(),
        Some("rb") => "ruby".into(),
        Some("java") => "java".into(),
        Some(other) => other.to_string(),
        None => "plaintext".into(),
    }
}

/// Convert a filesystem path into a `file://` URI. Best-effort: we don't
/// percent-encode every character — LSP servers tolerate raw paths just
/// fine for the project roots we work with.
fn path_to_uri(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{}", s)
    } else {
        format!("file:///{}", s)
    }
}

fn uri_to_file(uri: &str) -> String {
    if let Some(rest) = uri.strip_prefix("file://") {
        // strip leading '/' on Windows-style file:///C:/... when present
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        // Re-add the leading '/' on UNIX paths so consumers get an
        // absolute path back, matching what their compiler diagnostics
        // emit.
        if rest.starts_with(|c: char| c.is_ascii_alphabetic())
            && rest.chars().nth(1) == Some(':')
        {
            // Looks Windows-y; leave as-is.
            rest.to_string()
        } else {
            format!("/{}", rest)
        }
    } else {
        uri.to_string()
    }
}

/// Tiny `which` clone that avoids pulling in another dependency. Mirrors
/// the helper in `diagnostics.rs` but lives here to keep this module
/// self-contained.
fn which_simple(prog: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(prog);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn write_and_read_message_round_trip() {
        let mut buf: Vec<u8> = Vec::new();
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" });
        write_message(&mut buf, &msg).expect("write");
        let mut reader = Cursor::new(buf);
        let parsed = read_message(&mut reader).expect("read");
        assert_eq!(parsed, msg);
    }

    #[test]
    fn read_message_handles_lowercase_header() {
        let payload = b"{\"jsonrpc\":\"2.0\",\"id\":2}";
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(b"content-length: ");
        bytes.extend_from_slice(payload.len().to_string().as_bytes());
        bytes.extend_from_slice(b"\r\n\r\n");
        bytes.extend_from_slice(payload);
        let mut reader = Cursor::new(bytes);
        let parsed = read_message(&mut reader).expect("parse");
        assert_eq!(parsed["id"], 2);
    }

    #[test]
    fn read_message_errors_on_eof() {
        let mut reader = Cursor::new(Vec::<u8>::new());
        let err = read_message(&mut reader).unwrap_err();
        assert!(err.contains("EOF"));
    }

    #[test]
    fn parse_publish_diagnostics_maps_severity_and_position() {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": "file:///tmp/foo.rs",
                "diagnostics": [
                    {
                        "range": { "start": { "line": 10, "character": 4 }, "end": { "line": 10, "character": 8 } },
                        "severity": 1,
                        "code": "E0432",
                        "message": "unresolved import"
                    },
                    {
                        "range": { "start": { "line": 20, "character": 0 }, "end": { "line": 20, "character": 1 } },
                        "severity": 2,
                        "code": 42,
                        "message": "unused import"
                    }
                ]
            }
        });
        let (uri, diags) = parse_publish_diagnostics(&msg).expect("parsed");
        assert_eq!(uri, "file:///tmp/foo.rs");
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].file, "/tmp/foo.rs");
        assert_eq!(diags[0].line, 11); // 0-based → 1-based
        assert_eq!(diags[0].col, 5);
        assert_eq!(diags[0].severity, Severity::Error);
        assert_eq!(diags[0].code, "E0432");
        assert_eq!(diags[1].severity, Severity::Warning);
        // numeric code is stringified
        assert_eq!(diags[1].code, "42");
        assert_eq!(diags[0].source, "lsp");
    }

    #[test]
    fn detection_returns_none_when_no_signals_match() {
        let dir = std::env::temp_dir().join(format!(
            "prism-lsp-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // No project files at all.
        assert!(detect_lsp_command(&dir).is_none());
    }

    /// Spawn a paired TcpListener so we can stand up a fake LSP server
    /// in-process for end-to-end testing without a real subprocess.
    fn spawn_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server_handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            stream
        });
        let client = TcpStream::connect(addr).expect("connect");
        let server = server_handle.join().expect("join");
        // Give both ends short timeouts so a hung test fails instead of
        // hanging the suite.
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        (client, server)
    }

    /// End-to-end: drive `run_lsp_session` against a fake LSP server
    /// running on the other side of a TcpStream pair. The fake replies
    /// to `initialize`, emits one `publishDiagnostics`, and acknowledges
    /// `shutdown` so the session terminates cleanly.
    #[test]
    fn run_lsp_session_collects_diagnostics_from_mock_server() {
        let (client_stream, server_stream) = spawn_pair();
        let client_reader = client_stream.try_clone().expect("clone");
        let client_writer = client_stream;

        // Fake LSP server thread.
        let server_handle = std::thread::spawn(move || {
            let mut reader = server_stream.try_clone().expect("clone");
            let mut writer = server_stream;
            // Expect initialize.
            let init = read_message(&mut reader).expect("init");
            assert_eq!(init["method"], "initialize");
            let init_id = init["id"].clone();
            // Reply with a minimal initialize result.
            write_message(
                &mut writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": init_id,
                    "result": { "capabilities": {} }
                }),
            )
            .unwrap();
            // Expect initialized notification.
            let initd = read_message(&mut reader).expect("initialized");
            assert_eq!(initd["method"], "initialized");
            // Emit publishDiagnostics for a fake file.
            write_message(
                &mut writer,
                &json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": "file:///tmp/x.rs",
                        "diagnostics": [
                            {
                                "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
                                "severity": 1,
                                "code": "E0001",
                                "message": "synthesized error"
                            }
                        ]
                    }
                }),
            )
            .unwrap();
            // Wait for shutdown, ack it, then exit.
            loop {
                let msg = match read_message(&mut reader) {
                    Ok(m) => m,
                    Err(_) => return,
                };
                if msg["method"] == "shutdown" {
                    let id = msg["id"].clone();
                    write_message(
                        &mut writer,
                        &json!({ "jsonrpc": "2.0", "id": id, "result": null }),
                    )
                    .unwrap();
                }
                if msg["method"] == "exit" {
                    return;
                }
            }
        });

        let cwd = std::env::current_dir().unwrap();
        let result = run_lsp_session(
            &cwd,
            &[],
            client_writer,
            client_reader,
            Duration::from_secs(5),
            "mock",
        )
        .expect("session");
        let _ = server_handle.join();

        let (diags, initialized, timed_out) = result;
        assert!(initialized);
        assert!(!timed_out);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].source, "lsp");
        assert_eq!(diags[0].severity, Severity::Error);
        assert_eq!(diags[0].code, "E0001");
        assert!(diags[0].file.ends_with("x.rs"));
    }

    #[test]
    fn run_lsp_session_times_out_when_init_never_responds() {
        let (client_stream, server_stream) = spawn_pair();
        let client_reader = client_stream.try_clone().expect("clone");
        let client_writer = client_stream;
        // Server thread that reads but never replies.
        let _server = std::thread::spawn(move || {
            let mut reader = server_stream;
            let mut buf = [0u8; 1024];
            // Drain whatever the client sends so its writes don't block.
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    return;
                }
            }
        });

        let cwd = std::env::current_dir().unwrap();
        let (diags, initialized, timed_out) = run_lsp_session(
            &cwd,
            &[],
            client_writer,
            client_reader,
            Duration::from_millis(300),
            "mock",
        )
        .expect("session returns Ok even on init timeout");
        assert!(!initialized);
        assert!(timed_out);
        assert!(diags.is_empty());
    }

    #[test]
    fn guess_language_id_maps_common_extensions() {
        assert_eq!(guess_language_id(Path::new("a.rs")), "rust");
        assert_eq!(guess_language_id(Path::new("a.ts")), "typescript");
        assert_eq!(guess_language_id(Path::new("a.tsx")), "typescriptreact");
        assert_eq!(guess_language_id(Path::new("a.py")), "python");
        assert_eq!(guess_language_id(Path::new("a.go")), "go");
        assert_eq!(guess_language_id(Path::new("Makefile")), "plaintext");
    }

    #[test]
    fn path_to_uri_and_back_round_trip() {
        let p = Path::new("/tmp/foo/bar.rs");
        let uri = path_to_uri(p);
        assert_eq!(uri, "file:///tmp/foo/bar.rs");
        assert_eq!(uri_to_file(&uri), "/tmp/foo/bar.rs");
    }
}
