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

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

/// Embedded source of the AST helper (substrate v2). Written to a temp
/// file once per process and re-used; spawned as `node <helper>` for
/// every `ast_query` call. Single source of truth, no install step.
const AST_HELPER_SOURCE: &str = include_str!("ast_helper.mjs");

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
///
/// Each diagnostic also carries `confidence="confirmed"` and an
/// `evidence` receipt referencing the underlying compiler line. The
/// downstream grader in `findings.ts::gradeFinding` uses the source +
/// evidence to assign confidence; substrate diagnostics are always
/// confirmed because the compiler is authoritative.
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
                "confidence": "confirmed",
                "file": d.file,
                "line": d.line,
                "col": d.col,
                "severity": d.severity.as_str(),
                "code": d.code,
                "message": d.message,
                "evidence": [
                    {
                        "source": d.source,
                        "detail": format_diagnostic_evidence(d),
                    }
                ],
            }))
            .collect::<Vec<_>>(),
        "raw": run.raw,
    })
}

/// Format a Diagnostic into a single-line evidence detail string. Mirrors
/// the canonical compiler output so the grader can match it back to a
/// real substrate run when the LLM cites it.
fn format_diagnostic_evidence(d: &Diagnostic) -> String {
    let loc = if d.col > 0 {
        format!("{}:{}:{}", d.file, d.line, d.col)
    } else if d.line > 0 {
        format!("{}:{}", d.file, d.line)
    } else {
        d.file.clone()
    };
    let code = if d.code.is_empty() {
        String::new()
    } else {
        format!(" [{}]", d.code)
    };
    format!("{} {}{}: {}", loc, d.severity.as_str(), code, d.message)
}

// ---------------------------------------------------------------------------
// AST substrate (substrate v2)
//
// Spawns the embedded Node helper to answer structural questions about
// the user's TypeScript project. The architectural payoff: findings that
// the LLM might otherwise emit as `candidate` ("X looks undefined") can
// be backed by a real type-checker answer, graduating them to `probable`
// via the existing grader.
// ---------------------------------------------------------------------------

/// Default timeout for AST helper invocations. Cold tsc startup on a
/// medium repo is ~1–2s; this gives headroom for big monorepos.
const AST_DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Maximum bytes of helper stdout we accept. The helper emits a single
/// JSON object; nothing reasonable should exceed this. A larger payload
/// indicates either a runaway helper or a hostile project.
const AST_MAX_STDOUT_BYTES: usize = 256 * 1024;

/// Path of the helper script on disk, written once per process.
static AST_HELPER_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Lazy-initialize the helper script: write the embedded source into a
/// stable per-process tempfile so spawns can reference it by path.
/// Returns the resolved path or an error string suitable for a tool
/// failure.
fn ensure_ast_helper_path() -> Result<&'static Path, String> {
    if let Some(p) = AST_HELPER_PATH.get() {
        return Ok(p.as_path());
    }
    let dir = std::env::temp_dir().join(format!(
        "prism-ast-helper-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    let path = dir.join("ast_helper.mjs");
    if !path.exists() {
        let mut f = std::fs::File::create(&path)
            .map_err(|e| format!("cannot create {}: {}", path.display(), e))?;
        f.write_all(AST_HELPER_SOURCE.as_bytes())
            .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
    }
    let _ = AST_HELPER_PATH.set(path.clone());
    Ok(AST_HELPER_PATH.get().expect("just set").as_path())
}

/// Outcome of one AST query. The shape mirrors the helper's JSON so the
/// caller does not have to re-translate. `evidence_detail` is what the
/// LLM should paste verbatim into a Finding's `evidence: source=ast` line.
#[derive(Debug, Clone, Serialize)]
pub struct AstQueryRun {
    pub command: Vec<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
    /// `ok=true` iff the helper produced a structured answer. `ok=false`
    /// covers tsconfig errors, unknown ops, etc.
    pub ok: bool,
    /// Helper-emitted JSON, parsed. Empty when `ok=false`.
    pub result: Value,
    /// Helper error message when `ok=false`. Empty otherwise.
    pub error: String,
    pub raw_stdout: String,
    pub raw_stderr: String,
    pub timed_out: bool,
}

/// Spawn the embedded Node helper with a single JSON query. `cwd` is the
/// user's project root (where tsconfig.json lives). The helper resolves
/// `typescript` from `cwd/node_modules/typescript` via NODE_PATH.
pub fn run_ast_query(
    cwd: &str,
    query: &Value,
    timeout: Option<Duration>,
) -> Result<AstQueryRun, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is unknown (shell integration may not be started)".into());
    }
    let cwd_path = Path::new(cwd);
    if !cwd_path.exists() {
        return Err(format!("cwd does not exist: {}", cwd));
    }
    let helper = ensure_ast_helper_path()?;
    let timeout = timeout.unwrap_or(Duration::from_secs(AST_DEFAULT_TIMEOUT_SECS));

    let query_arg = format!(
        "--query={}",
        serde_json::to_string(query).map_err(|e| format!("serialize query: {}", e))?
    );
    let argv = vec![
        "node".to_string(),
        helper.to_string_lossy().into_owned(),
        query_arg,
    ];

    // Set NODE_PATH so the helper's `import * as ts from "typescript"`
    // resolves to the user's project install. We append rather than
    // replace so any system-wide modules remain available.
    let mut node_path = cwd_path.join("node_modules").to_string_lossy().into_owned();
    if let Some(existing) = std::env::var_os("NODE_PATH") {
        let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        node_path.push_str(sep);
        node_path.push_str(&existing.to_string_lossy());
    }

    let started = Instant::now();
    let (output, timed_out) =
        run_with_timeout_env(&argv, cwd_path, timeout, &[("NODE_PATH", node_path.as_str())])?;
    let duration_ms = started.elapsed().as_millis();

    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if stdout.len() > AST_MAX_STDOUT_BYTES {
        stdout.truncate(AST_MAX_STDOUT_BYTES);
    }

    // Parse the helper's JSON. Anything else (truncation, helper crash)
    // collapses to a clean substrate failure with the raw output preserved.
    let parsed: Value = match serde_json::from_str::<Value>(stdout.trim()) {
        Ok(v) => v,
        Err(e) => {
            return Ok(AstQueryRun {
                command: argv,
                exit_code: output.status.code(),
                duration_ms,
                ok: false,
                result: Value::Null,
                error: format!(
                    "ast helper produced non-JSON stdout ({} bytes): {}; stderr: {}",
                    stdout.len(),
                    e,
                    truncate_for_log(&stderr, 400),
                ),
                raw_stdout: stdout,
                raw_stderr: stderr,
                timed_out,
            });
        }
    };

    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let error = if ok {
        String::new()
    } else {
        parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("ast helper returned ok=false without an error message")
            .to_string()
    };

    Ok(AstQueryRun {
        command: argv,
        exit_code: output.status.code(),
        duration_ms,
        ok,
        result: if ok { parsed } else { Value::Null },
        error,
        raw_stdout: stdout,
        raw_stderr: stderr,
        timed_out,
    })
}

/// Translate an `AstQueryRun` into the JSON payload sent back to the LLM.
/// Always exposes `ok` + `evidence_detail` (when present) so the model
/// can lift the detail into a Finding's `evidence: source=ast; detail=...`
/// line without inventing it.
pub fn to_ast_payload(run: &AstQueryRun) -> Value {
    json!({
        "command": run.command,
        "exit_code": run.exit_code,
        "duration_ms": run.duration_ms,
        "timed_out": run.timed_out,
        "ok": run.ok,
        "error": run.error,
        "result": run.result,
    })
}

/// Compact a string for logs / error messages, char-wise so we never
/// slice inside a multibyte boundary. Public so sibling substrate cells
/// (`lsp.rs`, future cells) can share the same shape.
pub fn truncate_for_log(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push_str(" \u{2026}[truncated]");
        out
    }
}

// ---------------------------------------------------------------------------
// run_tests (substrate v3)
//
// The strongest runtime-correctness signal available without running the
// full app: did the project's test suite pass? A failing test maps to a
// `confirmed` Finding via the grader (source="test"). The cell exists for
// the case typecheck cannot catch \u{2014} behavior that compiles but breaks at
// runtime.
// ---------------------------------------------------------------------------

/// Default timeout for the test runner. Tests legitimately run longer
/// than typecheck; users with very large suites should override via
/// `agent.test_timeout_secs` in config.
const TEST_DEFAULT_TIMEOUT_SECS: u64 = 120;

/// Maximum bytes of test runner output preserved in the payload. Caps
/// runaway suites without losing the most useful failure context.
const TEST_MAX_RAW_BYTES: usize = 16 * 1024;

/// Outcome of one test-suite run. Mirrors `DiagnosticRun`'s shape so
/// the consumer side renders both substrate cells uniformly. Failures
/// are surfaced as `Diagnostic` entries with `source="test"`.
#[derive(Debug, Clone, Serialize)]
pub struct TestRun {
    pub command: Vec<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
    /// Number of tests we could parse as failures from the output. May
    /// be 0 even when `exit_code != 0` if the parser didn't recognize
    /// the format \u{2014} the model can fall back to `raw`.
    pub failures: Vec<Diagnostic>,
    pub failures_truncated: bool,
    pub raw: String,
    pub raw_truncated: bool,
    pub timed_out: bool,
    /// True iff the suite passed: exit_code == 0 AND no parsed failures.
    pub passed: bool,
}

/// Run the project's test suite from `cwd`. `override_argv` (per-call or
/// from `agent.test_command`) wins over auto-detection. `timeout` is in
/// seconds; pass None to use the default.
///
/// Returns Err only on early-failure conditions (empty cwd, no detect +
/// no override, invalid override). A non-zero exit code from the
/// underlying command is NOT an error \u{2014} it usually means tests failed,
/// which is exactly the diagnostic we want.
pub fn run_tests(
    cwd: &str,
    override_argv: Option<&[String]>,
    timeout: Option<Duration>,
) -> Result<TestRun, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is unknown (shell integration may not be started)".into());
    }
    let cwd_path = Path::new(cwd);
    let argv = match override_argv {
        Some(argv) => {
            validate_argv(argv)?;
            argv.to_vec()
        }
        None => detect_test_command(cwd_path)
            .ok_or_else(|| {
                "no test command detected; pass `command` argument or set agent.test_command in config".to_string()
            })?,
    };
    let timeout = timeout.unwrap_or(Duration::from_secs(TEST_DEFAULT_TIMEOUT_SECS));

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
        format!(
            "{}{}{}",
            stdout,
            if stdout.ends_with('\n') { "" } else { "\n" },
            stderr,
        )
    };

    let mut failures = parse_test_failures(&argv, &stdout, &stderr);
    let failures_truncated = failures.len() > MAX_DIAGNOSTICS;
    if failures_truncated {
        failures.truncate(MAX_DIAGNOSTICS);
    }

    let (raw, raw_truncated) = if combined.len() > TEST_MAX_RAW_BYTES {
        (
            format!(
                "{}\n[\u{2026}raw output truncated at {} bytes]",
                &combined[..TEST_MAX_RAW_BYTES],
                TEST_MAX_RAW_BYTES,
            ),
            true,
        )
    } else {
        (combined, false)
    };

    let passed = output.status.code() == Some(0) && failures.is_empty();

    Ok(TestRun {
        command: argv,
        exit_code: output.status.code(),
        duration_ms,
        failures,
        failures_truncated,
        raw,
        raw_truncated,
        timed_out,
        passed,
    })
}

/// Translate a `TestRun` into the JSON payload sent back to the LLM.
/// Each failure carries `source="test"` + a verbatim `evidence_detail`
/// the model can paste directly into `evidence: source=test; detail=...`.
pub fn to_test_payload(run: &TestRun) -> Value {
    json!({
        "command": run.command,
        "exit_code": run.exit_code,
        "duration_ms": run.duration_ms,
        "timed_out": run.timed_out,
        "passed": run.passed,
        "failures_truncated": run.failures_truncated,
        "raw_truncated": run.raw_truncated,
        "failures": run.failures
            .iter()
            .map(|d| json!({
                "source": d.source,
                "confidence": "confirmed",
                "file": d.file,
                "line": d.line,
                "col": d.col,
                "severity": d.severity.as_str(),
                "code": d.code,
                "message": d.message,
                "evidence": [
                    {
                        "source": d.source,
                        "detail": format_diagnostic_evidence(d),
                    }
                ],
            }))
            .collect::<Vec<_>>(),
        "raw": run.raw,
    })
}

/// Inspect `cwd` and pick a reasonable test command. Mirrors
/// `detect_typecheck_command` but for the test runner branch.
pub fn detect_test_command(cwd: &Path) -> Option<Vec<String>> {
    if let Some(cmd) = detect_node_test(cwd) {
        return Some(cmd);
    }
    if cwd.join("Cargo.toml").is_file() {
        return Some(vec![
            "cargo".into(),
            "test".into(),
            "--quiet".into(),
        ]);
    }
    if cwd.join("go.mod").is_file() {
        return Some(vec![
            "go".into(),
            "test".into(),
            "./...".into(),
        ]);
    }
    if cwd.join("pyproject.toml").is_file() && which("pytest").is_some() {
        return Some(vec!["pytest".into(), "-q".into()]);
    }
    None
}

/// Look for a Node test command. Priority:
///   1. package.json has a "test" script \u{2192} run via the detected pm.
///   2. package.json + tsconfig.json present + vitest|jest dep \u{2192} run
///      that runner directly via `<pm> exec`.
fn detect_node_test(cwd: &Path) -> Option<Vec<String>> {
    let pkg_path = cwd.join("package.json");
    if !pkg_path.is_file() {
        return None;
    }
    let pm = detect_package_manager(cwd);
    if let Ok(text) = std::fs::read_to_string(&pkg_path) {
        if let Ok(json) = serde_json::from_str::<Value>(&text) {
            if let Some(scripts) = json.get("scripts").and_then(|v| v.as_object()) {
                for name in ["test", "test:unit", "vitest", "jest"] {
                    if scripts.contains_key(name) {
                        return Some(run_script_argv(&pm, name));
                    }
                }
            }
            // No script declared but a runner is in deps: run it directly.
            for runner in ["vitest", "jest"] {
                if has_dependency(&json, runner) {
                    return Some(vec![
                        pm.bin().into(),
                        "exec".into(),
                        runner.into(),
                        "run".into(),
                    ]);
                }
            }
        }
    }
    None
}

/// True iff package.json declares `name` as a (dev)dependency.
fn has_dependency(pkg: &Value, name: &str) -> bool {
    for key in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(deps) = pkg.get(key).and_then(|v| v.as_object()) {
            if deps.contains_key(name) {
                return true;
            }
        }
    }
    false
}

/// Pick a parser based on argv[0]. Falls back to a generic line scanner
/// that recognizes the common `path:line:col` failure prefixes used by
/// pytest, cargo-test panic captures, jest with location info, etc.
fn parse_test_failures(argv: &[String], stdout: &str, stderr: &str) -> Vec<Diagnostic> {
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
        "cargo" => parse_cargo_test_failures(&combined),
        "pytest" => parse_pytest_failures(&combined),
        "go" => parse_go_test_failures(&combined),
        // Node runners: vitest/jest output is hard to parse without JSON
        // mode. v1 falls back to the generic scanner; users wanting
        // structured failures should configure their runner with a JSON
        // reporter and pass it via agent.test_command.
        _ => parse_generic_test_failures(&combined),
    }
}

/// Parse `cargo test` text output. Failed tests are listed as
/// `test path::to::test ... FAILED` and the panic capture follows in a
/// `failures:` block.
fn parse_cargo_test_failures(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_end();
        // `test foo::bar ... FAILED`
        if let Some(rest) = trimmed.strip_prefix("test ") {
            if rest.ends_with("... FAILED") {
                let name = rest.trim_end_matches("... FAILED").trim();
                out.push(Diagnostic {
                    source: "test".into(),
                    file: name.to_string(),
                    line: 0,
                    col: 0,
                    severity: Severity::Error,
                    code: String::new(),
                    message: format!("test {} failed", name),
                });
            }
        }
    }
    out
}

/// Parse pytest `-q` output. Failures appear as `path/to/test.py::test_name FAILED`
/// or the long-form summary block at the end.
fn parse_pytest_failures(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        // Long form: `FAILED tests/test_x.py::test_name - AssertionError: ...`
        if let Some(rest) = trimmed.strip_prefix("FAILED ") {
            let (loc, msg) = match rest.split_once(" - ") {
                Some((l, m)) => (l, m),
                None => (rest, ""),
            };
            // loc is `path/to/test.py::test_name`; line number not
            // typically given on the FAILED summary line.
            let file = loc.split("::").next().unwrap_or(loc).to_string();
            out.push(Diagnostic {
                source: "test".into(),
                file,
                line: 0,
                col: 0,
                severity: Severity::Error,
                code: String::new(),
                message: if msg.is_empty() {
                    format!("pytest failed: {}", loc)
                } else {
                    format!("{} \u{2014} {}", loc, msg)
                },
            });
        }
    }
    out
}

/// Parse `go test ./...` output. Failures look like `--- FAIL: TestName (0.00s)`.
fn parse_go_test_failures(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("--- FAIL: ") {
            // `TestName (0.00s)`
            let name = rest.split(' ').next().unwrap_or(rest);
            out.push(Diagnostic {
                source: "test".into(),
                file: name.to_string(),
                line: 0,
                col: 0,
                severity: Severity::Error,
                code: String::new(),
                message: format!("go test {} failed", name),
            });
        }
    }
    out
}

/// Generic fallback: scan for lines that look like `path:line[:col]:`
/// followed by something error-ish, OR for `at <file>:<line>` suffixes
/// common to JS test runners. Best-effort \u{2014} misses are acceptable
/// because the raw output is preserved for the model.
fn parse_generic_test_failures(text: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_end();
        // Generic `path:line:col: <message>` form.
        if let Some(d) = parse_generic_path_line_col(trimmed) {
            out.push(d);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// http_fetch (substrate v4)
//
// Direct HTTP probe of a user-running endpoint. The strongest runtime
// signal short of a full E2E harness: did the endpoint actually return
// what the model claims it does? Used by /build to verify a new route
// after wiring, by /audit when the diff touches HTTP code paths, and by
// future consumers as a generic runtime check. source="runtime" →
// confirmed via the existing grader.
// ---------------------------------------------------------------------------

/// Default timeout for an http_fetch call. Local dev servers respond
/// quickly; this is generous enough for a cold first request.
const HTTP_FETCH_DEFAULT_TIMEOUT_SECS: u64 = 10;

/// Maximum response body bytes returned to the LLM. Caps a runaway
/// payload (e.g. large JSON dump) without losing the most useful slice.
const HTTP_FETCH_MAX_BODY_BYTES: usize = 32 * 1024;

/// Outcome of one HTTP probe. Network/transport failures are NOT
/// represented as Diagnostics \u{2014} they are substrate failures (ok=false)
/// because they don't tell us whether the endpoint is broken or just
/// unreachable. The model decides what to do with the response.
#[derive(Debug, Clone, Serialize)]
pub struct HttpFetchRun {
    pub url: String,
    pub method: String,
    pub status: Option<u16>,
    pub status_text: String,
    pub response_headers: Vec<(String, String)>,
    pub body: String,
    pub body_truncated: bool,
    pub duration_ms: u128,
    pub timed_out: bool,
    /// True iff we got an HTTP response (any status code). False for
    /// transport errors, timeouts, DNS failures, etc.
    pub ok: bool,
    /// Substrate-level error message when `ok=false`. Empty otherwise.
    pub error: String,
}

/// Issue an HTTP request from the spawned task. Async because reqwest's
/// streaming/async path is what we already use for web_search.
pub async fn run_http_fetch(
    url: &str,
    method: &str,
    headers: &[(String, String)],
    body: Option<&str>,
    timeout: Option<Duration>,
) -> Result<HttpFetchRun, String> {
    if url.trim().is_empty() {
        return Err("url is empty".into());
    }
    let timeout = timeout.unwrap_or(Duration::from_secs(HTTP_FETCH_DEFAULT_TIMEOUT_SECS));

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    let method_up = method.to_uppercase();
    let mut req = match method_up.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "PATCH" => client.patch(url),
        "DELETE" => client.delete(url),
        "HEAD" => client.head(url),
        other => {
            return Err(format!(
                "unsupported HTTP method '{}' (allowed: GET, POST, PUT, PATCH, DELETE, HEAD)",
                other
            ));
        }
    };
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        req = req.body(b.to_string());
    }

    let started = Instant::now();
    let resp = req.send().await;
    let duration_ms = started.elapsed().as_millis();

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            // Includes timeouts, DNS failures, connection refused, etc.
            let timed_out = e.is_timeout();
            return Ok(HttpFetchRun {
                url: url.to_string(),
                method: method_up,
                status: None,
                status_text: String::new(),
                response_headers: Vec::new(),
                body: String::new(),
                body_truncated: false,
                duration_ms,
                timed_out,
                ok: false,
                error: format!("transport error: {}", e),
            });
        }
    };

    let status = resp.status();
    let response_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (
            k.to_string(),
            v.to_str().unwrap_or("<non-utf8>").to_string(),
        ))
        .collect();

    let body_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return Ok(HttpFetchRun {
                url: url.to_string(),
                method: method_up,
                status: Some(status.as_u16()),
                status_text: status.canonical_reason().unwrap_or("").to_string(),
                response_headers,
                body: String::new(),
                body_truncated: false,
                duration_ms,
                timed_out: false,
                ok: false,
                error: format!("failed to read body: {}", e),
            });
        }
    };
    let mut body_str = String::from_utf8_lossy(&body_bytes).into_owned();
    let body_truncated = body_str.len() > HTTP_FETCH_MAX_BODY_BYTES;
    if body_truncated {
        body_str.truncate(HTTP_FETCH_MAX_BODY_BYTES);
        body_str.push_str("\n[\u{2026} body truncated]");
    }

    Ok(HttpFetchRun {
        url: url.to_string(),
        method: method_up,
        status: Some(status.as_u16()),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        response_headers,
        body: body_str,
        body_truncated,
        duration_ms,
        timed_out: false,
        ok: true,
        error: String::new(),
    })
}

/// Translate an `HttpFetchRun` into the JSON payload sent back to the LLM.
/// Includes a pre-formatted `evidence_detail` the model can paste
/// verbatim into a Finding's `evidence: source=runtime; detail=...` line.
pub fn to_http_fetch_payload(run: &HttpFetchRun) -> Value {
    let evidence_detail = if run.ok {
        format!(
            "runtime: {} {} \u{2192} {} {} ({} ms{}",
            run.method,
            run.url,
            run.status
                .map(|s| s.to_string())
                .unwrap_or_else(|| "?".into()),
            run.status_text,
            run.duration_ms,
            if run.body_truncated {
                ", body truncated)"
            } else {
                ")"
            },
        )
    } else {
        format!(
            "runtime: {} {} \u{2192} TRANSPORT ERROR {}: {}",
            run.method,
            run.url,
            if run.timed_out { "(timed out)" } else { "" },
            run.error,
        )
    };
    json!({
        "url": run.url,
        "method": run.method,
        "status": run.status,
        "status_text": run.status_text,
        "response_headers": run.response_headers
            .iter()
            .map(|(k, v)| json!({ "name": k, "value": v }))
            .collect::<Vec<_>>(),
        "body": run.body,
        "body_truncated": run.body_truncated,
        "duration_ms": run.duration_ms,
        "timed_out": run.timed_out,
        "ok": run.ok,
        "error": run.error,
        "evidence_detail": evidence_detail,
    })
}

fn parse_generic_path_line_col(line: &str) -> Option<Diagnostic> {
    let mut iter = line.splitn(4, ':');
    let file = iter.next()?.trim().to_string();
    let l: u32 = iter.next()?.trim().parse().ok()?;
    let c: u32 = iter.next()?.trim().parse().ok()?;
    let msg = iter.next()?.trim().to_string();
    if file.is_empty() || msg.is_empty() {
        return None;
    }
    if !msg.to_ascii_lowercase().contains("error")
        && !msg.to_ascii_lowercase().contains("fail")
        && !msg.to_ascii_lowercase().contains("assert")
    {
        return None;
    }
    Some(Diagnostic {
        source: "test".into(),
        file: file.replace('\\', "/"),
        line: l,
        col: c,
        severity: Severity::Error,
        code: String::new(),
        message: collapse_ws(&msg),
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
// Dev server URL detection (substrate v4 companion)
//
// Pure inference: looks at the project shape and returns a sensible
// http://localhost:PORT default for the runtime probe to target. Used by
// /audit and /build when the user hasn't pinned `agent.dev_server_url`
// in config. Returning None is a valid outcome — the caller falls back
// to localhost:3000 per the system prompt.
// ---------------------------------------------------------------------------

/// Common framework dev-server defaults. Sorted by signal strength: an
/// explicit `port:` literal in a config file always wins over a guess
/// from the dependency list, which always wins over no signal at all.
///
/// Returns a string like "http://localhost:5173" so the agent can use
/// it verbatim in `http_fetch` calls.
pub fn detect_dev_server_url(cwd: &Path) -> Option<String> {
    // 1. Vite config with an explicit `port: <N>` literal.
    for name in [
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mjs",
        "vite.config.cjs",
    ] {
        if let Some(port) = read_port_literal(&cwd.join(name)) {
            return Some(format!("http://localhost:{}", port));
        }
    }
    // 2. Next.js config (rare to override the port; default is 3000).
    for name in [
        "next.config.ts",
        "next.config.js",
        "next.config.mjs",
    ] {
        if cwd.join(name).is_file() {
            return Some("http://localhost:3000".into());
        }
    }
    // 3. package.json shape — vite vs next vs node-server fallback.
    let pkg_path = cwd.join("package.json");
    if pkg_path.is_file() {
        if let Ok(text) = std::fs::read_to_string(&pkg_path) {
            if let Ok(json) = serde_json::from_str::<Value>(&text) {
                // a) Look for `dev` script with --port=N or -p N.
                if let Some(scripts) = json.get("scripts").and_then(|v| v.as_object()) {
                    for key in ["dev", "start", "serve"] {
                        if let Some(script) = scripts.get(key).and_then(|v| v.as_str()) {
                            if let Some(port) = parse_port_flag(script) {
                                return Some(format!("http://localhost:{}", port));
                            }
                        }
                    }
                }
                // b) Dependency-derived defaults.
                let deps = collect_deps(&json);
                if deps.contains("vite") {
                    return Some("http://localhost:5173".into());
                }
                if deps.contains("next") {
                    return Some("http://localhost:3000".into());
                }
                if deps.contains("@remix-run/dev") {
                    return Some("http://localhost:3000".into());
                }
                if deps.contains("@sveltejs/kit") {
                    return Some("http://localhost:5173".into());
                }
                if deps.contains("@nestjs/core") || deps.contains("express") || deps.contains("fastify") {
                    return Some("http://localhost:3000".into());
                }
            }
        }
    }
    // 4. Python frameworks.
    if cwd.join("manage.py").is_file() {
        return Some("http://localhost:8000".into());
    }
    // pyproject.toml + a fastapi/flask/django dep \u{2192} their conventional ports.
    if let Some(port) = detect_python_dev_port(cwd) {
        return Some(format!("http://localhost:{}", port));
    }
    // 5. Rust web frameworks: nothing reliable to detect; let caller fall back.
    None
}

/// Read a config file and pull a literal `port: <N>` out of the source.
/// Intentionally regex-free: we only match the simplest shape (`port:
/// 1234` or `port = 1234`) so we never invent a port that doesn't
/// actually appear in the file.
fn read_port_literal(path: &Path) -> Option<u16> {
    if !path.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    parse_port_literal(&text)
}

/// Find the first `port: NNNN` (or `port = NNNN`) anywhere in `text`,
/// matching `port` as a whole-word token. This deliberately handles
/// the common embedded shape `server: { port: 4321 }` where the
/// keyword is mid-line. Word-boundary checks prevent false matches
/// on `reportPort` / `important` / `passport`.
fn parse_port_literal(text: &str) -> Option<u16> {
    for line in text.lines() {
        let bytes = line.as_bytes();
        let mut start = 0;
        while let Some(off) = line[start..].find("port") {
            let abs = start + off;
            let prev_ok = abs == 0 || {
                let p = bytes[abs - 1];
                !p.is_ascii_alphanumeric() && p != b'_'
            };
            let after_keyword = abs + 4;
            let next_ok = after_keyword >= bytes.len() || {
                let n = bytes[after_keyword];
                !n.is_ascii_alphanumeric() && n != b'_'
            };
            if prev_ok && next_ok {
                let rest = line[after_keyword..].trim_start();
                let after_sep = rest
                    .strip_prefix(':')
                    .or_else(|| rest.strip_prefix('='));
                if let Some(after_sep) = after_sep {
                    let after_sep = after_sep.trim_start();
                    let end = after_sep
                        .find(|c: char| !c.is_ascii_digit())
                        .unwrap_or(after_sep.len());
                    if end > 0 {
                        if let Ok(n) = after_sep[..end].parse::<u16>() {
                            if n > 0 {
                                return Some(n);
                            }
                        }
                    }
                }
            }
            start = abs + 4;
        }
    }
    None
}

/// Pull a port out of a npm-script command line, e.g.
/// `vite --port=5173` or `next dev -p 4000` or `node server.js --port 8080`.
fn parse_port_flag(script: &str) -> Option<u16> {
    let tokens: Vec<&str> = script.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() {
        let t = tokens[i];
        // --port=N / -p=N
        for prefix in ["--port=", "-p="] {
            if let Some(rest) = t.strip_prefix(prefix) {
                if let Ok(n) = rest.parse::<u16>() {
                    if n > 0 {
                        return Some(n);
                    }
                }
            }
        }
        // --port N / -p N
        if (t == "--port" || t == "-p") && i + 1 < tokens.len() {
            if let Ok(n) = tokens[i + 1].parse::<u16>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
        i += 1;
    }
    None
}

/// Collect dependency names from `dependencies` + `devDependencies` into a
/// HashSet of borrowed strings for cheap membership checks.
fn collect_deps(json: &Value) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for key in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(obj) = json.get(key).and_then(|v| v.as_object()) {
            for k in obj.keys() {
                out.insert(k.clone());
            }
        }
    }
    out
}

/// Inspect `pyproject.toml` (or `requirements.txt`) for fastapi/flask/etc.
/// Returns the conventional port for the first match.
fn detect_python_dev_port(cwd: &Path) -> Option<u16> {
    let candidates = ["pyproject.toml", "requirements.txt", "poetry.lock"];
    for name in candidates {
        let path = cwd.join(name);
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).ok()?;
        let lower = text.to_ascii_lowercase();
        if lower.contains("fastapi") || lower.contains("uvicorn") {
            return Some(8000);
        }
        if lower.contains("flask") {
            return Some(5000);
        }
        if lower.contains("django") {
            return Some(8000);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Override validation
// ---------------------------------------------------------------------------

/// Public re-export of `validate_argv` for sibling substrate cells that
/// accept argv overrides. Exists so `lsp.rs` (and future cells) get the
/// same hardening as `run_typecheck` without duplicating the rules.
pub fn validate_argv_public(argv: &[String]) -> Result<(), String> {
    validate_argv(argv)
}

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
    run_with_timeout_env(argv, cwd, timeout, &[])
}

fn run_with_timeout_env(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
    extra_env: &[(&str, &str)],
) -> Result<(Output, bool), String> {
    use std::io::Read;
    use std::sync::mpsc;
    use std::thread;

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.current_dir(cwd);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn fresh_tmp() -> PathBuf {
        let dir = env::temp_dir().join(format!("prism-diag-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create tmp dir");
        fs::canonicalize(&dir).expect("canonicalize tmp")
    }

    fn spawn_http_server(
        status_line: &str,
        response_headers: &[(&str, &str)],
        body: &str,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("server addr");
        let status_line = status_line.to_string();
        let body = body.to_string();
        let headers: Vec<(String, String)> = response_headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept client");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set read timeout");
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).expect("read request");
            let request = String::from_utf8_lossy(&buf[..n]).into_owned();

            let mut response = format!(
                "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                status_line,
                body.len()
            );
            for (k, v) in headers {
                response.push_str(&format!("{}: {}\r\n", k, v));
            }
            response.push_str("\r\n");
            response.push_str(&body);
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            stream.flush().expect("flush response");
            request
        });
        (format!("http://{}/probe", addr), handle)
    }

    fn spawn_hanging_http_server(delay: Duration) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind hanging server");
        let addr = listener.local_addr().expect("server addr");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept client");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set read timeout");
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            thread::sleep(delay);
        });
        (format!("http://{}/slow", addr), handle)
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

    // -- run_tests substrate cell -------------------------------------

    #[test]
    fn parses_cargo_test_failure_line() {
        let raw = "\
running 3 tests
test foo::bar ... FAILED
test foo::baz ... ok
test foo::qux ... FAILED
";
        let out = parse_cargo_test_failures(raw);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].source, "test");
        assert!(out[0].file.contains("foo::bar"));
        assert!(out[1].file.contains("foo::qux"));
    }

    #[test]
    fn parses_pytest_failure_lines() {
        let raw = "\
FAILED tests/test_x.py::test_login - AssertionError: 401 != 200
FAILED tests/test_y.py::test_logout
";
        let out = parse_pytest_failures(raw);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].source, "test");
        assert_eq!(out[0].file, "tests/test_x.py");
        assert!(out[0].message.contains("AssertionError"));
        assert_eq!(out[1].file, "tests/test_y.py");
    }

    #[test]
    fn parses_go_test_failure_lines() {
        let raw = "\
--- FAIL: TestLogin (0.01s)
--- FAIL: TestLogout (0.00s)
";
        let out = parse_go_test_failures(raw);
        assert_eq!(out.len(), 2);
        assert!(out[0].file.contains("TestLogin"));
        assert!(out[1].file.contains("TestLogout"));
    }

    #[test]
    fn detects_node_test_script_via_pm() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts": {"test": "vitest run"}}"#,
        )
        .unwrap();
        fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        let argv = detect_test_command(&dir).expect("should detect");
        assert_eq!(argv, vec!["pnpm", "run", "test"]);
    }

    #[test]
    fn detects_vitest_via_dependency_when_no_script() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts": {}, "devDependencies": {"vitest": "^1.0.0"}}"#,
        )
        .unwrap();
        let argv = detect_test_command(&dir).expect("should detect");
        assert_eq!(argv[0], "npm");
        assert!(argv.iter().any(|s| s == "vitest"));
    }

    #[test]
    fn detects_cargo_test_when_cargo_toml_present() {
        let dir = fresh_tmp();
        fs::write(dir.join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        let argv = detect_test_command(&dir).expect("should detect");
        assert_eq!(argv[0], "cargo");
        assert!(argv.iter().any(|s| s == "test"));
    }

    #[test]
    fn run_tests_errors_on_empty_cwd() {
        let r = run_tests("", None, None);
        assert!(r.is_err());
    }

    #[test]
    fn run_tests_uses_override_argv_passing() {
        let dir = fresh_tmp();
        // `true` exits 0 without printing anything: substrate should
        // mark the suite as passed with no parsed failures.
        let argv = vec!["true".to_string()];
        let r = run_tests(
            &dir.to_string_lossy(),
            Some(&argv),
            Some(Duration::from_secs(5)),
        )
        .expect("should run");
        assert!(r.passed);
        assert_eq!(r.exit_code, Some(0));
        assert!(r.failures.is_empty());
    }

    #[test]
    fn run_tests_uses_override_argv_failing() {
        let dir = fresh_tmp();
        // `false` exits 1: passed=false even if no failures are parsed.
        let argv = vec!["false".to_string()];
        let r = run_tests(
            &dir.to_string_lossy(),
            Some(&argv),
            Some(Duration::from_secs(5)),
        )
        .expect("should run");
        assert!(!r.passed);
        assert_eq!(r.exit_code, Some(1));
    }

    #[test]
    fn to_test_payload_has_evidence_per_failure() {
        let run = TestRun {
            command: vec!["cargo".into(), "test".into()],
            exit_code: Some(101),
            duration_ms: 250,
            failures: vec![Diagnostic {
                source: "test".into(),
                file: "foo::bar".into(),
                line: 0,
                col: 0,
                severity: Severity::Error,
                code: String::new(),
                message: "test foo::bar failed".into(),
            }],
            failures_truncated: false,
            raw: "raw".into(),
            raw_truncated: false,
            timed_out: false,
            passed: false,
        };
        let v = to_test_payload(&run);
        assert_eq!(v["passed"], false);
        assert_eq!(v["failures"][0]["severity"], "error");
        assert_eq!(v["failures"][0]["confidence"], "confirmed");
        assert_eq!(v["failures"][0]["evidence"][0]["source"], "test");
    }

    // -- end run_tests --

    #[tokio::test]
    async fn run_http_fetch_returns_response_details_from_local_server() {
        let (url, handle) = spawn_http_server(
            "201 Created",
            &[("Content-Type", "text/plain"), ("X-Test", "runtime")],
            "hello",
        );
        let run = run_http_fetch(
            &url,
            "POST",
            &[("X-Token".into(), "abc".into())],
            Some("{\"ok\":true}"),
            Some(Duration::from_secs(3)),
        )
        .await
        .expect("http_fetch should succeed");

        let request = handle.join().expect("join server thread");
        let request_lower = request.to_ascii_lowercase();
        assert!(
            request.starts_with("POST /probe HTTP/1.1"),
            "unexpected request: {}",
            request
        );
        assert!(
            request_lower.contains("x-token: abc"),
            "missing request header: {}",
            request
        );
        assert!(
            request.contains("{\"ok\":true}"),
            "missing request body: {}",
            request
        );

        assert!(run.ok);
        assert_eq!(run.url, url);
        assert_eq!(run.method, "POST");
        assert_eq!(run.status, Some(201));
        assert_eq!(run.status_text, "Created");
        assert_eq!(run.body, "hello");
        assert!(!run.body_truncated);
        assert!(!run.timed_out);
        assert!(run.error.is_empty());
        assert!(
            run.response_headers
                .iter()
                .any(|(k, v)| k == "content-type" && v == "text/plain")
        );
        assert!(
            run.response_headers
                .iter()
                .any(|(k, v)| k == "x-test" && v == "runtime")
        );
    }

    #[tokio::test]
    async fn run_http_fetch_times_out_without_promoting_transport_failure() {
        let (url, handle) = spawn_hanging_http_server(Duration::from_millis(250));
        let run = run_http_fetch(&url, "GET", &[], None, Some(Duration::from_millis(75)))
            .await
            .expect("http_fetch should return substrate failure, not Err");
        handle.join().expect("join hanging server thread");

        assert!(!run.ok);
        assert!(run.timed_out);
        assert_eq!(run.status, None);
        assert!(run.body.is_empty());
        assert!(
            run.error.contains("transport error"),
            "unexpected error: {}",
            run.error
        );
    }

    #[test]
    fn to_http_fetch_payload_emits_expected_keys_and_evidence() {
        let run = HttpFetchRun {
            url: "http://localhost:3000/api/health".into(),
            method: "GET".into(),
            status: Some(200),
            status_text: "OK".into(),
            response_headers: vec![("content-type".into(), "application/json".into())],
            body: "{\"ok\":true}".into(),
            body_truncated: false,
            duration_ms: 42,
            timed_out: false,
            ok: true,
            error: String::new(),
        };
        let v = to_http_fetch_payload(&run);
        let evidence = v["evidence_detail"]
            .as_str()
            .expect("evidence_detail should be a string");

        assert_eq!(v["url"], "http://localhost:3000/api/health");
        assert_eq!(v["method"], "GET");
        assert_eq!(v["status"], 200);
        assert_eq!(v["status_text"], "OK");
        assert_eq!(v["ok"], true);
        assert_eq!(v["response_headers"][0]["name"], "content-type");
        assert_eq!(v["response_headers"][0]["value"], "application/json");
        assert!(evidence.contains("runtime: GET http://localhost:3000/api/health"));
        assert!(evidence.contains("200 OK"));
        assert!(evidence.contains("42 ms"));
    }

    // -- detect_dev_server_url --------------------------------------------

    #[test]
    fn dev_server_url_from_vite_config_port_literal() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("vite.config.ts"),
            "import { defineConfig } from 'vite';\n\
             export default defineConfig({ server: { port: 4321, host: true } });",
        )
        .unwrap();
        let url = detect_dev_server_url(&dir).expect("vite literal should resolve");
        assert_eq!(url, "http://localhost:4321");
    }

    #[test]
    fn dev_server_url_from_dev_script_port_flag() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts": {"dev": "next dev -p 4000"}, "dependencies": {"next": "^14"}}"#,
        )
        .unwrap();
        let url = detect_dev_server_url(&dir).expect("explicit port flag wins");
        assert_eq!(url, "http://localhost:4000");
    }

    #[test]
    fn dev_server_url_from_vite_dependency() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts": {"dev": "vite"}, "devDependencies": {"vite": "^5.0.0"}}"#,
        )
        .unwrap();
        let url = detect_dev_server_url(&dir).expect("vite dep should map to 5173");
        assert_eq!(url, "http://localhost:5173");
    }

    #[test]
    fn dev_server_url_from_next_dependency() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("package.json"),
            r#"{"dependencies": {"next": "^15.0.0"}}"#,
        )
        .unwrap();
        let url = detect_dev_server_url(&dir).expect("next dep should map to 3000");
        assert_eq!(url, "http://localhost:3000");
    }

    #[test]
    fn dev_server_url_from_django_manage_py() {
        let dir = fresh_tmp();
        fs::write(dir.join("manage.py"), "# django").unwrap();
        let url = detect_dev_server_url(&dir).expect("manage.py should map to 8000");
        assert_eq!(url, "http://localhost:8000");
    }

    #[test]
    fn dev_server_url_from_fastapi_pyproject() {
        let dir = fresh_tmp();
        fs::write(
            dir.join("pyproject.toml"),
            "[tool.poetry.dependencies]\nfastapi = \"^0.110\"\n",
        )
        .unwrap();
        let url = detect_dev_server_url(&dir).expect("fastapi should map to 8000");
        assert_eq!(url, "http://localhost:8000");
    }

    #[test]
    fn dev_server_url_returns_none_for_unknown_project_shape() {
        let dir = fresh_tmp();
        // Only a Cargo.toml \u{2014} no detectable web framework.
        fs::write(dir.join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        assert_eq!(detect_dev_server_url(&dir), None);
    }

    #[test]
    fn parse_port_flag_handles_equals_and_space_forms() {
        assert_eq!(parse_port_flag("vite --port=5173"), Some(5173));
        assert_eq!(parse_port_flag("next dev -p 4000"), Some(4000));
        assert_eq!(parse_port_flag("node server.js --port 8080"), Some(8080));
        assert_eq!(parse_port_flag("vite"), None);
        assert_eq!(parse_port_flag("vite --port=0"), None);
    }

    #[test]
    fn parse_port_literal_handles_colon_and_equals() {
        assert_eq!(parse_port_literal("server: { port: 4321 }"), Some(4321));
        assert_eq!(parse_port_literal("port = 9000"), Some(9000));
        assert_eq!(parse_port_literal("// no port here"), None);
    }

    // -- end detect_dev_server_url ---------------------------------------

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
