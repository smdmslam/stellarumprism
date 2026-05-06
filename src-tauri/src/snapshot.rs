use std::path::Path;
use std::process::Command;

const SNAPSHOT_TAG: &str = "prism:auto-snapshot";

fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to execute git {:?}: {}", args, e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let reason = if !stderr.is_empty() { stderr } else { stdout };
        Err(format!("git {:?} failed: {}", args, reason))
    }
}

fn is_git_repo(cwd: &str) -> bool {
    if cwd.is_empty() || !Path::new(cwd).exists() {
        return false;
    }
    run_git(cwd, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

fn latest_prism_snapshot_ref(cwd: &str) -> Result<Option<String>, String> {
    let list = run_git(cwd, &["stash", "list", "--format=%gd\t%s"])?;
    for line in list.lines() {
        if !line.contains(SNAPSHOT_TAG) {
            continue;
        }
        if let Some((stash_ref, _msg)) = line.split_once('\t') {
            let r = stash_ref.trim();
            if !r.is_empty() {
                return Ok(Some(r.to_string()));
            }
        }
    }
    Ok(None)
}

pub fn create_auto_snapshot(cwd: &str, chat_id: &str) -> Result<String, String> {
    if !is_git_repo(cwd) {
        return Err("cwd is not inside a git work tree".to_string());
    }
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let label = format!("{SNAPSHOT_TAG} chat={chat_id} ts={stamp}");
    let _ = run_git(cwd, &["stash", "push", "-u", "-m", &label])?;
    if let Some(stash_ref) = latest_prism_snapshot_ref(cwd)? {
        Ok(format!("{stash_ref} ({label})"))
    } else {
        Ok(label)
    }
}

#[tauri::command]
pub fn restore_latest_snapshot(cwd: String) -> Result<String, String> {
    if !is_git_repo(&cwd) {
        return Err("snapshot restore unavailable: cwd is not a git repository".to_string());
    }
    let Some(stash_ref) = latest_prism_snapshot_ref(&cwd)? else {
        return Err("no Prism auto-snapshot found (nothing to restore)".to_string());
    };
    let out = run_git(&cwd, &["stash", "pop", &stash_ref])?;
    Ok(format!("restored {stash_ref}\n{out}"))
}

