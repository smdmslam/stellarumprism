//! Second Pass artifact persistence.
//!
//! The audit workflow produces a markdown report on every successful
//! `/audit` run. This module exposes the Tauri command the frontend
//! calls to write that file under `<cwd>/.prism/second-pass/`.
//!
//! Keeping it in its own module (rather than appending to `tools.rs`)
//! because this is NOT an agent tool \u2014 the LLM never calls it
//! directly. It's a frontend-triggered side-effect on a mode-done
//! event, and it's explicitly scoped to the `.prism/` subtree.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Name of the per-project directory every Second Pass report is written
/// to. Always under `<cwd>/.prism/second-pass/`.
const REPORT_SUBDIR: &str = ".prism/second-pass";

#[derive(Debug, Serialize)]
pub struct WriteAuditReportResult {
    /// Absolute path the report was written to.
    pub path: String,
    /// Size in bytes of the written content.
    pub bytes_written: u64,
}

/// Write a Second Pass audit report to disk under the workspace's
/// `.prism/second-pass/` directory. Creates the directory (and its
/// parent) if it doesn't exist yet. Writes atomically via tmp + rename
/// so a partial write can't leave a corrupt report.
///
/// The filename is passed from the frontend so the frontend controls
/// the timestamp format; we only validate it doesn't contain path
/// separators (no `../`, no absolute path tricks).
#[tauri::command]
pub fn write_audit_report(
    cwd: String,
    filename: String,
    content: String,
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

    Ok(WriteAuditReportResult {
        path: full_path.to_string_lossy().into_owned(),
        bytes_written: content.len() as u64,
    })
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
        )
        .expect("should write");
        let expected_parent = cwd.join(".prism").join("second-pass");
        assert!(
            expected_parent.exists(),
            ".prism/second-pass/ not created"
        );
        let written = Path::new(&res.path);
        assert!(written.exists(), "report file missing: {}", res.path);
        let contents = fs::read_to_string(written).unwrap();
        assert!(contents.contains("# Second Pass Report"));
        assert_eq!(res.bytes_written, contents.len() as u64);
    }

    #[test]
    fn rejects_path_traversal_in_filename() {
        let cwd = fresh_tmp();
        let res = write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "../escape.md".into(),
            "nope".into(),
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
        )
        .is_err());
        assert!(write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "sub\\file.md".into(),
            "nope".into(),
        )
        .is_err());
    }

    #[test]
    fn rejects_empty_cwd_or_filename() {
        assert!(write_audit_report("".into(), "a.md".into(), "x".into()).is_err());
        let cwd = fresh_tmp();
        assert!(write_audit_report(
            cwd.to_string_lossy().into_owned(),
            "".into(),
            "x".into(),
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
        )
        .unwrap();
        write_audit_report(
            cwd.to_string_lossy().into_owned(),
            filename.into(),
            "second".into(),
        )
        .unwrap();
        let target = cwd.join(".prism").join("second-pass").join(filename);
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
        )
        .unwrap();
        let tmp = cwd
            .join(".prism")
            .join("second-pass")
            .join(format!(".{}.prism-tmp", filename));
        assert!(!tmp.exists(), "tmp leaked: {}", tmp.display());
    }
}
