//! Recipe runner support — Tauri commands the frontend orchestrator uses
//! to execute `shell` step kinds and persist consolidated reports.
//!
//! The frontend lives in `src/recipes/` and uses these commands as its
//! only Rust touchpoints. Slash-command steps go through the existing
//! agent pipeline and don't need a new Tauri surface.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use crate::diagnostics::run_with_timeout_public;

/// Output of one `shell` step in a recipe. Mirrors what the frontend
/// runner needs to render in the consolidated report.
#[derive(Serialize)]
pub struct RecipeShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Echo of the argv we actually ran, so the report can show it
    /// verbatim even when the frontend constructed it from a friendly
    /// step name (e.g. "typecheck" -> "pnpm typecheck").
    pub argv: Vec<String>,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: u64,
}

/// Run a pnpm script with a hard timeout and capture stdout/stderr.
///
/// `script_name` is appended to `pnpm` (so `script_name="typecheck"` runs
/// `pnpm typecheck`). The frontend recipe-runner uses this for the
/// `shell` step kind on recipes like Pre-Ship Check.
///
/// We deliberately don't expose a fully arbitrary `argv` shell-out from
/// the frontend yet — keeping the surface narrow to `pnpm <script>`
/// avoids re-litigating the run_shell allowlist debate that the agent
/// substrate already settled. If a recipe legitimately needs a non-pnpm
/// command, add a sibling Tauri command rather than widening this one.
#[tauri::command]
pub fn run_pnpm_script(
    cwd: String,
    script_name: String,
    timeout_secs: Option<u64>,
) -> Result<RecipeShellOutput, String> {
    let trimmed = script_name.trim();
    if trimmed.is_empty() {
        return Err("script_name must not be empty".into());
    }
    // Reject anything that looks like a flag or an argv smuggle. pnpm
    // script names are bare identifiers like `typecheck`, `test`,
    // `build`, `audit`. Arguments to the script (if a future recipe
    // needs them) should ride on a follow-up command.
    if trimmed.starts_with('-') || trimmed.contains(char::is_whitespace) {
        return Err(format!(
            "script_name {:?} looks unsafe; only bare pnpm script names are accepted",
            trimmed
        ));
    }
    let cwd_path = PathBuf::from(&cwd);
    if cwd.trim().is_empty() || !cwd_path.is_dir() {
        return Err(format!("cwd {:?} is not a directory", cwd));
    }
    // Spawning a Tauri app from Finder / Launchpad on macOS gets a
    // bare PATH (no Homebrew, no nvm, no pnpm). Going through a login
    // shell sources the user's profile and produces the PATH the user
    // sees in their terminal, so `pnpm` resolves the same way it does
    // there. The `script_name` is validated above (no whitespace, no
    // leading dash), so embedding it in the shell `-c` string is safe;
    // there's no metacharacter that could escape.
    //
    // On Windows we fall back to direct spawn \u2014 GUI apps there
    // typically inherit the registry PATH including npm shims.
    #[cfg(unix)]
    let argv: Vec<String> = vec![
        "/bin/sh".to_string(),
        "-lc".to_string(),
        format!("pnpm {}", trimmed),
    ];
    #[cfg(not(unix))]
    let argv: Vec<String> = vec!["pnpm".to_string(), trimmed.to_string()];
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(300));
    let started = std::time::Instant::now();
    let (output, timed_out) = run_with_timeout_public(&argv, &cwd_path, timeout)?;
    let duration_ms = started.elapsed().as_millis() as u64;
    Ok(RecipeShellOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code(),
        timed_out,
        argv,
        duration_ms,
    })
}

/// Result of writing a consolidated recipe report.
#[derive(Serialize)]
pub struct RecipeReportWriteResult {
    pub path: String,
    pub bytes_written: u64,
}

/// Persist the consolidated recipe report markdown under
/// `~/Documents/Prism/Reports/`. Creates the directory on demand.
///
/// Filenames are caller-supplied (the frontend builds them from
/// `<recipe-id>-<ts>.md`); we only validate that the name has no path
/// separators so the report can't escape the Reports directory.
#[tauri::command]
pub fn write_recipe_report(
    filename: String,
    content: String,
) -> Result<RecipeReportWriteResult, String> {
    let trimmed = filename.trim();
    if trimmed.is_empty() {
        return Err("filename must not be empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!(
            "filename {:?} must not contain path separators or '..'",
            trimmed
        ));
    }
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let reports_dir = home.join("Documents").join("Prism").join("Reports");
    fs::create_dir_all(&reports_dir).map_err(|e| {
        format!("cannot create {}: {}", reports_dir.display(), e)
    })?;
    let target = reports_dir.join(trimmed);
    let bytes = content.as_bytes();
    fs::write(&target, bytes)
        .map_err(|e| format!("cannot write {}: {}", target.display(), e))?;
    Ok(RecipeReportWriteResult {
        path: target.to_string_lossy().into_owned(),
        bytes_written: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_script_with_whitespace() {
        let r = run_pnpm_script(
            "/tmp".to_string(),
            "typecheck && rm -rf /".to_string(),
            None,
        );
        assert!(r.is_err());
    }

    #[test]
    fn rejects_script_starting_with_dash() {
        let r = run_pnpm_script(
            "/tmp".to_string(),
            "--config=/etc/passwd".to_string(),
            None,
        );
        assert!(r.is_err());
    }

    #[test]
    fn rejects_filename_with_slash() {
        let r = write_recipe_report(
            "../escape.md".to_string(),
            "x".to_string(),
        );
        assert!(r.is_err());
        let r2 = write_recipe_report("foo/bar.md".to_string(), "x".to_string());
        assert!(r2.is_err());
    }

}
