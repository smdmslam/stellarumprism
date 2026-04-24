//! Diagnostic substrate.
//!
//! This module is the deterministic layer beneath the LLM. Each function
//! here runs an actual project tool (compiler, linter, type-checker), parses
//! its output, and emits a `Diagnostic` in a unified shape. Consumers
//! upstream (`/audit`, future `/fix`, eventually the IDE problems panel
//! and inline squiggles) read those diagnostics through the same JSON
//! contract — `to_finding_payload` shapes the output to match the
//! `Finding` schema in `src/findings.ts`.
//!
//! Substrate v1: typecheck (compile-time errors).
//! Substrate v2 will add `lsp_diagnostics`. Substrate v3 will add
//! `runtime_probe`. Each will live in this module so adding a new source
//! is one parser plus one detection branch — never a fork of the consumer.
//!
//! Design rules:
//!   - Substrate calls are **read-only**. They run a build/check command
//!     but never write to the filesystem.
//!   - Substrate calls are **deterministic for a given repo state**. The
//!     LLM does not influence what they return.
//!   - Output is always the same `Diagnostic` shape regardless of source.
//!   - Caps protect the consumer's context window: caller decides what to
//!     truncate, but the substrate flags `truncated` on output.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

/// Maximum number of diagnostics returned to the LLM in one substrate
/// call. Anything beyond this is dropped and `truncated=true` is set.
/// Sized so a typical "everything broken" build still fits in one tool
/// result without blowing the context window.
const MAX_DIAGNOSTICS: usize = 200;

/// Maximum bytes of raw command output included in the payload. The model
/// occasionally needs to inspect raw output when our parsers don't
/// recognize the format (an unknown linter, a bespoke wrapper). Capped to
/// keep one tool call from saturating the context.
const MAX_RAW_BYTES: usize = 8 * 1024;

/// Default timeout for any substrate command. Overridable via
/// `agent.typecheck_timeout_secs` on the config side.
const DEFAULT_TIMEOUT_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Severity of a diagnostic. Mirrors `src/findings.ts::Severity` so the
/// substrate's output drops directly into the consumer's contract.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Severity {
    fn as_str(&self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// One diagnostic from a substrate emitter. Identical shape regardless of
/// source so downstream renderers (xterm now, problems panel later, IDE
/// squiggles eventually) need no translation.
#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    /// Where the diagnostic came from: "typecheck", future "lsp",
    /// "runtime_probe", etc. Lets consumers filter or color-code.
    pub source: String,
    /// Path as emitted by the underlying tool, normalized to forward
    /// slashes. Relative when the tool emits relative paths; absolute
    /// when it doesn't.
    pub file: String,
    /// 1-based. 0 means the tool didn't provide a line.
    pub line: u32,
    /// 1-based column. 0 if absent.
    pub col: u32,
    pub severity: Severity,
    /// Tool-specific code (e.g. "TS2304", "E0432"). Empty if unavailable.
    pub code: String,
    /// Human-readable message. Trimmed; line breaks collapsed to spaces.
    pub message: String,
}

/// Outcome of running a substrate command. Includes both the structured
/// diagnostics and a small slice of raw output for debugging or for cases
/// where the parser didn't recognize the format.
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticRun {
    /// argv that was actually executed (after auto-detect / overrides).
    pub command: Vec<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
    pub diagnostics: Vec<Diagnostic>,
    /// True iff `diagnostics` was capped at `MAX_DIAGNOSTICS`.
    pub diagnostics_truncated: bool,
    /// Up to `MAX_RAW_BYTES` of stdout + stderr, joined. The LLM reads
    /// this only when no diagnostics were parsed.
    pub raw: String,
    /// True iff `raw` was truncated.
    pub raw_truncated: bool,
    /// True iff the command timed out before exiting.
    pub timed_out: bool,
}

// ---------------------------------------------------------------------------
// run_typecheck — public entry point used by tools::tool_typecheck
// ---------------------------------------------------------------------------

/// Run the project's typecheck/build command from `cwd` and return parsed
/// diagnostics. `override_argv` (from a tool call argument or the config
/// file) wins over auto-detection. `timeout` is in seconds; pass None to
/// use the default.
///
/// Returns Err only on early-failure conditions (empty cwd, no auto-detect
/// match and no override, invalid override). A non-zero exit code from
/// the underlying command is **not** an error — that's the typical case
/// when the project has compile errors, and the diagnostics are exactly
/// what we want.
pub fn run_typecheck(
    cwd: &str,
    override_argv: Option<&[String]>,
    timeout: Option<Duration>,
) -> Result<DiagnosticRun, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is unknown (shell integration may not be started)".into());
    }
    let cwd_path = Path::new(cwd);
    let argv = match override_argv {
        Some(argv) => {
            validate_argv(argv)?;
            argv.to_vec()
        }
        None => detect_typecheck_command(cwd_path)
            .ok_or_else(|| {
                "no typecheck command detected; pass `command` argument or set agent.typecheck_command in config".to_string()
            })?,
    };
    let timeout = timeout.unwrap_or(Duration::from_secs(DEFAULT_TIMEOUT_SECS));

    let started = Instant::now();
    let (output, timed_out) = run_with_timeout(&argv, cwd_path, timeout)?;
    let duration_ms = started.elapsed().as_millis();

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let combined = if stderr.is_empty() {
        stdout.clone()
    } else if stdout.is_empty() {
        stderr.clone()
    } else {
        format!("{}{}{}", stdout, if stdout.ends_with('\n') { "" } else { "\n" }, stderr)
    };

    let mut diagnostics = parse_diagnostics(&argv, &stdout, &stderr);
    let diagnostics_truncated = diagnostics.len() > MAX_DIAGNOSTICS;
    if diagnostics_truncated {
        diagnostics.truncate(MAX_DIAGNOSTICS);
    }

    let (raw, raw_truncated) = if combined.len() > MAX_RAW_BYTES {
        (
            format!("{}\n[…raw output truncated at {} bytes]", &combined[..MAX_RAW_BYTES], MAX_RAW_BYTES),
            true,
        )
    } else {
        (combined, false)
    };

    Ok(DiagnosticRun {
        command: argv,
        exit_code: output.status.code(),
        duration_ms,
        diagnostics,
        diagnostics_truncated,
        raw,
        raw_truncated,
        timed_out,
    })
}

/// Translate a `DiagnosticRun` into the JSON payload the agent loop sends
/// back to the LLM. Shape is intentionally compatible with the consumer
/// side in `src/findings.ts` so renderers don't need to translate.
pub fn to_finding_payload(run: &DiagnosticRun) -> Value {
    json!({
        "command": run.command,
        "exit_code": run.exit_code,
        "duration_ms": run.duration_ms,
        "timed_out": run.timed_out,
        "diagnostics_truncated": run.diagnostics_truncated,
        "raw_truncated": run.raw_truncated,
        "diagnostics": run.diagnostics
            .iter()
            .map(|d| json!({
                "source": d.source,
                "file": d.file,
                "line": d.line,
                "col": d.col,
                "severity": d.severity.as_str(),
                "code": d.code,
                "message": d.message,
            }))
            .collect::<Vec<_>>(),
        "raw": run.raw,
    })
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

/// Inspect `cwd` and pick a reasonable typecheck command. Returns None if
/// nothing matched; the caller surfaces that as a clean error so the user
/// can configure one explicitly.
pub fn detect_typecheck_command(cwd: &Path) -> Option<Vec<String>> {
    // Highest signal first: an explicit script in package.json.
    if let Some(cmd) = detect_node_typecheck(cwd) {
        return Some(cmd);
    }
    // Then language-native single-shot checks.
    if cwd.join("Cargo.toml").is_file() {
        return Some(vec![
            "cargo".into(),
            "check".into(),
            "--message-format=short".into(),
        ]);
    }
    if cwd.join("go.mod").is_file() {
        return Some(vec!["go".into(), "build".into(), "./...".into()]);
    }
    if cwd.join("pyproject.toml").is_file() {
        // Pyright is the most common typed-Python checker. We only emit
        // this branch when pyright is on PATH so users without it don't
        // get a confusing "command not found" runtime error.
        if which("pyright").is_some() {
            return Some(vec!["pyright".into(), "--outputjson".into()]);
        }
    }
    None
}

/// Look for a Node typecheck command. Priority:
///   1. package.json has a "typecheck" or "type-check" script → run it
///      via the detected package manager.
///   2. tsconfig.json exists → run `<pm> exec tsc --noEmit`.
fn detect_node_typecheck(cwd: &Path) -> Option<Vec<String>> {
    let pkg_path = cwd.join("package.json");
    let has_pkg = pkg_path.is_file();
    let has_tsconfig = cwd.join("tsconfig.json").is_file();
    if !has_pkg && !has_tsconfig {
        return None;
    }
    let pm = detect_package_manager(cwd);
    if has_pkg {
        if let Ok(text) = std::fs::read_to_string(&pkg_path) {
            if let Ok(json) = serde_json::from_str::<Value>(&text) {
                if let Some(scripts) = json.get("scripts").and_then(|v| v.as_object()) {
                    for name in ["typecheck", "type-check", "check-types", "tsc"] {
                        if scripts.contains_key(name) {
                            return Some(run_script_argv(&pm, name));
                        }
                    }
                }
            }
        }
    }
    if has_tsconfig {
        // `<pm> exec tsc --noEmit`. exec works for pnpm/npm/yarn/bun.
        return Some(vec![
            pm.bin().into(),
            "exec".into(),
            "tsc".into(),
            "--noEmit".into(),
        ]);
    }
    None
}

#[derive(Debug, Clone, Copy)]
enum PackageManager {
    Pnpm,
    Yarn,
    Bun,
    Npm,
}

impl PackageManager {
    fn bin(&self) -> &'static str {
        match self {
            PackageManager::Pnpm => "pnpm",
            PackageManager::Yarn => "yarn",
            PackageManager::Bun => "bun",
            PackageManager::Npm => "npm",
        }
    }
}

fn detect_package_manager(cwd: &Path) -> PackageManager {
    if cwd.join("pnpm-lock.yaml").is_file() {
        return PackageManager::Pnpm;
    }
    if cwd.join("bun.lockb").is_file() || cwd.join("bun.lock").is_file() {
        return PackageManager::Bun;
    }
    if cwd.join("yarn.lock").is_file() {
        return PackageManager::Yarn;
    }
    PackageManager::Npm
}

fn run_script_argv(pm: &PackageManager, script: &str) -> Vec<String> {
    // pnpm/yarn/bun: `<pm> run <script>`. npm needs the same form, but
    // older versions need `--` to forward flags — for typecheck scripts
    // there are typically none, so the simple form is fine.
    vec![pm.bin().into(), "run".into(), script.into()]
}

// ---------------------------------------------------------------------------
// Override validation
// ---------------------------------------------------------------------------

/// Reject unsafe overrides. We accept argv arrays only; shell strings are
/// rejected because we run via `Command` (no shell), and any metacharacter
/// would silently fail at runtime instead of doing what the user expected.
fn validate_argv(argv: &[String]) -> Result<(), String> {
    if argv.is_empty() {
        return Err("override command is empty".into());
    }
    for (i, arg) in argv.iter().enumerate() {
        if arg.is_empty() {
            return Err(format!("override argv[{}] is empty", i));
        }
        // Only flag shell metacharacters in the program name (argv[0]).
        // Arguments themselves are allowed to contain >, |, etc. when the
        // tool itself parses them. The program name should never contain
        // metacharacters under any reasonable scenario.
        if i == 0 {
            for c in arg.chars() {
                if matches!(c, '|' | '&' | ';' | '<' | '>' | '$' | '`' | '\n') {
                    return Err(format!(
                        "override program contains shell metacharacter '{}'; pass argv array, not a shell string",
                        c
                    ));
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Subprocess execution with timeout
// ---------------------------------------------------------------------------

fn run_with_timeout(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<(Output, bool), String> {
    use std::io::Read;
    use std::sync::mpsc;
    use std::thread;

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.current_dir(cwd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {:?}: {}", argv[0], e))?;

    // Drain stdout/stderr on threads so they don't block the child.
    let mut stdout_pipe = child.stdout.take().expect("stdout piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr piped");
    let (tx_out, rx_out) = mpsc::channel::<Vec<u8>>();
    let (tx_err, rx_err) = mpsc::channel::<Vec<u8>>();
    let out_join = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        let _ = tx_out.send(buf);
    });
    let err_join = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        let _ = tx_err.send(buf);
    });

    // Poll for completion until `timeout` elapses.
    let start = Instant::now();
    let mut timed_out = false;
    let status_opt = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    timed_out = true;
                    break child.wait().ok();
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("error waiting on child: {}", e)),
        }
    };

    let _ = out_join.join();
    let _ = err_join.join();
    let stdout = rx_out.recv().unwrap_or_default();
    let stderr = rx_err.recv().unwrap_or_default();
    let status = status_opt.ok_or_else(|| "child exited without status".to_string())?;

    Ok((
        Output {
            status,
            stdout,
            stderr,
        },
        timed_out,
    ))
}

// ---------------------------------------------------------------------------
// Parser dispatcher
// ---------------------------------------------------------------------------

/// Pick a parser based on the program name in argv[0]. Falls back to the
/// "tsc" parser for any node-flavored runner (pnpm/yarn/npm/bun running
/// "typecheck") because the ultimate output format is whatever tsc emits.
fn parse_diagnostics(argv: &[String], stdout: &str, stderr: &str) -> Vec<Diagnostic> {
    let prog = Path::new(&argv[0])
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&argv[0]);
    let combined = if stderr.is_empty() {
        stdout.to_string()
    } else if stdout.is_empty() {
        stderr.to_string()
    } else {
        format!("{}\n{}", stdout, stderr)
    };
    match prog {
        "cargo" => parse_cargo_short(&combined),
        "tsc" => parse_tsc(&combined),
        "pnpm" | "npm" | "yarn" | "bun" => {
            // Node runners typically wrap tsc; tsc's output format is the
            // dominant one. If a user runs eslint via `npm run typecheck`,
            // we'll fall through to no parsed diagnostics and the LLM gets
            // the raw output, which is acceptable for v1.
            parse_tsc(&combined)
        }
        "go" => parse_go_build(&combined),
        "pyright" => parse_pyright_json(&combined),
        _ => parse_tsc(&combined),
    }
}

// ---------------------------------------------------------------------------
// tsc text parser
// ---------------------------------------------------------------------------

/// Parse `tsc --noEmit` output. The canonical line format is:
///   `path/to/file.ts(LINE,COL): error TSCODE: message`
/// We accept warnings/info too even though tsc rarely emits them.
fn parse_tsc(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end();
        // Find "(L,C):" suffix on the path.
        let Some(open_paren) = line.find('(') else {
            continue;
        };
        let Some(close_paren) = line[open_paren..].find("):") else {
            continue;
        };
        let close_paren = open_paren + close_paren;
        let file = line[..open_paren].trim().to_string();
        if file.is_empty() {
            continue;
        }
        let pos = &line[open_paren + 1..close_paren];
        let mut pos_iter = pos.splitn(2, ',');
        let l: u32 = pos_iter.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let c: u32 = pos_iter.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let rest = line[close_paren + 2..].trim_start();
        // rest ~= "error TS2304: Cannot find name 'foo'."
        let (sev_word, after_sev) = match rest.split_once(' ') {
            Some(p) => p,
            None => continue,
        };
        let severity = match sev_word.to_ascii_lowercase().as_str() {
            "error" => Severity::Error,
            "warning" => Severity::Warning,
            "info" | "message" => Severity::Info,
            _ => continue,
        };
        // after_sev typically starts with "TS<N>: <msg>"; allow no code.
        let (code, message) = match after_sev.split_once(':') {
            Some((c, m)) => (c.trim().to_string(), m.trim().to_string()),
            None => (String::new(), after_sev.trim().to_string()),
        };
        out.push(Diagnostic {
            source: "typecheck".into(),
            file: file.replace('\\', "/"),
            line: l,
            col: c,
            severity,
            code,
            message: collapse_ws(&message),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// cargo check --message-format=short parser
// ---------------------------------------------------------------------------

/// Parse `cargo check --message-format=short` output. Lines look like:
///   `src/foo.rs:42:7: error[E0432]: unresolved import ...`
/// or:
///   `error[E0432]: unresolved import ...`
///   `  --> src/foo.rs:42:7`
/// The `--message-format=short` form is single-line per diagnostic so
/// we focus on that. Multi-line fallbacks are caught best-effort.
fn parse_cargo_short(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let mut pending: Option<(Severity, String, String)> = None;

    for raw in text.lines() {
        let line = raw.trim_end();
        // Single-line form: `path:line:col: severity[CODE]: message`
        if let Some(d) = parse_cargo_short_line(line) {
            out.push(d);
            continue;
        }
        // Multi-line fallback: `error[E0432]: message` then `  --> path:L:C`.
        if let Some((sev, code, msg)) = parse_cargo_severity_line(line) {
            pending = Some((sev, code, msg));
            continue;
        }
        if let Some((sev, code, msg)) = pending.take() {
            if let Some((file, l, c)) = parse_cargo_arrow_line(line) {
                out.push(Diagnostic {
                    source: "typecheck".into(),
                    file,
                    line: l,
                    col: c,
                    severity: sev,
                    code,
                    message: collapse_ws(&msg),
                });
            } else {
                // Drop pending; we lost the location row.
            }
        }
    }
    out
}

fn parse_cargo_short_line(line: &str) -> Option<Diagnostic> {
    // Need at least 3 colons before any severity word.
    // Layout: <path>:<l>:<c>: <severity>[<code>]: <message>
    let mut iter = line.splitn(4, ':');
    let file = iter.next()?.trim().to_string();
    let l: u32 = iter.next()?.trim().parse().ok()?;
    let c: u32 = iter.next()?.trim().parse().ok()?;
    let rest = iter.next()?.trim_start();
    if file.is_empty() {
        return None;
    }
    let (sev, code, msg) = parse_cargo_severity_head(rest)?;
    Some(Diagnostic {
        source: "typecheck".into(),
        file: file.replace('\\', "/"),
        line: l,
        col: c,
        severity: sev,
        code,
        message: collapse_ws(&msg),
    })
}

fn parse_cargo_severity_line(line: &str) -> Option<(Severity, String, String)> {
    parse_cargo_severity_head(line.trim_start())
}

fn parse_cargo_severity_head(s: &str) -> Option<(Severity, String, String)> {
    // Match: "(error|warning|note|help)(\[CODE\])?: message"
    let (head, rest) = s.split_once(':')?;
    let head = head.trim();
    let rest = rest.trim().to_string();
    let (sev_word, code) = if let Some(idx) = head.find('[') {
        let sev_word = head[..idx].to_string();
        let code = head[idx + 1..].trim_end_matches(']').to_string();
        (sev_word, code)
    } else {
        (head.to_string(), String::new())
    };
    let severity = match sev_word.to_ascii_lowercase().as_str() {
        "error" => Severity::Error,
        "warning" => Severity::Warning,
        "note" | "help" => Severity::Info,
        _ => return None,
    };
    Some((severity, code, rest))
}

fn parse_cargo_arrow_line(line: &str) -> Option<(String, u32, u32)> {
    // Lines like `  --> src/foo.rs:42:7`
    let trimmed = line.trim_start();
    let after = trimmed.strip_prefix("-->")?.trim();
    let mut iter = after.rsplitn(3, ':');
    let c: u32 = iter.next()?.trim().parse().ok()?;
    let l: u32 = iter.next()?.trim().parse().ok()?;
    let file = iter.next()?.trim().to_string();
    Some((file.replace('\\', "/"), l, c))
}

// ---------------------------------------------------------------------------
// go build parser (very simple)
// ---------------------------------------------------------------------------

fn parse_go_build(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end();
        // `path/to/file.go:42:7: undefined: Foo`
        let mut iter = line.splitn(4, ':');
        let Some(file) = iter.next() else { continue };
        let Some(l_raw) = iter.next() else { continue };
        let Some(c_raw) = iter.next() else { continue };
        let Some(msg) = iter.next() else { continue };
        let l: u32 = match l_raw.trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let c: u32 = c_raw.trim().parse().unwrap_or(0);
        out.push(Diagnostic {
            source: "typecheck".into(),
            file: file.trim().replace('\\', "/"),
            line: l,
            col: c,
            severity: Severity::Error,
            code: String::new(),
            message: collapse_ws(msg.trim()),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// pyright JSON parser
// ---------------------------------------------------------------------------

fn parse_pyright_json(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let parsed: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let Some(diags) = parsed
        .get("generalDiagnostics")
        .and_then(|v| v.as_array())
    else {
        return out;
    };
    for d in diags {
        let file = d
            .get("file")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .replace('\\', "/");
        let sev = match d.get("severity").and_then(|v| v.as_str()).unwrap_or("") {
            "error" => Severity::Error,
            "warning" => Severity::Warning,
            _ => Severity::Info,
        };
        let l = d
            .get("range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("line"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32 + 1)
            .unwrap_or(0);
        let c = d
            .get("range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("character"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32 + 1)
            .unwrap_or(0);
        let msg = d
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let code = d
            .get("rule")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out.push(Diagnostic {
            source: "typecheck".into(),
            file,
            line: l,
            col: c,
            severity: sev,
            code,
            message: collapse_ws(&msg),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    out.trim().to_string()
}

/// Tiny `which` for our auto-detect branches. Avoids a new dependency.
fn which(prog: &str) -> Option<PathBuf> {
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
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn fresh_tmp() -> PathBuf {
        let dir = env::temp_dir().join(format!("prism-diag-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create tmp dir");
        fs::canonicalize(&dir).expect("canonicalize tmp")
    }

    #[test]
    fn parses_canonical_tsc_error_line() {
        let out = parse_tsc("src/foo.ts(42,7): error TS2304: Cannot find name 'bar'.");
        assert_eq!(out.len(), 1);
        let d = &out[0];
        assert_eq!(d.file, "src/foo.ts");
        assert_eq!(d.line, 42);
        assert_eq!(d.col, 7);
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.code, "TS2304");
        assert!(d.message.contains("Cannot find name"));
    }

    #[test]
    fn parses_multiple_tsc_lines_and_skips_unrelated() {
        let raw = "\
some preamble line
src/a.ts(1,1): error TS1: msg one
src/b.ts(2,2): warning TS2: msg two
trailing line
";
        let out = parse_tsc(raw);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].severity, Severity::Error);
        assert_eq!(out[1].severity, Severity::Warning);
    }

    #[test]
    fn parses_cargo_short_single_line() {
        let raw = "src/foo.rs:42:7: error[E0432]: unresolved import `bar::baz`";
        let out = parse_cargo_short(raw);
        assert_eq!(out.len(), 1);
        let d = &out[0];
        assert_eq!(d.file, "src/foo.rs");
        assert_eq!(d.line, 42);
        assert_eq!(d.col, 7);
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.code, "E0432");
        assert!(d.message.contains("unresolved import"));
    }

    #[test]
    fn parses_cargo_two_line_form() {
        let raw = "\
error[E0599]: no method named `foo` found for struct `Bar`
  --> src/main.rs:10:5
";
        let out = parse_cargo_short(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].file, "src/main.rs");
        assert_eq!(out[0].line, 10);
        assert_eq!(out[0].col, 5);
        assert_eq!(out[0].code, "E0599");
    }

    #[test]
    fn parses_go_build_line() {
        let raw = "main.go:7:3: undefined: foo";
        let out = parse_go_build(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].file, "main.go");
        assert_eq!(out[0].line, 7);
        assert_eq!(out[0].col, 3);
    }

    #[test]
    fn detects_cargo_when_cargo_toml_present() {
        let dir = fresh_tmp();
        fs::write(dir.join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        let argv = detect_typecheck_command(&dir).expect("should detect");
        assert_eq!(argv[0], "cargo");
        assert!(argv.contains(&"check".to_string()));
    }

    #[test]
    fn detects_node_typecheck_script_over_tsconfig() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts": {"typecheck": "tsc --noEmit"}}"#,
        )
        .unwrap();
        fs::write(dir.join("tsconfig.json"), "{}").unwrap();
        fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        let argv = detect_typecheck_command(&dir).expect("should detect");
        assert_eq!(argv[0], "pnpm");
        assert_eq!(argv, vec!["pnpm", "run", "typecheck"]);
    }

    #[test]
    fn detects_tsc_fallback_when_no_script() {
        let dir = fresh_tmp();
        fs::write(dir.join("package.json"), r#"{"scripts": {}}"#).unwrap();
        fs::write(dir.join("tsconfig.json"), "{}").unwrap();
        // No lockfile → npm.
        let argv = detect_typecheck_command(&dir).expect("should detect");
        assert_eq!(argv[0], "npm");
        assert!(argv.iter().any(|s| s == "tsc"));
        assert!(argv.iter().any(|s| s == "--noEmit"));
    }

    #[test]
    fn detects_yarn_when_yarn_lock_present() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts": {"typecheck": "tsc"}}"#,
        )
        .unwrap();
        fs::write(dir.join("yarn.lock"), "").unwrap();
        let argv = detect_typecheck_command(&dir).expect("should detect");
        assert_eq!(argv[0], "yarn");
    }

    #[test]
    fn returns_none_when_nothing_matches() {
        let dir = fresh_tmp();
        assert!(detect_typecheck_command(&dir).is_none());
    }

    #[test]
    fn validate_argv_rejects_empty() {
        assert!(validate_argv(&[]).is_err());
        assert!(validate_argv(&["".to_string()]).is_err());
    }

    #[test]
    fn validate_argv_rejects_shell_metacharacters_in_program() {
        assert!(validate_argv(&["tsc; rm -rf /".to_string()]).is_err());
        assert!(validate_argv(&["tsc | cat".to_string()]).is_err());
        assert!(validate_argv(&["echo $HOME".to_string()]).is_err());
    }

    #[test]
    fn validate_argv_allows_metachars_in_arguments() {
        // Args may legitimately contain things like ">=" or "*". Only the
        // program name is constrained.
        assert!(validate_argv(&["tsc".to_string(), "--target=>=es2022".to_string()]).is_ok());
        assert!(validate_argv(&["grep".to_string(), "foo|bar".to_string()]).is_ok());
    }

    #[test]
    fn run_typecheck_errors_on_empty_cwd() {
        let r = run_typecheck("", None, None);
        assert!(r.is_err());
    }

    #[test]
    fn run_typecheck_uses_override_argv() {
        let dir = fresh_tmp();
        // Use /bin/echo (always present on macOS/Linux) as a stand-in.
        let argv = vec!["echo".to_string(), "hello".to_string()];
        let r = run_typecheck(&dir.to_string_lossy(), Some(&argv), Some(Duration::from_secs(5)))
            .expect("should run");
        assert_eq!(r.command, argv);
        assert_eq!(r.exit_code, Some(0));
        assert!(r.raw.contains("hello"));
        assert!(r.diagnostics.is_empty());
    }

    #[test]
    fn run_typecheck_times_out_on_slow_command() {
        let dir = fresh_tmp();
        let argv = vec!["sleep".to_string(), "30".to_string()];
        let r = run_typecheck(
            &dir.to_string_lossy(),
            Some(&argv),
            Some(Duration::from_millis(200)),
        )
        .expect("should run");
        assert!(r.timed_out, "expected timeout");
    }

    #[test]
    fn to_finding_payload_emits_expected_keys() {
        let run = DiagnosticRun {
            command: vec!["tsc".into()],
            exit_code: Some(2),
            duration_ms: 123,
            diagnostics: vec![Diagnostic {
                source: "typecheck".into(),
                file: "src/a.ts".into(),
                line: 1,
                col: 2,
                severity: Severity::Error,
                code: "TS1".into(),
                message: "boom".into(),
            }],
            diagnostics_truncated: false,
            raw: "raw".into(),
            raw_truncated: false,
            timed_out: false,
        };
        let v = to_finding_payload(&run);
        assert_eq!(v["command"][0], "tsc");
        assert_eq!(v["exit_code"], 2);
        assert_eq!(v["diagnostics"][0]["severity"], "error");
        assert_eq!(v["diagnostics"][0]["code"], "TS1");
    }
}
