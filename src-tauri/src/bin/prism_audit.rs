//! `prism-audit` — substrate-only audit CLI for CI.
//!
//! Runs Prism's deterministic substrate cells (typecheck, run_tests,
//! lsp_diagnostics) against the working directory and emits a findings
//! report in the same JSON shape `src/findings.ts::AuditReport`
//! serializes. No OpenRouter API key, no LLM, no Tauri runtime — every
//! finding is grounded in the project's actual compiler / runner /
//! language server.
//!
//! Designed to drop into CI as `prism-audit --fail-on=error` so the
//! same substrate that powers `/audit` becomes a PR gate.
//!
//! Usage:
//!   prism-audit                    # human-readable text to stdout
//!   prism-audit --format=json      # JSON sidecar shape to stdout
//!   prism-audit --format=github    # GitHub Actions workflow annotations
//!   prism-audit --fail-on=error    # exit 2 on errors, 0 otherwise
//!   prism-audit --fail-on=warning  # exit 2 on errors OR warnings
//!   prism-audit --skip-tests       # don't run the test suite
//!   prism-audit --skip-lsp         # don't run lsp_diagnostics
//!   prism-audit --output=<path>    # write JSON to <path> as well
//!   prism-audit --quiet            # suppress non-finding chatter on stderr
//!   prism-audit --help

use std::process::ExitCode;
use std::time::Duration;

use prism_lib::diagnostics;
use prism_lib::lsp;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match parse_args(&args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("prism-audit: {}", e);
            eprintln!("try `prism-audit --help`");
            return ExitCode::from(2);
        }
    };
    if parsed.show_help {
        print_help();
        return ExitCode::SUCCESS;
    }
    if parsed.show_version {
        println!("prism-audit {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    let cwd = match std::env::current_dir() {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(e) => {
            eprintln!("prism-audit: cannot resolve cwd: {}", e);
            return ExitCode::from(2);
        }
    };

    let log = |msg: &str| {
        if !parsed.quiet {
            eprintln!("{}", msg);
        }
    };

    // 1. typecheck (always). A clean exit with no diagnostics is a valid
    //    "project compiles" outcome; no need to make this opt-in.
    log("[prism-audit] running typecheck...");
    let typecheck = match diagnostics::run_typecheck(
        &cwd,
        None,
        Some(Duration::from_secs(parsed.typecheck_timeout_secs)),
    ) {
        Ok(r) => Some(r),
        Err(e) => {
            log(&format!("[prism-audit] typecheck unavailable: {}", e));
            None
        }
    };

    // 2. run_tests (skipped by default in CI mode? no, included unless
    //    --skip-tests is set; CI users who don't want them flip the flag).
    let tests = if parsed.skip_tests {
        log("[prism-audit] skipping run_tests (--skip-tests)");
        None
    } else {
        log("[prism-audit] running tests...");
        match diagnostics::run_tests(
            &cwd,
            None,
            Some(Duration::from_secs(parsed.test_timeout_secs)),
        ) {
            Ok(r) => Some(r),
            Err(e) => {
                log(&format!("[prism-audit] run_tests unavailable: {}", e));
                None
            }
        }
    };

    // 3. lsp_diagnostics (best-effort; gated on detection so CI without
    //    rust-analyzer/pyright/gopls/typescript-language-server simply
    //    skips this cell instead of erroring).
    let lsp_run = if parsed.skip_lsp {
        log("[prism-audit] skipping lsp_diagnostics (--skip-lsp)");
        None
    } else {
        log("[prism-audit] running lsp_diagnostics...");
        match lsp::run_lsp_diagnostics(
            &cwd,
            &[],
            None,
            None,
            Some(Duration::from_secs(parsed.lsp_timeout_secs)),
        ) {
            Ok(r) => Some(r),
            Err(e) => {
                log(&format!("[prism-audit] lsp_diagnostics unavailable: {}", e));
                None
            }
        }
    };

    // 4. Aggregate.
    let generated_at = format_timestamp(std::time::SystemTime::now());
    let report = diagnostics::aggregate_audit_report(
        typecheck.as_ref(),
        tests.as_ref(),
        lsp_run.as_ref(),
        parsed.scope.as_deref(),
        &generated_at,
        "prism-second-pass",
    );

    // 5. Optional sidecar.
    if let Some(path) = parsed.output_path.as_ref() {
        match serde_json::to_string_pretty(&report) {
            Ok(s) => match std::fs::write(path, s) {
                Ok(()) => log(&format!("[prism-audit] wrote sidecar: {}", path)),
                Err(e) => {
                    eprintln!("prism-audit: write {} failed: {}", path, e);
                    return ExitCode::from(2);
                }
            },
            Err(e) => {
                eprintln!("prism-audit: serialize report: {}", e);
                return ExitCode::from(2);
            }
        }
    }

    // 6. Stdout per format.
    match parsed.format {
        Format::Json => match serde_json::to_string_pretty(&report) {
            Ok(s) => println!("{}", s),
            Err(e) => {
                eprintln!("prism-audit: serialize report: {}", e);
                return ExitCode::from(2);
            }
        },
        Format::Text => print_text(&report),
        Format::Github => print_github_annotations(&report),
    }

    // 7. Exit code.
    let summary = report.get("summary").cloned().unwrap_or_default();
    let errors = summary.get("errors").and_then(|v| v.as_u64()).unwrap_or(0);
    let warnings = summary
        .get("warnings")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let exit = match parsed.fail_on {
        FailOn::Error if errors > 0 => 2,
        FailOn::Warning if errors > 0 || warnings > 0 => 2,
        FailOn::None => 0,
        _ => 0,
    };
    ExitCode::from(exit as u8)
}

// ---------------------------------------------------------------------------
// Argv parsing (hand-rolled to avoid pulling clap into the dep tree)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Text,
    Json,
    Github,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailOn {
    None,
    Warning,
    Error,
}

#[derive(Debug, Clone)]
struct ParsedArgs {
    format: Format,
    fail_on: FailOn,
    skip_tests: bool,
    skip_lsp: bool,
    quiet: bool,
    scope: Option<String>,
    output_path: Option<String>,
    typecheck_timeout_secs: u64,
    test_timeout_secs: u64,
    lsp_timeout_secs: u64,
    show_help: bool,
    show_version: bool,
}

fn default_args() -> ParsedArgs {
    ParsedArgs {
        format: Format::Text,
        fail_on: FailOn::Error,
        skip_tests: false,
        skip_lsp: false,
        quiet: false,
        scope: None,
        output_path: None,
        typecheck_timeout_secs: 60,
        test_timeout_secs: 120,
        lsp_timeout_secs: 30,
        show_help: false,
        show_version: false,
    }
}

fn parse_args(argv: &[String]) -> Result<ParsedArgs, String> {
    let mut out = default_args();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "-h" | "--help" => out.show_help = true,
            "-V" | "--version" => out.show_version = true,
            "-q" | "--quiet" => out.quiet = true,
            "--skip-tests" => out.skip_tests = true,
            "--skip-lsp" => out.skip_lsp = true,
            _ if a.starts_with("--format=") => {
                out.format = parse_format(&a["--format=".len()..])?;
            }
            "--format" => {
                let v = take_value(argv, &mut i, "--format")?;
                out.format = parse_format(&v)?;
            }
            _ if a.starts_with("--fail-on=") => {
                out.fail_on = parse_fail_on(&a["--fail-on=".len()..])?;
            }
            "--fail-on" => {
                let v = take_value(argv, &mut i, "--fail-on")?;
                out.fail_on = parse_fail_on(&v)?;
            }
            _ if a.starts_with("--scope=") => {
                out.scope = Some(a["--scope=".len()..].to_string());
            }
            "--scope" => {
                out.scope = Some(take_value(argv, &mut i, "--scope")?);
            }
            _ if a.starts_with("--output=") => {
                out.output_path = Some(a["--output=".len()..].to_string());
            }
            "--output" | "-o" => {
                out.output_path = Some(take_value(argv, &mut i, "--output")?);
            }
            _ if a.starts_with("--typecheck-timeout=") => {
                out.typecheck_timeout_secs =
                    parse_secs(&a["--typecheck-timeout=".len()..], "--typecheck-timeout")?;
            }
            _ if a.starts_with("--test-timeout=") => {
                out.test_timeout_secs =
                    parse_secs(&a["--test-timeout=".len()..], "--test-timeout")?;
            }
            _ if a.starts_with("--lsp-timeout=") => {
                out.lsp_timeout_secs =
                    parse_secs(&a["--lsp-timeout=".len()..], "--lsp-timeout")?;
            }
            _ => return Err(format!("unknown argument '{}'", a)),
        }
        i += 1;
    }
    Ok(out)
}

fn take_value(argv: &[String], i: &mut usize, flag: &str) -> Result<String, String> {
    let next = argv
        .get(*i + 1)
        .ok_or_else(|| format!("{} expects a value", flag))?;
    *i += 1;
    Ok(next.to_string())
}

fn parse_format(s: &str) -> Result<Format, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "text" | "human" => Ok(Format::Text),
        "json" => Ok(Format::Json),
        "github" | "actions" => Ok(Format::Github),
        other => Err(format!(
            "--format expects one of: text, json, github (got '{}')",
            other
        )),
    }
}

fn parse_fail_on(s: &str) -> Result<FailOn, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "none" | "never" | "off" => Ok(FailOn::None),
        "warning" | "warn" => Ok(FailOn::Warning),
        "error" => Ok(FailOn::Error),
        other => Err(format!(
            "--fail-on expects one of: none, warning, error (got '{}')",
            other
        )),
    }
}

fn parse_secs(s: &str, flag: &str) -> Result<u64, String> {
    s.trim()
        .parse::<u64>()
        .map_err(|_| format!("{} expects a positive integer (got '{}')", flag, s))
        .and_then(|n| {
            if n == 0 {
                Err(format!("{} must be > 0", flag))
            } else {
                Ok(n)
            }
        })
}

fn print_help() {
    let bin = env!("CARGO_PKG_NAME");
    println!(
        "{} {} — substrate audit CLI\n\
         \n\
         USAGE: prism-audit [FLAGS]\n\
         \n\
         FLAGS:\n  \
           --format=<text|json|github>   stdout format (default: text)\n  \
           --fail-on=<none|warning|error> exit code policy (default: error)\n  \
           --scope=<path>                opaque label retained in the report\n  \
           --output=<path>               write the JSON sidecar to <path>\n  \
           --skip-tests                  do not run the project test suite\n  \
           --skip-lsp                    do not run lsp_diagnostics\n  \
           --typecheck-timeout=<secs>    per-call timeout (default: 60)\n  \
           --test-timeout=<secs>         per-call timeout (default: 120)\n  \
           --lsp-timeout=<secs>          per-call timeout (default: 30)\n  \
           --quiet, -q                   suppress non-finding chatter\n  \
           --help, -h                    print this message\n  \
           --version, -V                 print version\n\
         \n\
         EXIT CODES:\n  \
           0  no findings worth failing on under the policy\n  \
           2  findings exceeded the --fail-on threshold, OR a usage error\n",
        bin,
        env!("CARGO_PKG_VERSION"),
    );
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

fn print_text(report: &serde_json::Value) {
    let total = report
        .pointer("/summary/total")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let errors = report
        .pointer("/summary/errors")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let warnings = report
        .pointer("/summary/warnings")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let info = report
        .pointer("/summary/info")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    println!(
        "FINDINGS ({}) — {} error, {} warning, {} info",
        total, errors, warnings, info,
    );
    if total == 0 {
        println!("No substrate-confirmed findings. Project is clean.");
        return;
    }
    let empty = Vec::new();
    let findings = report
        .get("findings")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    for f in findings {
        let severity = f
            .get("severity")
            .and_then(|v| v.as_str())
            .unwrap_or("info");
        let source = f.get("source").and_then(|v| v.as_str()).unwrap_or("?");
        let file = f.get("file").and_then(|v| v.as_str()).unwrap_or("?");
        let line = f.get("line").and_then(|v| v.as_u64()).unwrap_or(0);
        let desc = f
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let loc = if line > 0 {
            format!("{}:{}", file, line)
        } else {
            file.to_string()
        };
        println!("[{} {}] {} — {}", severity, source, loc, desc);
    }
}

fn print_github_annotations(report: &serde_json::Value) {
    // GitHub Actions workflow command format:
    //   ::<level> file=<path>,line=<n>::<message>
    // Where <level> is one of error|warning|notice. Info → notice.
    let empty = Vec::new();
    let findings = report
        .get("findings")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    for f in findings {
        let severity = f
            .get("severity")
            .and_then(|v| v.as_str())
            .unwrap_or("info");
        let level = match severity {
            "error" => "error",
            "warning" => "warning",
            _ => "notice",
        };
        let file = f.get("file").and_then(|v| v.as_str()).unwrap_or("");
        let line = f.get("line").and_then(|v| v.as_u64()).unwrap_or(0);
        let desc = f
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut params = format!("file={}", file);
        if line > 0 {
            params.push_str(&format!(",line={}", line));
        }
        println!("::{} {}::{}", level, params, desc);
    }
}

// ---------------------------------------------------------------------------
// Tiny ISO-8601 timestamp formatter (avoids pulling in chrono just for this)
// ---------------------------------------------------------------------------

fn format_timestamp(now: std::time::SystemTime) -> String {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil-from-days, Howard Hinnant's algorithm.
    let z = (secs / 86400) as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = y + if m <= 2 { 1 } else { 0 };
    let sod = secs % 86400;
    let h = (sod / 3600) as u32;
    let mi = ((sod % 3600) / 60) as u32;
    let s = (sod % 60) as u32;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, h, mi, s
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_format_aliases() {
        assert_eq!(parse_format("text").unwrap(), Format::Text);
        assert_eq!(parse_format("HUMAN").unwrap(), Format::Text);
        assert_eq!(parse_format("json").unwrap(), Format::Json);
        assert_eq!(parse_format("Github").unwrap(), Format::Github);
        assert_eq!(parse_format("actions").unwrap(), Format::Github);
        assert!(parse_format("yaml").is_err());
    }

    #[test]
    fn parses_fail_on_aliases() {
        assert_eq!(parse_fail_on("error").unwrap(), FailOn::Error);
        assert_eq!(parse_fail_on("warning").unwrap(), FailOn::Warning);
        assert_eq!(parse_fail_on("none").unwrap(), FailOn::None);
        assert_eq!(parse_fail_on("Never").unwrap(), FailOn::None);
        assert!(parse_fail_on("yes").is_err());
    }

    #[test]
    fn parse_args_default_is_text_error() {
        let p = parse_args(&[]).unwrap();
        assert_eq!(p.format, Format::Text);
        assert_eq!(p.fail_on, FailOn::Error);
        assert!(!p.skip_tests);
        assert!(!p.skip_lsp);
        assert!(!p.quiet);
        assert!(p.scope.is_none());
        assert!(p.output_path.is_none());
    }

    #[test]
    fn parse_args_handles_eq_form_flags() {
        let p = parse_args(&[
            "--format=json".into(),
            "--fail-on=warning".into(),
            "--scope=src/auth".into(),
            "--output=/tmp/out.json".into(),
            "--skip-tests".into(),
            "--quiet".into(),
        ])
        .unwrap();
        assert_eq!(p.format, Format::Json);
        assert_eq!(p.fail_on, FailOn::Warning);
        assert_eq!(p.scope.as_deref(), Some("src/auth"));
        assert_eq!(p.output_path.as_deref(), Some("/tmp/out.json"));
        assert!(p.skip_tests);
        assert!(p.quiet);
    }

    #[test]
    fn parse_args_handles_space_form_flags() {
        let p = parse_args(&[
            "--format".into(),
            "github".into(),
            "--fail-on".into(),
            "none".into(),
            "--output".into(),
            "report.json".into(),
            "--skip-lsp".into(),
        ])
        .unwrap();
        assert_eq!(p.format, Format::Github);
        assert_eq!(p.fail_on, FailOn::None);
        assert_eq!(p.output_path.as_deref(), Some("report.json"));
        assert!(p.skip_lsp);
    }

    #[test]
    fn parse_args_rejects_unknown_flag() {
        let r = parse_args(&["--zoom".into()]);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("--zoom"));
    }

    #[test]
    fn parse_args_rejects_missing_value() {
        let r = parse_args(&["--format".into()]);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("expects a value"));
    }

    #[test]
    fn parse_secs_requires_positive_integer() {
        assert_eq!(parse_secs("60", "--x").unwrap(), 60);
        assert!(parse_secs("0", "--x").is_err());
        assert!(parse_secs("abc", "--x").is_err());
    }

    #[test]
    fn format_timestamp_is_iso8601_z() {
        let stamp =
            format_timestamp(std::time::UNIX_EPOCH + Duration::from_secs(0));
        assert_eq!(stamp, "1970-01-01T00:00:00Z");
        let stamp = format_timestamp(
            std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000),
        );
        // Sanity: must be RFC3339-shaped ending in Z.
        assert!(stamp.ends_with('Z'));
        assert_eq!(stamp.len(), 20);
    }
}
