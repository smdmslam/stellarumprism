// Session restore: persist the open-tabs list across app restarts.
//
// Single tiny JSON file at `~/.config/prism/session.json` that the
// frontend reads on launch and rewrites (debounced) whenever the tab
// list changes — a tab opens, closes, changes its title, or the
// shell's cwd updates via OSC 7.
//
// The persisted shape is intentionally minimal:
//   - id    : opaque tab identifier (regenerated on restore? see below)
//   - cwd   : project path the shell was last in (empty when unknown)
//   - title : auto-derived title so the tab strip looks right at zero
//             latency on launch
//
// We deliberately do NOT persist chat history here. `/save` already
// owns that lifecycle and saving a heavy chat blob on every cwd
// change would be wasteful + a privacy footgun. Tabs restore as
// "open in this project, ready to chat" — fresh agent session, same
// project context.
//
// Atomic write semantics: write to a tmp file in the same directory
// then rename into place. A power loss mid-write can never leave a
// partially-written session.json that would crash the next launch.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// One persisted tab record. `id` is intentionally a `String` and not
/// regenerated on restore — keeping the same id lets the chat / pty
/// layers reuse identifiers across launches if we ever want to
/// rehydrate session-scoped resources (we don't today).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTab {
    pub id: String,
    /// Last-seen cwd from OSC 7. Empty string when the tab never
    /// emitted one (e.g. the user closed it before typing anything).
    /// On restore, an empty cwd means "let the shell start wherever
    /// it would by default" — we simply skip the cd-injection.
    #[serde(default)]
    pub cwd: String,
    /// Auto-derived title (the tab strip's display text). Persisting
    /// this means a freshly-restored tab strip reads correctly the
    /// instant the window paints, before any background work runs.
    #[serde(default)]
    pub title: String,
}

/// Wire-shape of `session.json`. A single field today; the wrapper
/// makes it easy to add more state (last active tab index, window
/// bounds, etc.) without breaking older files via missing-default
/// behavior.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionState {
    #[serde(default)]
    pub tabs: Vec<PersistedTab>,
}

/// Path to the session file. Sibling of `config.toml` so anyone
/// poking around `~/.config/prism/` finds both in the same place.
fn session_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config").join("prism").join("session.json"))
}

/// Read the persisted session list. Defensive: missing file, empty
/// file, parse errors, and missing-dir all collapse to "no saved
/// tabs" rather than propagating an error. Frontend treats an empty
/// list as "first launch" and creates one fresh tab.
#[tauri::command]
pub fn read_session_state() -> SessionState {
    let Some(path) = session_path() else {
        return SessionState::default();
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return SessionState::default();
    };
    serde_json::from_str::<SessionState>(&contents).unwrap_or_default()
}

/// Persist the current tabs list. Atomic via tmp + rename so a partial
/// write can't leave a half-formed JSON file behind. Errors are
/// surfaced as `Err(String)` so the frontend can `console.warn` —
/// a session write failure shouldn't bubble up to the user as a
/// modal error since it's purely best-effort restore state.
#[tauri::command]
pub fn write_session_state(tabs: Vec<PersistedTab>) -> Result<(), String> {
    let Some(path) = session_path() else {
        return Err("no home directory".into());
    };
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
        }
    }
    let state = SessionState { tabs };
    let serialized = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize session: {}", e))?;

    // Atomic write: tmp file in same dir, then rename. The dotted
    // filename matches the convention used by `write_file_text` in
    // file_ref.rs so anything that walks the directory and ignores
    // dotfiles also ignores in-flight session writes.
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "session.json".into());
    let tmp = parent.join(format!(".{}.prism-tmp", file_name));
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("cannot write {}: {}", tmp.display(), e))?;
        f.write_all(serialized.as_bytes())
            .map_err(|e| format!("cannot write {}: {}", tmp.display(), e))?;
        f.sync_all().ok();
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot rename into {}: {}", path.display(), e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_state_serializes_round_trip() {
        // A fresh-install / first-launch state is `{ "tabs": [] }`.
        // Round-trip it through JSON to confirm the wire shape stays
        // stable across versions and that `#[serde(default)]` doesn't
        // make the field disappear on serialize.
        let s = SessionState::default();
        let j = serde_json::to_string(&s).unwrap();
        let back: SessionState = serde_json::from_str(&j).unwrap();
        assert_eq!(back.tabs.len(), 0);
    }

    #[test]
    fn missing_fields_default_to_empty_strings() {
        // Backward compatibility: if a future version adds new fields
        // on `PersistedTab`, an older session.json missing those
        // fields must still parse cleanly. Verify the existing
        // optional fields default correctly.
        let json = r#"{ "tabs": [{ "id": "abc" }] }"#;
        let parsed: SessionState = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.tabs.len(), 1);
        assert_eq!(parsed.tabs[0].id, "abc");
        assert_eq!(parsed.tabs[0].cwd, "");
        assert_eq!(parsed.tabs[0].title, "");
    }

    #[test]
    fn full_record_round_trips() {
        let original = SessionState {
            tabs: vec![
                PersistedTab {
                    id: "tab-1".into(),
                    cwd: "/Users/me/code/prism".into(),
                    title: "prism".into(),
                },
                PersistedTab {
                    id: "tab-2".into(),
                    cwd: "".into(),
                    title: "New Tab".into(),
                },
            ],
        };
        let j = serde_json::to_string(&original).unwrap();
        let back: SessionState = serde_json::from_str(&j).unwrap();
        assert_eq!(back.tabs.len(), 2);
        assert_eq!(back.tabs[0].cwd, "/Users/me/code/prism");
        assert_eq!(back.tabs[1].title, "New Tab");
    }
}
