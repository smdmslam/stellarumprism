//! Substrate v8: `run_shell` cell.
//!
//! Run a shell command in the project's cwd (or a relative subdirectory)
//! and return its stdout / stderr / exit code / duration / timed-out
//! status. The cell is **always** invoked through the user-approval flow
//! at the agent layer; this module enforces deeper rails that don't
//! depend on the approval card:
//!
//! 1. **Argv-array required.** Empty argv is rejected. argv[0] is also
//!    sanity-checked for shell metacharacters (a literal `|` in the
//!    program name is almost certainly a mistake).
//! 2. **Hardcoded deny-list.** Patterns like `rm -rf /`, the classic
//!    fork bomb, and `dd of=/dev/...` are rejected before execution and
//!    NEVER pass the approval card \u2014 even with session-approval set.
//!    The list is short, hardcoded, and not configurable.
//! 3. **Optional argv[0] allowlist** (driven by config). When set, only
//!    matching programs are runnable; non-matching are rejected with a
//!    precise error before the approval card is shown.
//! 4. **Output cap** at `MAX_STREAM_BYTES` per stream.
//! 5. **Per-call timeout**, default `DEFAULT_TIMEOUT_SECS`, max
//!    `MAX_TIMEOUT_SECS`.
//! 6. **cwd scoped.** The optional `cwd` argument resolves under the
//!    project cwd via the same canonicalize-and-prefix rail
//!    `tools::validate_write_path` uses for write_file.
//!
//! What this cell DOES NOT do (deliberate v1 cuts):
//!
//! - No interactive PTY surface. Foreground subprocess only; `bash -i`
//!   and friends will block on stdin if they expect input.
//! - No streaming output to xterm. Buffer-then-return; v2 concern.
//! - No background processes; every invocation terminates and returns.
//! - No env-variable injection beyond the user's shell env at Prism start.

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Cap on bytes captured per stream (stdout / stderr). Sized so a
/// chatty `npm install` log fits without bloating the LLM context.
pub const MAX_STREAM_BYTES: usize = 32 * 1024;

/// Default timeout for a `run_shell` call when the caller doesn't pass
/// `timeout_secs`. Sized for typical short-lived commands (rsync, git
/// init, mkdir, mv). Longer-running services should NOT use run_shell
/// \u2014 they belong in the existing PTY blocks UI.
pub const DEFAULT_TIMEOUT_SECS: u64 = 60;

/// Hard ceiling on the per-call timeout so a runaway override can't
/// stall the agent loop indefinitely. 10 minutes covers cold installs
/// of large dependency trees; anything beyond is the wrong tool.
pub const MAX_TIMEOUT_SECS: u64 = 600;

/// Patterns that are NEVER allowed regardless of approval state. Each
/// pattern is matched substring-style against the joined argv string
/// (space-separated). The list is intentionally short \u2014 it's a
/// last-line-of-defense against the most common destructors, not an
/// exhaustive sandbox. The user's own judgement (via the approval
/// card) is the real safety mechanism.
///
/// Adding entries here is a deliberate UX call: each blocks an entire
/// phrasing of a destructive command at the substrate layer, with no
/// way for users to bypass via session-approval.
const DESTRUCTIVE_PATTERNS: &[&str] = &[
    // Filesystem nukes.
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf $HOME",
    // Fork bomb (the classic `:(){ :|:& };:`).
    ":(){ :|:&",
    // Direct disk writes.
    "dd of=/dev/sd",
    "dd of=/dev/disk",
    "dd of=/dev/nvme",
    "mkfs.",
    // Recursive ownership/perm rewrites at root.
    "chown -R / ",
    "chown -R /:",
    "chmod -R 777 /",
    "chmod -R 000 /",
    // Pipe-to-shell from the network (the curl|sh / wget|sh pattern).
    // We block the pipe itself rather than curl/wget calls in general
    // because legitimate curl usage with `-s`, `-S`, etc. is common; the
    // dangerous shape is the pipe into a shell, which has no benign use.
    "| sh",
    "| bash",
    // -----------------------------------------------------------------------
    // PATH GUARD: Shield internal binaries from agent gaze.
    // -----------------------------------------------------------------------
    "/Applications/Prism.app",
];

/// Caller-supplied spec for a single run_shell invocation.
#[derive(Debug, Clone, Deserialize)]
pub struct RunShellSpec {
    /// argv-array. argv[0] is the program; argv[1..] are arguments.
    /// Required; empty arrays are rejected.
    pub command: Vec<String>,
    /// Optional working directory, relative to the project cwd. When
    /// unset, the project cwd is used directly.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Per-call timeout in seconds. Capped at `MAX_TIMEOUT_SECS`.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Optional stdin to feed the process. Useful for tools like
    /// `git apply --` or `sort` that read from stdin.
    #[serde(default)]
    pub stdin: Option<String>,
}

/// Result of a single run_shell invocation. All fields are populated
/// even on partial failure so the LLM can reason about what happened.
#[derive(Debug, Clone, Serialize)]
pub struct RunShellOutcome {
    /// argv as it was actually invoked (post-validation).
    pub command: Vec<String>,
    /// Absolute working directory the subprocess saw.
    pub cwd: String,
    /// Process exit code; None if the kernel killed the process before
    /// it returned a status (rare; the timeout path returns Some(-1)
    /// or whatever the kill yielded).
    pub exit_code: Option<i32>,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: u128,
    /// True iff the process was killed because it exceeded `timeout`.
    pub timed_out: bool,
    /// Captured stdout, lossy-UTF-8, capped at `MAX_STREAM_BYTES`.
    pub stdout: String,
    /// Same shape for stderr.
    pub stderr: String,
    /// True iff stdout was clipped at the cap.
    pub stdout_truncated: bool,
    /// True iff stderr was clipped at the cap.
    pub stderr_truncated: bool,
}

/// Errors callers want to distinguish before invoking. Mostly used by
/// the tool layer to render specific approval-card / xterm messages
/// without re-parsing free-text errors.
#[derive(Debug, Clone)]
pub enum RunShellRejection {
    /// argv was empty or argv[0] contained shell metacharacters.
    InvalidArgv(String),
    /// Caller's argv matched a hardcoded destructive pattern.
    DestructivePattern { pattern: String },
    /// Caller's argv[0] wasn't on the configured allowlist.
    NotInAllowlist { program: String },
    /// `cwd` resolved outside the project cwd subtree.
    CwdOutsideProject(String),
    /// The project cwd is unset (shell integration probably hasn't
    /// emitted OSC 7 yet).
    NoCwd,
}

impl RunShellRejection {
    pub fn message(&self) -> String {
        match self {
            Self::InvalidArgv(reason) => format!("invalid argv: {}", reason),
            Self::DestructivePattern { pattern } => format!(
                "refusing to run \u{2014} argv matches the destructive pattern '{}'. \
                 This block is hardcoded; even session-approval cannot bypass it.",
                pattern
            ),
            Self::NotInAllowlist { program } => format!(
                "refusing to run \u{2014} program '{}' is not on the run_shell allowlist. \
                 Add it to `agent.run_shell_allowlist` in ~/.config/prism/config.toml \
                 if you want this to be auto-runnable.",
                program
            ),
            Self::CwdOutsideProject(p) => format!(
                "refusing to run with cwd '{}' \u{2014} must be inside the project root",
                p
            ),
            Self::NoCwd => "cannot run: project cwd is unknown (shell integration may not be started)".into(),
        }
    }
}

/// Validate a spec without running it. Returns the resolved (argv, cwd,
/// timeout) tuple ready for execution, or a typed rejection. Pure
/// function; no I/O beyond stat'ing the cwd canonicalization. Exposed
/// publicly so the tool layer can render specific approval-card text
/// when validation fails before approval is even requested.
pub fn validate(
    spec: &RunShellSpec,
    project_cwd: &str,
    allowlist: Option<&[String]>,
) -> Result<(Vec<String>, PathBuf, Duration), RunShellRejection> {
    if spec.command.is_empty() {
        return Err(RunShellRejection::InvalidArgv("argv is empty".into()));
    }
    let argv0 = &spec.command[0];
    if argv0.is_empty() {
        return Err(RunShellRejection::InvalidArgv("argv[0] is empty".into()));
    }
    // argv[0] must not be a shell expression; the shell metacharacter
    // would silently fail at runtime since we run via Command (no
    // shell), and would be a sign the model picked the wrong shape.
    for c in argv0.chars() {
        if matches!(c, '|' | '&' | ';' | '<' | '>' | '$' | '`' | '\n') {
            return Err(RunShellRejection::InvalidArgv(format!(
                "argv[0] contains shell metacharacter '{}'; pass argv array, not a shell string \
                 (e.g. [\"bash\", \"-c\", \"<expr>\"] for pipelines)",
                c
            )));
        }
    }
    // Destructive-pattern check: substring match on the joined argv.
    let joined = spec.command.join(" ");
    for pat in DESTRUCTIVE_PATTERNS {
        if joined.contains(pat) {
            return Err(RunShellRejection::DestructivePattern {
                pattern: (*pat).to_string(),
            });
        }
    }
    // Allowlist (when configured).
    if let Some(list) = allowlist {
        if !list.is_empty() {
            // We compare on the basename of argv[0] so absolute and
            // relative invocations behave the same: ['/usr/bin/git', ...]
            // and ['git', ...] both match an allowlist entry of "git".
            let basename = Path::new(argv0)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(argv0);
            if !list.iter().any(|entry| entry == basename || entry == argv0) {
                return Err(RunShellRejection::NotInAllowlist {
                    program: argv0.clone(),
                });
            }
        }
    }
    // cwd resolution + scope check.
    if project_cwd.trim().is_empty() {
        return Err(RunShellRejection::NoCwd);
    }
    let project_root = Path::new(project_cwd);
    let project_canon = project_root.canonicalize().map_err(|_| {
        RunShellRejection::CwdOutsideProject(project_cwd.to_string())
    })?;
    let target_dir: PathBuf = match spec.cwd.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            // Reject `..` segments outright; same rule as
            // validate_write_path.
            if Path::new(p).components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(RunShellRejection::CwdOutsideProject(p.to_string()));
            }
            let joined = if Path::new(p).is_absolute() {
                PathBuf::from(p)
            } else {
                project_canon.join(p)
            };
            let canon = joined
                .canonicalize()
                .map_err(|_| RunShellRejection::CwdOutsideProject(p.to_string()))?;
            if !canon.starts_with(&project_canon) {
                return Err(RunShellRejection::CwdOutsideProject(p.to_string()));
            }
            canon
        }
        _ => project_canon.clone(),
    };
    // Timeout (clamped).
    let timeout_secs = spec
        .timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);
    let timeout = Duration::from_secs(timeout_secs);
    Ok((spec.command.clone(), target_dir, timeout))
}

/// Execute a validated spec. Synchronous \u2014 we call into
/// `diagnostics::run_with_timeout_public` which already implements the
/// drain-on-thread + poll-until-deadline subprocess machinery the rest
/// of the substrate uses. Mirroring that path keeps timeout semantics
/// consistent across cells.
pub fn run_shell(
    spec: RunShellSpec,
    project_cwd: &str,
    allowlist: Option<&[String]>,
) -> Result<RunShellOutcome, String> {
    let (argv, cwd, timeout) =
        validate(&spec, project_cwd, allowlist).map_err(|r| r.message())?;
    let started = Instant::now();
    // Note: we don't currently wire spec.stdin into run_with_timeout_public
    // because the existing helper closes stdin. Tools that need stdin
    // should pass a file via `<` shell-form, or we extend the helper
    // in a follow-up. v1 explicitly skips it.
    if spec.stdin.is_some() {
        return Err(
            "stdin is not yet supported in run_shell v1; use \
             [\"bash\", \"-c\", \"... < file\"] or pass via the env"
                .into(),
        );
    }
    let (output, timed_out) =
        crate::diagnostics::run_with_timeout_public(&argv, &cwd, timeout)?;
    let duration_ms = started.elapsed().as_millis();
    let (stdout, stdout_truncated) = clamp_stream(&output.stdout);
    let (stderr, stderr_truncated) = clamp_stream(&output.stderr);
    Ok(RunShellOutcome {
        command: argv,
        cwd: cwd.to_string_lossy().into_owned(),
        exit_code: output.status.code(),
        duration_ms,
        timed_out,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

fn clamp_stream(bytes: &[u8]) -> (String, bool) {
    if bytes.len() <= MAX_STREAM_BYTES {
        return (String::from_utf8_lossy(bytes).into_owned(), false);
    }
    let mut s = String::from_utf8_lossy(&bytes[..MAX_STREAM_BYTES]).into_owned();
    s.push_str("\n[\u{2026} truncated]\n");
    (s, true)
}

/// Build the JSON payload sent back to the LLM.
pub fn to_run_shell_payload(run: &RunShellOutcome) -> Value {
    json!({
        "command": run.command,
        "cwd": run.cwd,
        "exit_code": run.exit_code,
        "duration_ms": run.duration_ms,
        "timed_out": run.timed_out,
        "stdout": run.stdout,
        "stderr": run.stderr,
        "stdout_truncated": run.stdout_truncated,
        "stderr_truncated": run.stderr_truncated,
    })
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
        let dir = env::temp_dir().join(format!("prism-run_shell-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create tmp dir");
        fs::canonicalize(&dir).expect("canonicalize tmp")
    }

    fn spec(argv: &[&str]) -> RunShellSpec {
        RunShellSpec {
            command: argv.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            timeout_secs: None,
            stdin: None,
        }
    }

    #[test]
    fn happy_path_captures_stdout_and_exit_code() {
        let dir = fresh_tmp();
        let s = spec(&["echo", "hello"]);
        let out = run_shell(s, &dir.to_string_lossy(), None).expect("run");
        assert_eq!(out.exit_code, Some(0));
        assert!(out.stdout.contains("hello"));
        assert!(out.stderr.is_empty());
        assert!(!out.timed_out);
        assert!(!out.stdout_truncated);
        assert!(!out.stderr_truncated);
    }

    #[test]
    fn captures_stderr_separately_from_stdout() {
        let dir = fresh_tmp();
        // sh -c writes "out" to stdout and "err" to stderr.
        let s = spec(&["sh", "-c", "echo out; echo err >&2"]);
        let out = run_shell(s, &dir.to_string_lossy(), None).expect("run");
        assert!(out.stdout.contains("out"));
        assert!(out.stderr.contains("err"));
    }

    #[test]
    fn non_zero_exit_code_is_returned_not_errored() {
        let dir = fresh_tmp();
        let s = spec(&["sh", "-c", "exit 7"]);
        let out = run_shell(s, &dir.to_string_lossy(), None).expect("run");
        assert_eq!(out.exit_code, Some(7));
    }

    #[test]
    fn timeout_kills_long_running_process() {
        let dir = fresh_tmp();
        let s = RunShellSpec {
            command: vec!["sleep".into(), "30".into()],
            cwd: None,
            timeout_secs: Some(1),
            stdin: None,
        };
        let started = Instant::now();
        let out = run_shell(s, &dir.to_string_lossy(), None).expect("run");
        assert!(out.timed_out, "expected timed_out=true");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "should have been killed inside the timeout window"
        );
    }

    #[test]
    fn empty_argv_is_rejected() {
        let dir = fresh_tmp();
        let s = RunShellSpec {
            command: vec![],
            cwd: None,
            timeout_secs: None,
            stdin: None,
        };
        let r = run_shell(s, &dir.to_string_lossy(), None);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("argv is empty"));
    }

    #[test]
    fn shell_metachar_in_argv0_is_rejected() {
        let dir = fresh_tmp();
        let s = spec(&["foo|bar"]);
        let r = run_shell(s, &dir.to_string_lossy(), None);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("shell metacharacter"));
    }

    #[test]
    fn destructive_pattern_is_rejected_before_execution() {
        // `rm -rf /` is the canonical forbidden pattern; even with
        // session-approval the substrate refuses.
        let dir = fresh_tmp();
        let s = spec(&["rm", "-rf", "/"]);
        let r = run_shell(s, &dir.to_string_lossy(), None);
        assert!(r.is_err(), "destructive command must be rejected");
        let msg = r.unwrap_err();
        assert!(
            msg.contains("destructive pattern") || msg.contains("rm -rf /"),
            "got error: {}",
            msg
        );
    }

    #[test]
    fn allowlist_blocks_non_listed_programs() {
        let dir = fresh_tmp();
        let allowed = vec!["git".to_string()];
        let s = spec(&["echo", "hi"]);
        let r = run_shell(s, &dir.to_string_lossy(), Some(&allowed));
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("allowlist"));
    }

    #[test]
    fn allowlist_passes_listed_programs_via_basename() {
        // `/bin/echo` should match an allowlist entry of "echo" via
        // basename matching.
        let dir = fresh_tmp();
        let allowed = vec!["echo".to_string()];
        let s = spec(&["/bin/echo", "hi"]);
        let r = run_shell(s, &dir.to_string_lossy(), Some(&allowed));
        assert!(r.is_ok(), "got: {:?}", r);
    }

    #[test]
    fn cwd_outside_project_is_rejected() {
        let dir = fresh_tmp();
        let s = RunShellSpec {
            command: vec!["echo".into(), "x".into()],
            // `..` traversal is rejected outright.
            cwd: Some("../somewhere".into()),
            timeout_secs: None,
            stdin: None,
        };
        let r = run_shell(s, &dir.to_string_lossy(), None);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("inside the project root"));
    }

    #[test]
    fn cwd_subdirectory_is_accepted() {
        let dir = fresh_tmp();
        fs::create_dir(dir.join("sub")).unwrap();
        let s = RunShellSpec {
            command: vec!["pwd".into()],
            cwd: Some("sub".into()),
            timeout_secs: None,
            stdin: None,
        };
        let out = run_shell(s, &dir.to_string_lossy(), None).expect("run");
        assert!(out.cwd.ends_with("sub"));
        assert!(out.stdout.contains("sub"));
    }

    #[test]
    fn empty_project_cwd_is_rejected_with_clear_error() {
        let s = spec(&["echo", "x"]);
        let r = run_shell(s, "", None);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("project cwd is unknown"));
    }

    #[test]
    fn stdout_cap_truncates_at_threshold() {
        let dir = fresh_tmp();
        // Emit 50 KB of 'a' \u2014 well above the 32 KB cap.
        let s = spec(&[
            "sh",
            "-c",
            "head -c 51200 /dev/urandom | base64 | head -c 51200",
        ]);
        let out = run_shell(s, &dir.to_string_lossy(), None).expect("run");
        assert!(out.stdout_truncated, "expected stdout_truncated=true");
        assert!(out.stdout.len() <= MAX_STREAM_BYTES + 64); // +marker
    }

    #[test]
    fn payload_includes_all_outcome_fields() {
        let outcome = RunShellOutcome {
            command: vec!["echo".into(), "ok".into()],
            cwd: "/tmp".into(),
            exit_code: Some(0),
            duration_ms: 12,
            timed_out: false,
            stdout: "ok\n".into(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let payload = to_run_shell_payload(&outcome);
        assert_eq!(payload["exit_code"], 0);
        assert_eq!(payload["duration_ms"], 12);
        assert_eq!(payload["timed_out"], false);
        assert_eq!(payload["stdout"], "ok\n");
        assert_eq!(payload["cwd"], "/tmp");
    }
}
