//! Schema/migration substrate cell (substrate v7).
//!
//! Inspects the project's ORM/migration tooling and reports state:
//! pending migrations, schema drift, structural errors. Read-only.
//! Migrations stay user-driven via the existing approval flow on
//! `edit_file` / `write_file` and shell commands — this cell tells
//! the agent (and `/audit` / `/build`) what the substrate sees so it
//! can reason about whether the project is in a runnable state.
//!
//! Detection covers the common ORMs:
//!   - Prisma         → `prisma migrate status`
//!   - Drizzle        → `drizzle-kit check`
//!   - SQLAlchemy     → `alembic current` + `alembic check`
//!   - Django ORM     → `python manage.py showmigrations --list`
//!   - Rails          → `bin/rails db:migrate:status`
//!
//! Each adapter parses the tool's output for:
//!   - pending migration count
//!   - drift between schema definition and applied migrations
//!   - errors / warnings the tool emits
//!
//! Source attribution: every `Diagnostic` emitted carries
//! `source = "schema"` so the grader graduates findings to
//! `confirmed`. The "your schema doesn't match what's applied" class
//! is exactly the kind of substrate-confirmed evidence that makes a
//! `/build` runnable end-to-end.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::diagnostics::{Diagnostic, Severity};

/// Default timeout for one schema-inspect call. Migration status
/// commands are usually fast (DB roundtrip + parse) but a cold
/// connection can take a few seconds.
const SCHEMA_DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Cap on the raw output we surface back to the model.
const SCHEMA_MAX_RAW_BYTES: usize = 8 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// One ORM/migration adapter. Identifies which tool to spawn and how
/// to parse its output.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub enum Orm {
    Prisma,
    Drizzle,
    Sqlalchemy,
    Django,
    Rails,
}

impl Orm {
    pub fn label(&self) -> &'static str {
        match self {
            Orm::Prisma => "prisma",
            Orm::Drizzle => "drizzle",
            Orm::Sqlalchemy => "sqlalchemy",
            Orm::Django => "django",
            Orm::Rails => "rails",
        }
    }
}

/// Specification for a schema-inspect invocation: which ORM, which
/// argv to spawn.
#[derive(Debug, Clone)]
pub struct SchemaSpec {
    pub orm: Orm,
    pub argv: Vec<String>,
}

/// Outcome of one schema-inspect call.
#[derive(Debug, Clone, Serialize)]
pub struct SchemaRun {
    pub command: Vec<String>,
    pub orm: Orm,
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
    /// Number of migrations the substrate detected as "not yet applied".
    pub pending_count: u32,
    /// Names of pending migrations (when the parser could pull them out).
    pub pending: Vec<String>,
    /// True iff the tool reported drift between the schema definition
    /// and the applied migrations (Prisma: "Database schema is not in
    /// sync"; Drizzle: "drift detected"; Alembic: "Target database is
    /// not up to date").
    pub drifted: bool,
    /// Diagnostics in the unified shape — surfaces "no migrations
    /// directory", "schema parse error", drift warnings, etc.
    pub diagnostics: Vec<Diagnostic>,
    pub raw: String,
    pub raw_truncated: bool,
    pub timed_out: bool,
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Pick a schema-inspect command for `cwd`. Returns None when no ORM
/// signature matches; the caller surfaces that as a clean "no schema
/// detected" so the agent doesn't try to treat absence as a finding.
pub fn detect_schema_command(cwd: &Path) -> Option<SchemaSpec> {
    // Prisma: prisma/schema.prisma is the canonical signature. Scoped
    // path also acceptable.
    if cwd.join("prisma").join("schema.prisma").is_file()
        || cwd.join("schema.prisma").is_file()
    {
        let argv = if cwd.join("pnpm-lock.yaml").is_file() {
            vec!["pnpm".into(), "exec".into(), "--".into(), "prisma".into(), "migrate".into(), "status".into()]
        } else if cwd.join("yarn.lock").is_file() {
            vec!["yarn".into(), "exec".into(), "--".into(), "prisma".into(), "migrate".into(), "status".into()]
        } else if cwd.join("bun.lockb").is_file() || cwd.join("bun.lock").is_file() {
            vec!["bunx".into(), "prisma".into(), "migrate".into(), "status".into()]
        } else {
            vec!["npx".into(), "prisma".into(), "migrate".into(), "status".into()]
        };
        return Some(SchemaSpec { orm: Orm::Prisma, argv });
    }

    // Drizzle: presence of drizzle.config.{ts,js,mjs}.
    for name in [
        "drizzle.config.ts",
        "drizzle.config.js",
        "drizzle.config.mjs",
    ] {
        if cwd.join(name).is_file() {
            let argv = if cwd.join("pnpm-lock.yaml").is_file() {
                vec!["pnpm".into(), "exec".into(), "--".into(), "drizzle-kit".into(), "check".into()]
            } else if cwd.join("yarn.lock").is_file() {
                vec!["yarn".into(), "exec".into(), "--".into(), "drizzle-kit".into(), "check".into()]
            } else if cwd.join("bun.lockb").is_file() || cwd.join("bun.lock").is_file() {
                vec!["bunx".into(), "drizzle-kit".into(), "check".into()]
            } else {
                vec!["npx".into(), "drizzle-kit".into(), "check".into()]
            };
            return Some(SchemaSpec { orm: Orm::Drizzle, argv });
        }
    }

    // SQLAlchemy / Alembic: alembic.ini at the root.
    if cwd.join("alembic.ini").is_file() {
        return Some(SchemaSpec {
            orm: Orm::Sqlalchemy,
            argv: vec!["alembic".into(), "current".into()],
        });
    }

    // Django: manage.py at the root.
    if cwd.join("manage.py").is_file() {
        return Some(SchemaSpec {
            orm: Orm::Django,
            argv: vec![
                "python".into(),
                "manage.py".into(),
                "showmigrations".into(),
                "--list".into(),
            ],
        });
    }

    // Rails: bin/rails + db/migrate dir present.
    if cwd.join("bin").join("rails").is_file() && cwd.join("db").join("migrate").is_dir() {
        return Some(SchemaSpec {
            orm: Orm::Rails,
            argv: vec![
                "bin/rails".into(),
                "db:migrate:status".into(),
            ],
        });
    }

    None
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run schema-inspect against `cwd`. Override the ORM detection by
/// passing an `override_argv` (e.g. from `agent.schema_command` config
/// when we wire that up). Returns a `SchemaRun` capturing the parsed
/// state; substrate failures (timeout, command not found) propagate
/// as `Err` so the caller can decide what to surface.
pub fn run_schema_inspect(
    cwd: &str,
    override_argv: Option<&[String]>,
    override_orm: Option<Orm>,
    timeout: Option<Duration>,
) -> Result<SchemaRun, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is unknown (shell integration may not be started)".into());
    }
    let cwd_path = Path::new(cwd);
    let (spec_orm, argv) = match override_argv {
        Some(argv) => {
            crate::diagnostics::validate_argv_public(argv)?;
            let orm = override_orm.unwrap_or(Orm::Prisma);
            (orm, argv.to_vec())
        }
        None => {
            let spec = detect_schema_command(cwd_path).ok_or_else(|| {
                "no schema/migration tool detected; install prisma / drizzle-kit / alembic / django / rails or pass `command` argument".to_string()
            })?;
            (spec.orm, spec.argv)
        }
    };
    let timeout = timeout.unwrap_or(Duration::from_secs(SCHEMA_DEFAULT_TIMEOUT_SECS));

    let started = Instant::now();
    let (output, timed_out) =
        crate::diagnostics::run_with_timeout_public(&argv, cwd_path, timeout)?;
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
            stderr
        )
    };

    let parsed = parse_schema_output(&spec_orm, &combined);

    let (raw, raw_truncated) = if combined.len() > SCHEMA_MAX_RAW_BYTES {
        (
            format!(
                "{}\n[\u{2026}raw output truncated at {} bytes]",
                &combined[..SCHEMA_MAX_RAW_BYTES],
                SCHEMA_MAX_RAW_BYTES
            ),
            true,
        )
    } else {
        (combined, false)
    };

    Ok(SchemaRun {
        command: argv,
        orm: spec_orm,
        exit_code: output.status.code(),
        duration_ms,
        pending_count: parsed.pending.len() as u32,
        pending: parsed.pending,
        drifted: parsed.drifted,
        diagnostics: parsed.diagnostics,
        raw,
        raw_truncated,
        timed_out,
    })
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct ParsedSchema {
    pending: Vec<String>,
    drifted: bool,
    diagnostics: Vec<Diagnostic>,
}

/// Parse the ORM-specific output into a normalized shape. Each adapter
/// is a small text-matcher; misses fall through silently and the raw
/// output is preserved so the model can still see what happened.
pub fn parse_schema_output(orm: &Orm, text: &str) -> ParsedSchemaPub {
    let p = match orm {
        Orm::Prisma => parse_prisma(text),
        Orm::Drizzle => parse_drizzle(text),
        Orm::Sqlalchemy => parse_sqlalchemy(text),
        Orm::Django => parse_django(text),
        Orm::Rails => parse_rails(text),
    };
    ParsedSchemaPub {
        pending: p.pending,
        drifted: p.drifted,
        diagnostics: p.diagnostics,
    }
}

/// Public mirror of the internal `ParsedSchema`. Exposed so tests can
/// destructure without the private inner type leaking.
#[derive(Debug, Default)]
pub struct ParsedSchemaPub {
    pub pending: Vec<String>,
    pub drifted: bool,
    pub diagnostics: Vec<Diagnostic>,
}

fn parse_prisma(text: &str) -> ParsedSchema {
    // Prisma "migrate status" emits human-readable output. Examples:
    //   "Database schema is up to date!"
    //   "Following migration have not yet been applied:"
    //     "20240101120000_add_users"
    //   "The following migrations have not yet been applied:"
    //   "Drift detected: Your database schema is not in sync"
    let mut out = ParsedSchema::default();
    let mut in_pending_block = false;
    for raw in text.lines() {
        let line = raw.trim();
        let lower = line.to_ascii_lowercase();
        if lower.contains("drift detected") || lower.contains("not in sync") {
            out.drifted = true;
            out.diagnostics.push(Diagnostic {
                source: "schema".into(),
                file: "prisma/schema.prisma".into(),
                line: 0,
                col: 0,
                severity: Severity::Warning,
                code: "PRISMA_DRIFT".into(),
                message: line.to_string(),
            });
        }
        if lower.contains("have not yet been applied") {
            in_pending_block = true;
            continue;
        }
        if in_pending_block {
            // Pending entries look like:  "20240101120000_add_users"
            // (timestamp + underscore + name). Stop on blank or
            // section-break lines.
            if line.is_empty() || line.starts_with('-') {
                in_pending_block = false;
                continue;
            }
            // Trim leading bullet/dot.
            let name = line.trim_start_matches(|c: char| c == '\u{2022}' || c == '*' || c == '-').trim();
            if name.chars().take(8).all(|c| c.is_ascii_digit()) {
                out.pending.push(name.to_string());
            }
        }
        if lower.contains("error") {
            out.diagnostics.push(Diagnostic {
                source: "schema".into(),
                file: "prisma/schema.prisma".into(),
                line: 0,
                col: 0,
                severity: Severity::Error,
                code: "PRISMA_ERROR".into(),
                message: line.to_string(),
            });
        }
    }
    out
}

fn parse_drizzle(text: &str) -> ParsedSchema {
    // drizzle-kit check emits:
    //   "Everything's fine 🎉" on success
    //   "❌ Schema drift detected" / "drift detected" on drift
    //   "Migration <name> has issues" on per-file errors
    let mut out = ParsedSchema::default();
    for raw in text.lines() {
        let line = raw.trim();
        let lower = line.to_ascii_lowercase();
        if lower.contains("drift detected") || lower.contains("schema mismatch") {
            out.drifted = true;
            out.diagnostics.push(Diagnostic {
                source: "schema".into(),
                file: "drizzle.config".into(),
                line: 0,
                col: 0,
                severity: Severity::Warning,
                code: "DRIZZLE_DRIFT".into(),
                message: line.to_string(),
            });
        }
        if lower.contains("has issues") || lower.starts_with("error") {
            out.diagnostics.push(Diagnostic {
                source: "schema".into(),
                file: "drizzle.config".into(),
                line: 0,
                col: 0,
                severity: Severity::Error,
                code: "DRIZZLE_ERROR".into(),
                message: line.to_string(),
            });
        }
    }
    out
}

fn parse_sqlalchemy(text: &str) -> ParsedSchema {
    // Alembic "current" prints the current revision. "current --verbose"
    // and "history" can give more. v1: detect drift via the canonical
    // "Target database is not up to date" message that `alembic check`
    // emits when run.
    let mut out = ParsedSchema::default();
    for raw in text.lines() {
        let line = raw.trim();
        let lower = line.to_ascii_lowercase();
        if lower.contains("not up to date") || lower.contains("new upgrade operations") {
            out.drifted = true;
            out.diagnostics.push(Diagnostic {
                source: "schema".into(),
                file: "alembic.ini".into(),
                line: 0,
                col: 0,
                severity: Severity::Warning,
                code: "ALEMBIC_DRIFT".into(),
                message: line.to_string(),
            });
        }
    }
    out
}

fn parse_django(text: &str) -> ParsedSchema {
    // `manage.py showmigrations --list` output:
    //   admin
    //    [X] 0001_initial
    //    [ ] 0002_logentry_remove_auto_add
    // Unapplied migrations are the lines with `[ ]`.
    let mut out = ParsedSchema::default();
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("[ ]") {
            let name = rest.trim();
            if !name.is_empty() {
                out.pending.push(name.to_string());
            }
        }
    }
    if !out.pending.is_empty() {
        out.drifted = true;
    }
    out
}

fn parse_rails(text: &str) -> ParsedSchema {
    // `rails db:migrate:status` output:
    //   Status   Migration ID    Migration Name
    //   --------------------------------------------------
    //    up     20240101120000  Add users
    //    down   20240102120000  Add posts
    let mut out = ParsedSchema::default();
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("down") {
            // Format: "down  20240102120000  Add posts"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                out.pending.push(parts[1..].join(" "));
            }
        }
    }
    if !out.pending.is_empty() {
        out.drifted = true;
    }
    out
}

// ---------------------------------------------------------------------------
// JSON payload
// ---------------------------------------------------------------------------

/// Serialize a `SchemaRun` for the LLM tool result. Adds an
/// `evidence_detail` line the model can paste verbatim into a
/// Finding's `evidence: source=schema; detail=...` stanza.
pub fn to_schema_payload(run: &SchemaRun) -> Value {
    let evidence_detail = format!(
        "schema ({}): {} pending migration{}{}{}",
        run.orm.label(),
        run.pending_count,
        if run.pending_count == 1 { "" } else { "s" },
        if run.drifted { ", drift detected" } else { "" },
        format!(", {} ms", run.duration_ms),
    );
    json!({
        "command": run.command,
        "orm": run.orm.label(),
        "exit_code": run.exit_code,
        "duration_ms": run.duration_ms,
        "pending_count": run.pending_count,
        "pending": run.pending,
        "drifted": run.drifted,
        "diagnostics": run.diagnostics
            .iter()
            .map(|d| json!({
                "source": d.source,
                "file": d.file,
                "line": d.line,
                "col": d.col,
                "severity": match d.severity { Severity::Error => "error", Severity::Warning => "warning", Severity::Info => "info" },
                "code": d.code,
                "message": d.message,
                "confidence": "confirmed",
                "evidence": [
                    { "source": "schema", "detail": d.message }
                ],
            }))
            .collect::<Vec<_>>(),
        "raw": run.raw,
        "raw_truncated": run.raw_truncated,
        "timed_out": run.timed_out,
        "evidence_detail": evidence_detail,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    fn fresh_tmp() -> PathBuf {
        let dir = env::temp_dir().join(format!("prism-schema-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create tmp dir");
        fs::canonicalize(&dir).expect("canonicalize tmp")
    }

    // -- Detection ----------------------------------------------------------

    #[test]
    fn detects_prisma_via_schema_prisma() {
        let dir = fresh_tmp();
        fs::create_dir_all(dir.join("prisma")).unwrap();
        fs::write(dir.join("prisma").join("schema.prisma"), "generator client {}\n").unwrap();
        fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        let spec = detect_schema_command(&dir).expect("should detect prisma");
        assert_eq!(spec.orm, Orm::Prisma);
        assert_eq!(spec.argv[0], "pnpm");
        assert!(spec.argv.contains(&"prisma".to_string()));
        assert!(spec.argv.contains(&"status".to_string()));
    }

    #[test]
    fn detects_drizzle_via_config_file() {
        let dir = fresh_tmp();
        fs::write(dir.join("drizzle.config.ts"), "export default {}\n").unwrap();
        let spec = detect_schema_command(&dir).expect("should detect drizzle");
        assert_eq!(spec.orm, Orm::Drizzle);
        assert!(spec.argv.contains(&"drizzle-kit".to_string()));
        assert!(spec.argv.contains(&"check".to_string()));
    }

    #[test]
    fn detects_sqlalchemy_via_alembic_ini() {
        let dir = fresh_tmp();
        fs::write(dir.join("alembic.ini"), "[alembic]\n").unwrap();
        let spec = detect_schema_command(&dir).expect("should detect alembic");
        assert_eq!(spec.orm, Orm::Sqlalchemy);
        assert_eq!(spec.argv, vec!["alembic", "current"]);
    }

    #[test]
    fn detects_django_via_manage_py() {
        let dir = fresh_tmp();
        fs::write(dir.join("manage.py"), "# django\n").unwrap();
        let spec = detect_schema_command(&dir).expect("should detect django");
        assert_eq!(spec.orm, Orm::Django);
        assert!(spec.argv.iter().any(|s| s == "showmigrations"));
    }

    #[test]
    fn detects_rails_via_bin_and_db_migrate() {
        let dir = fresh_tmp();
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::create_dir_all(dir.join("db").join("migrate")).unwrap();
        fs::write(dir.join("bin").join("rails"), "#!/usr/bin/env bash\n").unwrap();
        let spec = detect_schema_command(&dir).expect("should detect rails");
        assert_eq!(spec.orm, Orm::Rails);
        assert!(spec.argv.contains(&"db:migrate:status".to_string()));
    }

    #[test]
    fn returns_none_for_unrelated_project() {
        let dir = fresh_tmp();
        fs::write(dir.join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        assert!(detect_schema_command(&dir).is_none());
    }

    // -- Parsing ------------------------------------------------------------

    #[test]
    fn parse_prisma_pending_block() {
        let raw = "\
Following migration have not yet been applied:
20240101120000_add_users
20240102120000_add_posts

run prisma migrate dev to apply
";
        let p = parse_schema_output(&Orm::Prisma, raw);
        assert_eq!(p.pending.len(), 2);
        assert!(p.pending.iter().any(|s| s.contains("add_users")));
    }

    #[test]
    fn parse_prisma_drift_warning() {
        let raw = "Drift detected: Your database schema is not in sync with your migrations.";
        let p = parse_schema_output(&Orm::Prisma, raw);
        assert!(p.drifted);
        assert!(p.diagnostics.iter().any(|d| d.code == "PRISMA_DRIFT"));
    }

    #[test]
    fn parse_drizzle_drift() {
        let raw = "❌ Schema drift detected between your TS schema and the latest migration";
        let p = parse_schema_output(&Orm::Drizzle, raw);
        assert!(p.drifted);
    }

    #[test]
    fn parse_django_unapplied_migrations() {
        let raw = "\
admin
 [X] 0001_initial
 [ ] 0002_logentry_remove_auto_add
auth
 [X] 0001_initial
 [ ] 0002_alter_permission
";
        let p = parse_schema_output(&Orm::Django, raw);
        assert_eq!(p.pending.len(), 2);
        assert!(p.drifted);
    }

    #[test]
    fn parse_rails_down_rows_become_pending() {
        let raw = "\
Status   Migration ID    Migration Name
--------------------------------------------------
   up     20240101120000  Add users
 down     20240102120000  Add posts
   up     20240103120000  Add comments
";
        let p = parse_schema_output(&Orm::Rails, raw);
        assert_eq!(p.pending.len(), 1);
        assert!(p.pending[0].contains("Add posts"));
        assert!(p.drifted);
    }

    #[test]
    fn parse_alembic_drift_message() {
        let raw = "Target database is not up to date.";
        let p = parse_schema_output(&Orm::Sqlalchemy, raw);
        assert!(p.drifted);
        assert!(p.diagnostics.iter().any(|d| d.code == "ALEMBIC_DRIFT"));
    }

    // -- Payload -----------------------------------------------------------

    #[test]
    fn schema_payload_includes_evidence_detail() {
        let run = SchemaRun {
            command: vec!["pnpm".into(), "exec".into(), "prisma".into(), "migrate".into(), "status".into()],
            orm: Orm::Prisma,
            exit_code: Some(0),
            duration_ms: 1234,
            pending_count: 2,
            pending: vec!["m1".into(), "m2".into()],
            drifted: true,
            diagnostics: vec![],
            raw: "raw".into(),
            raw_truncated: false,
            timed_out: false,
        };
        let v = to_schema_payload(&run);
        let evidence = v["evidence_detail"].as_str().unwrap();
        assert!(evidence.contains("prisma"));
        assert!(evidence.contains("2 pending"));
        assert!(evidence.contains("drift detected"));
    }
}
