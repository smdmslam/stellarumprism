//! Second Pass artifact persistence + lookup.
//!
//! The audit workflow produces a markdown report on every successful
//! `/audit` run, plus a JSON sidecar (the machine-readable contract).
//! This module exposes:
//!   - `write_audit_report` — writes both files atomically.
//!   - `read_latest_audit_report` — returns the contents of the newest
//!     audit JSON sidecar so `/fix` can load findings.
//!
//! Keeping these in their own module (rather than appending to `tools.rs`)
//! because they are NOT agent tools \u2014 the LLM never calls them. They
//! are frontend-triggered side-effects scoped to the `prism/` subtree.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Name of the per-project directory every Second Pass report is written
/// to (`<cwd>/prism/second-pass/`).
const REPORT_SUBDIR: &str = "prism/second-pass";

#[derive(Debug, Serialize)]
pub struct WriteAuditReportResult {
    /// Absolute path the markdown report was written to.
    pub path: String,
    /// Size in bytes of the markdown content.
    pub bytes_written: u64,
    /// Absolute path of the JSON sidecar, when one was written.
    pub json_path: Option<String>,
    /// Size in bytes of the JSON sidecar.
    pub json_bytes_written: Option<u64>,
}

/// Write a Second Pass audit report to disk under the workspace's
/// `prism/second-pass/` directory. Creates the directory (and its
/// parent) if it doesn't exist yet. Writes atomically via tmp + rename
/// so a partial write can't leave a corrupt report.
///
/// When `json_content` is supplied, also writes a sidecar `<basename>.json`
/// next to the markdown. The sidecar is the machine-readable contract for
/// downstream consumers (`/fix`, future IDE panel, CI). Both files share
/// the same basename (only the extension differs) so a consumer that sees
/// `audit-<ts>.md` can locate `audit-<ts>.json` deterministically.
///
/// The filename is passed from the frontend so the frontend controls
/// the timestamp format; we only validate it doesn't contain path
/// separators (no `../`, no absolute path tricks).
#[tauri::command]
pub fn write_audit_report(
    cwd: String,
    filename: String,
    content: String,
    json_content: Option<String>,
) -> Result<WriteAuditReportResult, String> {
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

    let dir = Path::new(&cwd).join(REPORT_SUBDIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;

    let full_path = dir.join(&filename);
    atomic_write(&full_path, content.as_bytes())?;

    let (json_path, json_bytes_written) = match json_content {
        Some(json) => {
            // Sidecar shares the basename, only the extension differs.
            // We strip a trailing `.md` if present and append `.json`.
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

    Ok(WriteAuditReportResult {
        path: full_path.to_string_lossy().into_owned(),
        bytes_written: content.len() as u64,
        json_path,
        json_bytes_written,
    })
}

/// Discover the newest audit JSON sidecar under
/// `<cwd>/prism/second-pass/` and return its contents along with the
/// resolved absolute path. If `path` is supplied, use it directly
/// instead of searching (the user explicitly chose a report).
///
/// The directory is conventional and managed by us: the markdown report
/// and JSON sidecar are written here on every audit. We sort by filename
/// descending; since filenames embed an ISO-8601 timestamp, lexicographic
/// order matches chronological order.
#[derive(Debug, Serialize)]
pub struct AuditReportLookup {
    pub path: String,
    pub content: String,
    pub bytes: u64,
}

#[tauri::command]
pub fn read_latest_audit_report(
    cwd: String,
    path: Option<String>,
) -> Result<AuditReportLookup, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is empty; shell integration may not be started".into());
    }

    let target_path: PathBuf = match path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            // Allow absolute paths or paths relative to cwd. We do NOT
            // require the user-supplied path to live under prism/; if
            // they hand us an explicit file, we trust them.
            let pb = if Path::new(p).is_absolute() {
                PathBuf::from(p)
            } else {
                Path::new(&cwd).join(p)
            };
            pb
        }
        _ => find_latest_sidecar(&cwd)?,
    };

    let bytes = fs::metadata(&target_path)
        .map_err(|e| format!("cannot stat {}: {}", target_path.display(), e))?
        .len();
    let content = fs::read_to_string(&target_path)
        .map_err(|e| format!("cannot read {}: {}", target_path.display(), e))?;
    Ok(AuditReportLookup {
        path: target_path.to_string_lossy().into_owned(),
        content,
        bytes,
    })
}

/// Find the newest `audit-*.json` file under `<cwd>/prism/second-pass/`.
fn find_latest_sidecar(cwd: &str) -> Result<PathBuf, String> {
    let dir = Path::new(cwd).join(REPORT_SUBDIR);
    if !dir.exists() {
        return Err(format!(
            "no audit reports found at {} (run /audit first)",
            dir.display()
        ));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("cannot list {}: {}", dir.display(), e))? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let name_lossy = name.to_string_lossy();
        if name_lossy.starts_with("audit-") && name_lossy.ends_with(".json") {
            candidates.push(entry.path());
        }
    }
    if candidates.is_empty() {
        return Err(format!(
            "no audit JSON sidecars under {} (older audits without sidecars exist? re-run /audit)",
            dir.display()
        ));
    }
    // Filename has ISO-8601 timestamp, so lexicographic desc = newest.
    candidates.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    Ok(candidates.into_iter().next().expect("non-empty"))
}

/// Atomic-write: tmp file next to target, then rename. Same pattern
/// `tools.rs::atomic_write` uses, duplicated here so this module stays
/// self-contained.
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
        let dir = env::temp_dir().join(format!("prism-secondpass-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create tmp dir");
        fs::canonicalize(&dir).expect("canonicalize tmp")
    }

    #[test]
    fn writes_report_under_prism_subdir() {
        let cwd = fresh_tmp();
        let res = write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "audit-2026-04-24T00-00-00.md".into(),
            "# Second Pass Report\n\nHello.\n".into(),
            None,
        )
        .expect("should write");
        let expected_parent = cwd.join("prism").join("second-pass");
        assert!(
            expected_parent.exists(),
            "prism/second-pass/ not created"
        );
        let written = Path::new(&res.path);
        assert!(written.exists(), "report file missing: {}", res.path);
        let contents = fs::read_to_string(written).unwrap();
        assert!(contents.contains("# Second Pass Report"));
        assert_eq!(res.bytes_written, contents.len() as u64);
        // No JSON sidecar requested.
        assert!(res.json_path.is_none());
    }

    #[test]
    fn writes_json_sidecar_when_provided() {
        let cwd = fresh_tmp();
        let res = write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "audit-2026-04-24T01-02-03.md".into(),
            "# md\n".into(),
            Some(r#"{"findings":[]}"#.into()),
        )
        .expect("should write");
        let json_path = res.json_path.expect("sidecar should be written");
        let json_pb = Path::new(&json_path);
        assert!(json_pb.exists(), "sidecar missing: {}", json_path);
        assert!(
            json_path.ends_with("audit-2026-04-24T01-02-03.json"),
            "unexpected sidecar name: {}",
            json_path
        );
        let body = fs::read_to_string(json_pb).unwrap();
        assert_eq!(body, r#"{"findings":[]}"#);
        assert_eq!(res.json_bytes_written, Some(body.len() as u64));
    }

    #[test]
    fn rejects_path_traversal_in_filename() {
        let cwd = fresh_tmp();
        let res = write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "../escape.md".into(),
            "nope".into(),
            None,
        );
        assert!(res.is_err(), "traversal should be rejected");
    }

    #[test]
    fn rejects_slashes_in_filename() {
        let cwd = fresh_tmp();
        assert!(write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "sub/file.md".into(),
            "nope".into(),
            None,
        )
        .is_err());
        assert!(write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "sub\\file.md".into(),
            "nope".into(),
            None,
        )
        .is_err());
    }

    #[test]
    fn rejects_empty_cwd_or_filename() {
        assert!(write_audit_report("".into(), "a.md".into(), "x".into(), None).is_err());
        let cwd = fresh_tmp();
        assert!(write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "".into(),
            "x".into(),
            None,
        )
        .is_err());
    }

    #[test]
    fn overwrites_existing_report() {
        let cwd = fresh_tmp();
        let filename = "audit-same.md";
        write_audit_report(
            cwd.to_string_lossy().into_owned(),
            filename.into(),
            "first".into(),
            None,
        )
        .unwrap();
        write_audit_report(
            cwd.to_string_lossy().into_owned(),
            filename.into(),
            "second".into(),
            None,
        )
        .unwrap();
        let target = cwd.join("prism").join("second-pass").join(filename);
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
    }

    #[test]
    fn does_not_leak_tmp_on_success() {
        let cwd = fresh_tmp();
        let filename = "audit-clean.md";
        write_audit_report(
            cwd.to_string_lossy().into_owned(),
            filename.into(),
            "body".into(),
            None,
        )
        .unwrap();
        let tmp = cwd
            .join("prism")
            .join("second-pass")
            .join(format!(".{}.prism-tmp", filename));
        assert!(!tmp.exists(), "tmp leaked: {}", tmp.display());
    }
}
