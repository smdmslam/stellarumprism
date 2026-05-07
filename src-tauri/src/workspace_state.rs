//! Persisted per-workspace spine.
//!
//! The frontend keeps a lot of "what's the state of this project?" data
//! (last audit, last build, recently opened files) in memory on the
//! active `Workspace`. That data dies on tab close. This module gives
//! every workspace a tiny on-disk index at `<cwd>/prism/state.json`
//! plus a sibling persistence directory for build reports
//! (`<cwd>/prism/builds/`) that mirrors what `second_pass` already does
//! for audits.
//!
//! The `state.json` file is intentionally a small INDEX, not a copy of
//! the underlying reports. It stores pointers (relative paths under
//! `prism/`) to the latest audit and build artifacts, plus the most
//! salient summary fields so the Problems panel and `/last` command can
//! render without a second disk read. Consumers that need the full
//! report follow `path` and load the full markdown / JSON.
//!
//! Why a separate module from `second_pass`? Audit reports already had
//! their own home and a working `/fix` consumer; bolting build-report
//! storage and a shared state index onto that file would have made it
//! ambiguous which functions are "audit-only" vs "shared workspace".
//! Keeping them separate makes the audit module's invariants stay
//! audit-shaped, and lets this module own the cross-cutting state
//! pointer + build-report parity work.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Subdirectory under cwd where every per-project artifact Prism manages
/// lives. The audit module writes to `<cwd>/prism/second-pass/`; this
/// module writes to `<cwd>/prism/state.json` and `<cwd>/prism/builds/`.
const PRISM_DIR: &str = "prism";
const LEGACY_PRISM_DIR: &str = ".prism";
const STATE_FILENAME: &str = "state.json";
const BUILDS_SUBDIR: &str = "prism/builds";

// ---------------------------------------------------------------------------
// state.json schema
// ---------------------------------------------------------------------------

/// Top-level workspace state document. Every field is optional so the
/// file can be created incrementally as the user runs different
/// commands. `version` lets us migrate the schema later without
/// poisoning older readers.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspaceState {
    /// Schema version. Always 1 today; bumped only when fields are
    /// renamed or removed (additive changes don't require a bump).
    pub version: u32,
    /// Pointer + summary for the most recent successful `/audit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_audit: Option<LastAudit>,
    /// Pointer + summary for the most recent build/new/refactor/fix/
    /// test-gen completion (whatever last produced a BUILD REPORT).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_build: Option<LastBuild>,
    /// Recently opened files in this workspace. Capped on write; the
    /// reader returns whatever's on disk verbatim.
    #[serde(default)]
    pub recent_files: Vec<RecentFile>,
    /// Persisted layout for the workspace's resizable panes
    /// (sidebar/content/problems-panel widths and file-preview
    /// height). Optional so a workspace that has never been resized
    /// stays clean in `state.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<Layout>,
}

/// Per-workspace layout preferences. Every field is optional and
/// expressed in CSS pixels. Out-of-band values (NaN, negatives, > the
/// viewport) are not validated server-side; the frontend clamps on
/// apply so a bogus state file can't make panes unreachable.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Layout {
    /// Width of `.blocks-sidebar` in CSS pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<u32>,
    /// Width of `.problems-panel` in CSS pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problems_width: Option<u32>,
    /// Height of `.file-preview` overlay in CSS pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_height: Option<u32>,
    /// Width of the right-hand agent pane in CSS pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_pane_width: Option<u32>,
    /// Whether the file-preview area in the center pane is shown.
    /// Toggled via the toolbar; defaults to true on a fresh workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_visible: Option<bool>,
    /// Whether the xterm strip in the center pane is shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_visible: Option<bool>,
    /// Whether the right-hand agent pane (HTML chat) is shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_visible: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastAudit {
    /// Relative path under cwd to the JSON sidecar
    /// (e.g. `.prism/second-pass/audit-2026-04-25T19-30-00.json`).
    pub path: String,
    /// ISO-8601 timestamp from the audit report itself.
    pub generated_at: String,
    /// User-supplied scope (git ref, `@path`, or null for working tree).
    #[serde(default)]
    pub scope: Option<String>,
    /// Pre-aggregated counts so consumers don't need to reload the full
    /// report for the common "last audit summary" surface.
    pub counts: AuditCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuditCounts {
    pub error: u32,
    pub warning: u32,
    pub info: u32,
    pub confirmed: u32,
    pub probable: u32,
    pub candidate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastBuild {
    /// Relative path under cwd to the JSON sidecar
    /// (e.g. `.prism/builds/build-2026-04-25T19-30-00.json`).
    pub path: String,
    /// ISO-8601 timestamp from the build report itself.
    pub generated_at: String,
    /// Free-form description of what was built. For `/build` this is the
    /// feature string; for `/refactor` it's the rename pair; etc.
    pub feature: String,
    /// "completed" | "incomplete" — whatever the model emitted.
    pub status: String,
    /// Pre-aggregated single-line summaries of the substrate
    /// verifications, mirroring the BUILD REPORT's "Final verification"
    /// block. Optional fields stay None when the corresponding tool was
    /// not run.
    #[serde(default)]
    pub verification: BuildVerification,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BuildVerification {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typecheck: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tests: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFile {
    /// Path relative to cwd.
    pub path: String,
    /// ISO-8601 timestamp.
    pub opened_at: String,
}

// ---------------------------------------------------------------------------
// Tauri commands: state.json
// ---------------------------------------------------------------------------

/// Read the workspace state file at `<cwd>/prism/state.json` (fallback:
/// `<cwd>/.prism/state.json`). Returns
/// `Ok(None)` when the file simply doesn't exist yet (the common case
/// for a brand-new project) so the frontend can hydrate cleanly without
/// distinguishing "no state" from a real read error.
#[tauri::command]
pub fn read_workspace_state(cwd: String) -> Result<Option<WorkspaceState>, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is empty; shell integration may not be started".into());
    }
    let primary = Path::new(&cwd).join(PRISM_DIR).join(STATE_FILENAME);
    let legacy = Path::new(&cwd).join(LEGACY_PRISM_DIR).join(STATE_FILENAME);
    let path = if primary.exists() { primary } else { legacy };
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    // A corrupt state file should NOT brick the frontend. Return None
    // and let the next successful audit/build rewrite it from scratch.
    // We surface the parse error in the tauri::command return so the UI
    // can log it, but treat it as "no usable state".
    match serde_json::from_str::<WorkspaceState>(&raw) {
        Ok(state) => Ok(Some(state)),
        Err(e) => Err(format!(
            "{} is corrupt: {} (will be overwritten on next audit/build)",
            path.display(),
            e
        )),
    }
}

/// Atomically write the workspace state file. Creates `.prism/` if
/// missing. Caps `recent_files` at 10 entries before writing so the
/// file can't grow unbounded over a long-running project.
#[tauri::command]
pub fn write_workspace_state(cwd: String, mut state: WorkspaceState) -> Result<(), String> {
    if cwd.trim().is_empty() {
        return Err("cwd is empty; shell integration may not be started".into());
    }
    if state.version == 0 {
        state.version = 1;
    }
    if state.recent_files.len() > 10 {
        state.recent_files.truncate(10);
    }
    let dir = Path::new(&cwd).join(PRISM_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
    let path = dir.join(STATE_FILENAME);
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize workspace state: {}", e))?;
    atomic_write(&path, json.as_bytes())
}

// ---------------------------------------------------------------------------
// Tauri commands: build report persistence
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct WriteBuildReportResult {
    /// Absolute path of the markdown report.
    pub path: String,
    /// Bytes written to the markdown file.
    pub bytes_written: u64,
    /// Absolute path of the JSON sidecar (when one was written).
    pub json_path: Option<String>,
    /// Bytes written to the JSON sidecar.
    pub json_bytes_written: Option<u64>,
}

/// Write a build/refactor/fix/test-gen completion report under
/// `<cwd>/.prism/builds/`. Mirrors `second_pass::write_audit_report`:
/// markdown is the human-readable artifact, JSON is the
/// machine-readable contract every future consumer reads.
#[tauri::command]
pub fn write_build_report(
    cwd: String,
    filename: String,
    content: String,
    json_content: Option<String>,
) -> Result<WriteBuildReportResult, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is empty; shell integration may not be started".into());
    }
    if filename.trim().is_empty() {
        return Err("filename is empty".into());
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(format!(
            "refusing to write report with suspicious filename: {}",
            filename
        ));
    }

    let dir = Path::new(&cwd).join(BUILDS_SUBDIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;

    let full_path = dir.join(&filename);
    atomic_write(&full_path, content.as_bytes())?;

    let (json_path, json_bytes_written) = match json_content {
        Some(json) => {
            let stem = filename
                .strip_suffix(".md")
                .unwrap_or(&filename)
                .to_string();
            let json_filename = format!("{}.json", stem);
            let json_full = dir.join(&json_filename);
            atomic_write(&json_full, json.as_bytes())?;
            (
                Some(json_full.to_string_lossy().into_owned()),
                Some(json.len() as u64),
            )
        }
        None => (None, None),
    };

    Ok(WriteBuildReportResult {
        path: full_path.to_string_lossy().into_owned(),
        bytes_written: content.len() as u64,
        json_path,
        json_bytes_written,
    })
}

#[derive(Debug, Serialize)]
pub struct BuildReportLookup {
    pub path: String,
    pub content: String,
    pub bytes: u64,
}

/// Discover the newest build JSON sidecar under `<cwd>/.prism/builds/`
/// or return the file at `path` if explicitly supplied. Same shape as
/// `read_latest_audit_report` so the frontend code looks symmetric.
#[tauri::command]
pub fn read_latest_build_report(
    cwd: String,
    path: Option<String>,
) -> Result<BuildReportLookup, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is empty; shell integration may not be started".into());
    }

    let target_path: PathBuf = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            if Path::new(p).is_absolute() {
                PathBuf::from(p)
            } else {
                Path::new(&cwd).join(p)
            }
        }
        _ => find_latest_build_sidecar(&cwd)?,
    };

    let bytes = fs::metadata(&target_path)
        .map_err(|e| format!("cannot stat {}: {}", target_path.display(), e))?
        .len();
    let content = fs::read_to_string(&target_path)
        .map_err(|e| format!("cannot read {}: {}", target_path.display(), e))?;
    Ok(BuildReportLookup {
        path: target_path.to_string_lossy().into_owned(),
        content,
        bytes,
    })
}

fn find_latest_build_sidecar(cwd: &str) -> Result<PathBuf, String> {
    let dir = Path::new(cwd).join(BUILDS_SUBDIR);
    if !dir.exists() {
        return Err(format!(
            "no build reports found at {} (run /build, /new, /refactor, /fix, or /test-gen first)",
            dir.display()
        ));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("cannot list {}: {}", dir.display(), e))? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let name_lossy = name.to_string_lossy();
        if name_lossy.starts_with("build-") && name_lossy.ends_with(".json") {
            candidates.push(entry.path());
        }
    }
    if candidates.is_empty() {
        return Err(format!(
            "no build JSON sidecars under {}",
            dir.display()
        ));
    }
    candidates.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    Ok(candidates.into_iter().next().expect("non-empty"))
}

// ---------------------------------------------------------------------------
// shared atomic write (duplicated across modules to keep them isolated)
// ---------------------------------------------------------------------------

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
    let tmp: PathBuf = parent.join(format!(".{}.prism-tmp", file_name));
    fs::write(&tmp, bytes)
        .map_err(|e| format!("cannot write {}: {}", tmp.display(), e))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot rename into {}: {}", path.display(), e));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_tmp() -> PathBuf {
        let dir = env::temp_dir().join(format!("prism-wsstate-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create tmp dir");
        fs::canonicalize(&dir).expect("canonicalize tmp")
    }

    #[test]
    fn read_returns_none_when_state_file_missing() {
        let cwd = fresh_tmp();
        let res = read_workspace_state(cwd.to_string_lossy().into_owned()).expect("ok");
        assert!(res.is_none());
    }

    #[test]
    fn write_then_read_roundtrip_preserves_pointers() {
        let cwd = fresh_tmp();
        let mut state = WorkspaceState::default();
        state.last_audit = Some(LastAudit {
            path: ".prism/second-pass/audit-2026-04-25T19-30-00.json".into(),
            generated_at: "2026-04-25T19:30:00Z".into(),
            scope: Some("HEAD~3".into()),
            counts: AuditCounts {
                error: 2,
                warning: 5,
                info: 1,
                confirmed: 3,
                probable: 2,
                candidate: 3,
            },
        });
        state.last_build = Some(LastBuild {
            path: ".prism/builds/build-2026-04-25T19-32-00.json".into(),
            generated_at: "2026-04-25T19:32:00Z".into(),
            feature: "add Stripe checkout".into(),
            status: "completed".into(),
            verification: BuildVerification {
                typecheck: Some("pass".into()),
                tests: Some("pass".into()),
                http: None,
            },
        });
        write_workspace_state(cwd.to_string_lossy().into_owned(), state.clone()).expect("write ok");

        let read = read_workspace_state(cwd.to_string_lossy().into_owned())
            .expect("read ok")
            .expect("some state");
        assert_eq!(read.version, 1);
        let audit = read.last_audit.expect("audit present");
        assert_eq!(audit.scope.as_deref(), Some("HEAD~3"));
        assert_eq!(audit.counts.error, 2);
        let build = read.last_build.expect("build present");
        assert_eq!(build.feature, "add Stripe checkout");
        assert_eq!(build.status, "completed");
        assert_eq!(build.verification.typecheck.as_deref(), Some("pass"));
    }

    #[test]
    fn layout_roundtrips_through_state_file() {
        let cwd = fresh_tmp();
        let mut state = WorkspaceState::default();
        state.layout = Some(Layout {
            sidebar_width: Some(280),
            problems_width: Some(420),
            preview_height: Some(360),
            ..Default::default()
        });
        write_workspace_state(cwd.to_string_lossy().into_owned(), state).unwrap();
        let read = read_workspace_state(cwd.to_string_lossy().into_owned())
            .unwrap()
            .unwrap();
        let layout = read.layout.expect("layout present");
        assert_eq!(layout.sidebar_width, Some(280));
        assert_eq!(layout.problems_width, Some(420));
        assert_eq!(layout.preview_height, Some(360));
    }

    #[test]
    fn write_caps_recent_files_at_ten() {
        let cwd = fresh_tmp();
        let mut state = WorkspaceState::default();
        for i in 0..25 {
            state.recent_files.push(RecentFile {
                path: format!("file-{}.ts", i),
                opened_at: "2026-04-25T19:30:00Z".into(),
            });
        }
        write_workspace_state(cwd.to_string_lossy().into_owned(), state).expect("write ok");
        let read = read_workspace_state(cwd.to_string_lossy().into_owned())
            .expect("ok")
            .expect("some");
        assert_eq!(read.recent_files.len(), 10);
        assert_eq!(read.recent_files[0].path, "file-0.ts");
        assert_eq!(read.recent_files[9].path, "file-9.ts");
    }

    #[test]
    fn corrupt_state_file_returns_err_not_panic() {
        let cwd = fresh_tmp();
        let prism_dir = cwd.join(PRISM_DIR);
        fs::create_dir_all(&prism_dir).unwrap();
        fs::write(prism_dir.join(STATE_FILENAME), b"{not json").unwrap();
        let res = read_workspace_state(cwd.to_string_lossy().into_owned());
        assert!(res.is_err(), "corrupt state should error, got {:?}", res);
    }

    #[test]
    fn empty_cwd_errors() {
        assert!(read_workspace_state("".into()).is_err());
        assert!(write_workspace_state("".into(), WorkspaceState::default()).is_err());
        assert!(write_build_report("".into(), "x.md".into(), "x".into(), None).is_err());
        assert!(read_latest_build_report("".into(), None).is_err());
    }

    #[test]
    fn write_build_report_writes_under_prism_builds() {
        let cwd = fresh_tmp();
        let res = write_build_report(
            cwd.to_string_lossy().into_owned(),
            "build-2026-04-25T19-32-00.md".into(),
            "# Build Report\n\nBUILD COMPLETED\n".into(),
            Some(r#"{"status":"completed"}"#.into()),
        )
        .expect("should write");
        let dir = cwd.join(BUILDS_SUBDIR);
        assert!(dir.exists(), ".prism/builds/ not created");
        let md = Path::new(&res.path);
        assert!(md.exists(), "markdown missing: {}", res.path);
        let json_path = res.json_path.expect("sidecar should be written");
        assert!(Path::new(&json_path).exists(), "sidecar missing: {}", json_path);
        assert!(json_path.ends_with("build-2026-04-25T19-32-00.json"));
    }

    #[test]
    fn write_build_report_rejects_path_traversal() {
        let cwd = fresh_tmp();
        assert!(write_build_report(
            cwd.to_string_lossy().into_owned(),
            "../escape.md".into(),
            "x".into(),
            None,
        )
        .is_err());
        assert!(write_build_report(
            cwd.to_string_lossy().into_owned(),
            "sub/file.md".into(),
            "x".into(),
            None,
        )
        .is_err());
    }

    #[test]
    fn read_latest_build_report_picks_newest() {
        let cwd = fresh_tmp();
        write_build_report(
            cwd.to_string_lossy().into_owned(),
            "build-2026-04-25T19-30-00.md".into(),
            "older".into(),
            Some("{\"v\":1}".into()),
        )
        .unwrap();
        write_build_report(
            cwd.to_string_lossy().into_owned(),
            "build-2026-04-25T19-32-00.md".into(),
            "newer".into(),
            Some("{\"v\":2}".into()),
        )
        .unwrap();
        let lookup = read_latest_build_report(cwd.to_string_lossy().into_owned(), None)
            .expect("lookup ok");
        assert!(lookup.path.ends_with("build-2026-04-25T19-32-00.json"));
        assert_eq!(lookup.content, "{\"v\":2}");
    }

    #[test]
    fn read_latest_build_report_errors_when_dir_missing() {
        let cwd = fresh_tmp();
        let res = read_latest_build_report(cwd.to_string_lossy().into_owned(), None);
        assert!(res.is_err(), "expected error when no builds/ dir exists");
    }

    #[test]
    fn read_latest_build_report_honors_explicit_path() {
        let cwd = fresh_tmp();
        let res = write_build_report(
            cwd.to_string_lossy().into_owned(),
            "build-explicit.md".into(),
            "body".into(),
            Some("{\"explicit\":true}".into()),
        )
        .unwrap();
        let json_path = res.json_path.unwrap();
        let lookup = read_latest_build_report(
            cwd.to_string_lossy().into_owned(),
            Some(json_path.clone()),
        )
        .expect("explicit lookup ok");
        assert_eq!(lookup.path, json_path);
        assert_eq!(lookup.content, "{\"explicit\":true}");
    }
}
