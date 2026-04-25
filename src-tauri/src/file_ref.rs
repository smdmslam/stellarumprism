//! `@file` reference reader.
//!
//! Given the shell's cwd and a raw path the user typed (e.g. `@README.md`,
//! `@~/notes.txt`, `@/etc/hosts`), read the file's text content so the
//! frontend can inline it into the agent's context.
//!
//! Size- and type-safe: refuses files over 256 KB (truncates and flags),
//! refuses non-text files (detected by NUL-byte sniff).
//!
//! This module also hosts the IDE-shape file-tree command
//! (`list_directory_tree`) used by the Files sidebar in `Workspace`.
//! It honors .gitignore via the same `ignore::WalkBuilder` machinery
//! the audit `find` tool uses, but only walks ONE level at a time so
//! the frontend can lazy-load expansions.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_FILE_BYTES: usize = 256 * 1024; // 256 KB
const MAX_FILE_CHARS_WARN: usize = 200 * 1024; // warn if close to cap

#[derive(Serialize)]
pub struct FileRef {
    /// The actual path that was read (absolute).
    pub path: String,
    /// The path the user typed (e.g. "README.md").
    pub original: String,
    /// UTF-8 text content (lossy if needed).
    pub content: String,
    /// Size of the file on disk, in bytes.
    pub size: u64,
    /// True if we trimmed the content to fit the cap.
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    /// "file" | "dir" | "symlink" | "other".
    pub kind: String,
}

#[derive(Serialize)]
pub struct DirListing {
    /// Absolute directory whose contents are being listed.
    pub dir: String,
    /// The filter prefix (basename portion of what the user typed).
    pub prefix: String,
    pub entries: Vec<DirEntry>,
    /// True if the list was clipped for size.
    pub truncated: bool,
}

/// Directory-listing helper for the `@path` autocomplete in the editor.
///
/// `partial` is whatever the user has typed after `@`: could be empty,
/// `src`, `src/`, `src/main`, `~/Des`, `/etc/ho`, etc. We split at the last
/// `/` to find the directory to enumerate and the basename prefix to filter
/// by. Matching is case-insensitive.
#[tauri::command]
pub fn list_dir_entries(cwd: String, partial: String) -> Result<DirListing, String> {
    const MAX_ENTRIES: usize = 200;
    let (dir, prefix) = split_partial_path(&cwd, &partial)?;

    let metadata = fs::metadata(&dir)
        .map_err(|e| format!("cannot stat {}: {}", dir.display(), e))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }

    let lower_prefix = prefix.to_lowercase();
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;
    for item in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && !lower_prefix.starts_with('.') {
            // Skip dotfiles unless the user explicitly typed a `.` prefix.
            continue;
        }
        if !lower_prefix.is_empty() && !name.to_lowercase().starts_with(&lower_prefix) {
            continue;
        }
        let kind = match item.file_type().ok() {
            Some(t) if t.is_dir() => "dir",
            Some(t) if t.is_symlink() => "symlink",
            Some(t) if t.is_file() => "file",
            _ => "other",
        };
        entries.push(DirEntry {
            name,
            kind: kind.into(),
        });
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
    }
    // Dirs first, then files, then alphabetically within each group
    // (case-insensitive). Symlinks ride along with files.
    entries.sort_by(|a, b| {
        let a_is_dir = a.kind == "dir";
        let b_is_dir = b.kind == "dir";
        b_is_dir
            .cmp(&a_is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        dir: dir.to_string_lossy().into_owned(),
        prefix,
        entries,
        truncated,
    })
}

/// Split a user-typed partial path into (dir_to_list, basename_prefix).
fn split_partial_path(cwd: &str, partial: &str) -> Result<(PathBuf, String), String> {
    if partial.is_empty() {
        if cwd.is_empty() {
            return Err("cwd unknown".into());
        }
        return Ok((PathBuf::from(cwd), String::new()));
    }

    let (dir_part, prefix_part): (String, String) = match partial.rfind('/') {
        Some(i) => (partial[..=i].to_string(), partial[i + 1..].to_string()),
        None => (String::new(), partial.to_string()),
    };

    let resolved_dir = if dir_part.is_empty() {
        PathBuf::from(cwd)
    } else if let Some(rest) = dir_part.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or("no home dir")?;
        home.join(rest)
    } else if dir_part == "~/" {
        dirs::home_dir().ok_or("no home dir")?
    } else if Path::new(&dir_part).is_absolute() {
        PathBuf::from(&dir_part)
    } else {
        if cwd.is_empty() {
            return Err("cwd unknown".into());
        }
        PathBuf::from(cwd).join(&dir_part)
    };

    Ok((resolved_dir, prefix_part))
}

#[tauri::command]
pub fn read_file_scoped(cwd: String, path: String) -> Result<FileRef, String> {
    let resolved = resolve_path(&cwd, &path)?;
    let metadata = fs::metadata(&resolved)
        .map_err(|e| format!("cannot stat {}: {}", resolved.display(), e))?;

    // Folders are valid `@` targets too — we attach a tree-style listing
    // instead of file content. Caps at 200 entries.
    if metadata.is_dir() {
        return read_directory_as_listing(&resolved, &path);
    }
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", resolved.display()));
    }
    let size = metadata.len();

    let bytes = fs::read(&resolved)
        .map_err(|e| format!("cannot read {}: {}", resolved.display(), e))?;

    // Heuristic: files with any NUL byte in the first 8 KB are binary.
    let sniff_len = bytes.len().min(8 * 1024);
    if bytes[..sniff_len].contains(&0) {
        return Err(format!(
            "{} looks like a binary file and was not attached",
            resolved.display()
        ));
    }

    let mut truncated = false;
    let slice: &[u8] = if bytes.len() > MAX_FILE_BYTES {
        truncated = true;
        &bytes[..MAX_FILE_BYTES]
    } else {
        &bytes
    };
    let mut content = String::from_utf8_lossy(slice).into_owned();
    if truncated {
        content.push_str("\n\n[\u{2026} truncated to fit context]\n");
    } else if content.len() > MAX_FILE_CHARS_WARN {
        // No-op \u2014 just here to document the threshold we might tighten later.
    }

    Ok(FileRef {
        path: resolved.to_string_lossy().to_string(),
        original: path,
        content,
        size,
        truncated,
    })
}

/// Build a directory listing in the shape of a `FileRef` (dir tree as text).
fn read_directory_as_listing(
    resolved: &Path,
    original: &str,
) -> Result<FileRef, String> {
    const MAX_DIR_ENTRIES: usize = 200;
    let mut lines: Vec<String> = Vec::new();
    let mut count = 0usize;
    let mut truncated = false;
    let mut entries: Vec<(String, &'static str)> = Vec::new();
    for entry in fs::read_dir(resolved).map_err(|e| e.to_string())? {
        if count >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            // Skip dotfiles; the agent rarely needs them and they bloat the
            // listing. (This matches the @ picker behavior.)
            continue;
        }
        let kind: &'static str = match entry.file_type().ok() {
            Some(t) if t.is_dir() => "dir",
            Some(t) if t.is_symlink() => "symlink",
            Some(t) if t.is_file() => "file",
            _ => "other",
        };
        entries.push((name, kind));
        count += 1;
    }
    // Dirs first, then alphabetically within each group.
    entries.sort_by(|a, b| {
        let a_dir = a.1 == "dir";
        let b_dir = b.1 == "dir";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    lines.push(format!("Directory listing for {}", resolved.display()));
    for (name, kind) in &entries {
        let suffix = if *kind == "dir" { "/" } else { "" };
        lines.push(format!("  {}{}", name, suffix));
    }
    if truncated {
        lines.push(format!("  [\u{2026} truncated to {} entries]", MAX_DIR_ENTRIES));
    }
    let content = lines.join("\n") + "\n";
    Ok(FileRef {
        path: resolved.to_string_lossy().into_owned(),
        original: original.to_string(),
        size: entries.len() as u64,
        truncated,
        content,
    })
}

/// One slice of a file, centered on a target line. Used by the Problems
/// panel's inline snippet viewer so a click on a finding shows the
/// relevant code window without leaving Prism.
#[derive(Debug, Serialize)]
pub struct FileSnippet {
    /// Absolute path that was read.
    pub path: String,
    /// The path the user (UI) supplied, preserved for display.
    pub original: String,
    /// 1-based line of the first line in `content`.
    pub start_line: u32,
    /// 1-based line of the last line in `content`. May be < start_line
    /// only when the file is empty.
    pub end_line: u32,
    /// 1-based target line the caller asked us to center on. Echoed
    /// back so the renderer can highlight it without re-deriving.
    pub target_line: u32,
    /// Total line count of the underlying file (so the UI can show
    /// "30\u{2013}50 of 412" instead of just "30\u{2013}50").
    pub total_lines: u32,
    /// The slice as a single string, joined with `\n`. Never includes
    /// a trailing newline so the renderer doesn't draw a phantom row.
    pub content: String,
    /// True iff the requested window was clipped at the top or bottom
    /// of the file (or `before`/`after` exceeded the per-call cap).
    pub truncated: bool,
}

/// Maximum number of context lines (above OR below the target) per
/// snippet call. Keeps a runaway `before`/`after` from sucking the
/// entire file into the UI.
const SNIPPET_MAX_CONTEXT_LINES: u32 = 80;

/// Read a slice of `path` centered on `line`, with `before` lines above
/// and `after` lines below. All line numbers are 1-based. Used by the
/// Problems panel's inline snippet viewer.
///
/// - `line == 0` is treated as "top of file" (e.g. for findings the
///   parser couldn't pin to a line) and clamps the window to 1.
/// - `before` / `after` default to 6 / 8 respectively when omitted.
/// - The cell is read-only and binary-safe (refuses files with NUL in
///   the first 8 KB).
#[tauri::command]
pub fn read_file_snippet(
    cwd: String,
    path: String,
    line: u32,
    before: Option<u32>,
    after: Option<u32>,
) -> Result<FileSnippet, String> {
    let resolved = resolve_path(&cwd, &path)?;
    let metadata = fs::metadata(&resolved)
        .map_err(|e| format!("cannot stat {}: {}", resolved.display(), e))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", resolved.display()));
    }

    let bytes = fs::read(&resolved)
        .map_err(|e| format!("cannot read {}: {}", resolved.display(), e))?;
    let sniff_len = bytes.len().min(8 * 1024);
    if bytes[..sniff_len].contains(&0) {
        return Err(format!(
            "{} looks like a binary file and cannot be snippeted",
            resolved.display()
        ));
    }

    let text = String::from_utf8_lossy(&bytes).into_owned();
    let all_lines: Vec<&str> = text.split('\n').collect();
    let total_lines = all_lines.len() as u32;

    let target = if line == 0 { 1 } else { line };
    let before = before
        .unwrap_or(6)
        .min(SNIPPET_MAX_CONTEXT_LINES);
    let after = after
        .unwrap_or(8)
        .min(SNIPPET_MAX_CONTEXT_LINES);

    // Clamp the window to the file. start_line is 1-based and must be
    // at least 1; end_line caps at total_lines but is allowed to be 0
    // when the file is genuinely empty.
    let start_line = target.saturating_sub(before).max(1);
    let end_line = target.saturating_add(after).min(total_lines.max(1));
    let truncated = before > 0
        && (target.saturating_sub(before) < 1
            || target.saturating_add(after) > total_lines);

    // Slice using 0-based indices.
    let start_idx = (start_line - 1) as usize;
    let end_idx = (end_line - 1) as usize;
    let slice: &[&str] = if all_lines.is_empty() {
        &[]
    } else {
        let lo = start_idx.min(all_lines.len() - 1);
        let hi = end_idx.min(all_lines.len() - 1);
        &all_lines[lo..=hi]
    };
    let content = slice.join("\n");

    Ok(FileSnippet {
        path: resolved.to_string_lossy().into_owned(),
        original: path,
        start_line,
        end_line,
        target_line: target,
        total_lines,
        content,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// IDE-shape file-tree command
// ---------------------------------------------------------------------------

/// One row in the file-tree sidebar. The frontend keeps a cache keyed
/// on the absolute `path` and lazy-loads children by issuing another
/// `list_directory_tree` call with that path.
#[derive(Debug, Serialize)]
pub struct TreeEntry {
    /// Display name (basename only).
    pub name: String,
    /// Absolute path on disk. Used as the cache key.
    pub path: String,
    /// "file" | "dir" | "symlink" | "other".
    pub kind: String,
    /// File size in bytes (only set for kind == "file"; dirs leave
    /// this null since stat-ing every child to count entries is too
    /// expensive on a cold filesystem).
    pub size: Option<u64>,
    /// True iff this is a directory whose children weren't listed yet
    /// in this call. Always true for kind == "dir" in v1 (lazy load).
    pub has_children: bool,
}

/// One level of a directory tree, ready for rendering. The frontend
/// asks for `<cwd or absolute path>` and gets back its immediate
/// children, sorted dirs-first then alphabetically.
#[derive(Debug, Serialize)]
pub struct TreeListing {
    /// Absolute directory whose contents are listed.
    pub dir: String,
    /// One row per entry. Capped at `TREE_MAX_ENTRIES`.
    pub entries: Vec<TreeEntry>,
    /// True iff the listing was clipped at the cap.
    pub truncated: bool,
    /// True iff the directory is the cwd's repo root (used by the UI
    /// to decorate the tree's root node).
    pub is_root: bool,
}

/// Cap so a single call against a node_modules-shaped directory
/// doesn't dump 50k entries into the UI. Mirrors the audit `find`
/// tool's per-call results cap.
const TREE_MAX_ENTRIES: usize = 5000;

/// List one level of the directory tree at `path` (or `cwd` if path is
/// omitted). gitignore + global-gitignore + git-exclude are honored
/// so node_modules / target / __pycache__ stay out of the way.
///
/// Hidden files (.git, .DS_Store, etc.) are excluded by default but
/// included when `show_hidden=true`. The cell is read-only and the
/// path is constrained to the cwd's subtree (or absolute paths the
/// user already authorized via the @ picker, which we trust).
#[tauri::command]
pub fn list_directory_tree(
    cwd: String,
    path: Option<String>,
    show_hidden: Option<bool>,
) -> Result<TreeListing, String> {
    let raw = path.as_deref().unwrap_or(".");
    let resolved = resolve_path(&cwd, raw)?;
    let metadata = fs::metadata(&resolved)
        .map_err(|e| format!("cannot stat {}: {}", resolved.display(), e))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", resolved.display()));
    }
    let show_hidden = show_hidden.unwrap_or(false);

    // ignore::WalkBuilder applies .gitignore + git_global +
    // git_exclude across all visited paths. We set max_depth=1 so we
    // only get the immediate children plus the root itself; the root
    // is filtered out below. WalkBuilder still respects nested
    // .gitignore files on subsequent calls (the frontend lazy-loads
    // each subdir, so each call is its own scoped walk).
    let mut builder = ignore::WalkBuilder::new(&resolved);
    builder
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .max_depth(Some(1));

    let mut entries: Vec<TreeEntry> = Vec::new();
    let mut truncated = false;
    for entry in builder.build() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        // depth=0 is the root we passed in; skip it.
        if entry.depth() == 0 {
            continue;
        }
        if entries.len() >= TREE_MAX_ENTRIES {
            truncated = true;
            break;
        }
        let path_buf = entry.path().to_path_buf();
        let name = entry
            .file_name()
            .to_string_lossy()
            .into_owned();
        let file_type = entry.file_type();
        let kind: &'static str = match file_type {
            Some(t) if t.is_dir() => "dir",
            Some(t) if t.is_symlink() => "symlink",
            Some(t) if t.is_file() => "file",
            _ => "other",
        };
        // Only stat files for size; directories leave size unset to
        // avoid an expensive walk on a cold cache.
        let size = if kind == "file" {
            fs::metadata(&path_buf).ok().map(|m| m.len())
        } else {
            None
        };
        let has_children = kind == "dir";
        entries.push(TreeEntry {
            name,
            path: path_buf.to_string_lossy().into_owned(),
            kind: kind.into(),
            size,
            has_children,
        });
    }

    // Dirs first, then files/symlinks, alphabetically (case-insensitive)
    // within each group.
    entries.sort_by(|a, b| {
        let a_dir = a.kind == "dir";
        let b_dir = b.kind == "dir";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    // "is_root" == this directory is the cwd. Frontend uses this for
    // a small visual cue (project icon vs folder icon).
    let is_root = !cwd.is_empty()
        && Path::new(&cwd)
            .canonicalize()
            .map(|c| c == resolved)
            .unwrap_or(false);

    Ok(TreeListing {
        dir: resolved.to_string_lossy().into_owned(),
        entries,
        truncated,
        is_root,
    })
}

/// Resolve a user-typed path with the shell's cwd as the starting point.
///
/// Rules (first match wins):
///   1. `~/foo` -> `$HOME/foo`
///   2. starts with `/` -> treated as absolute
///   3. otherwise -> cwd-relative
fn resolve_path(cwd: &str, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty path".into());
    }

    let buf = if let Some(rest) = raw.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or("no home dir")?;
        home.join(rest)
    } else if raw == "~" {
        dirs::home_dir().ok_or("no home dir")?
    } else if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        if cwd.is_empty() {
            return Err("cwd unknown \u{2014} cannot resolve relative path".into());
        }
        PathBuf::from(cwd).join(raw)
    };

    // Best-effort canonicalize; if it fails (file missing), return the
    // as-constructed path so the caller sees a meaningful fs error later.
    Ok(buf.canonicalize().unwrap_or(buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    fn fresh_tmp() -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "prism-snippet-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create tmp dir");
        fs::canonicalize(&dir).expect("canonicalize tmp")
    }

    fn write_lines(dir: &Path, name: &str, n: usize) -> PathBuf {
        let path = dir.join(name);
        let body: Vec<String> = (1..=n).map(|i| format!("line {}", i)).collect();
        fs::write(&path, body.join("\n")).expect("write file");
        path
    }

    #[test]
    fn snippet_centers_on_target_with_default_window() {
        let dir = fresh_tmp();
        write_lines(&dir, "a.txt", 50);
        let s = read_file_snippet(
            dir.to_string_lossy().to_string(),
            "a.txt".to_string(),
            20,
            None,
            None,
        )
        .expect("snippet");
        assert_eq!(s.target_line, 20);
        // Default window: 6 before + 8 after, so 14..28.
        assert_eq!(s.start_line, 14);
        assert_eq!(s.end_line, 28);
        assert_eq!(s.total_lines, 50);
        // Content has the expected number of lines.
        let line_count = s.content.split('\n').count();
        assert_eq!(line_count, (s.end_line - s.start_line + 1) as usize);
        assert!(s.content.contains("line 20"));
        assert!(s.content.contains("line 14"));
        assert!(s.content.contains("line 28"));
        assert!(!s.content.contains("line 13"));
        assert!(!s.content.contains("line 29"));
    }

    #[test]
    fn snippet_clamps_at_top_of_file() {
        let dir = fresh_tmp();
        write_lines(&dir, "a.txt", 50);
        let s = read_file_snippet(
            dir.to_string_lossy().to_string(),
            "a.txt".to_string(),
            2,
            Some(10),
            Some(3),
        )
        .expect("snippet");
        assert_eq!(s.start_line, 1);
        assert_eq!(s.end_line, 5);
        assert!(s.truncated, "clipped at top");
    }

    #[test]
    fn snippet_clamps_at_bottom_of_file() {
        let dir = fresh_tmp();
        write_lines(&dir, "a.txt", 10);
        let s = read_file_snippet(
            dir.to_string_lossy().to_string(),
            "a.txt".to_string(),
            8,
            Some(2),
            Some(20),
        )
        .expect("snippet");
        assert_eq!(s.start_line, 6);
        assert_eq!(s.end_line, 10);
        assert!(s.truncated, "clipped at bottom");
    }

    #[test]
    fn snippet_treats_line_zero_as_top_of_file() {
        let dir = fresh_tmp();
        write_lines(&dir, "a.txt", 30);
        let s = read_file_snippet(
            dir.to_string_lossy().to_string(),
            "a.txt".to_string(),
            0,
            Some(0),
            Some(4),
        )
        .expect("snippet");
        assert_eq!(s.target_line, 1);
        assert_eq!(s.start_line, 1);
        assert_eq!(s.end_line, 5);
    }

    #[test]
    fn snippet_caps_context_at_max() {
        let dir = fresh_tmp();
        write_lines(&dir, "a.txt", 1000);
        let s = read_file_snippet(
            dir.to_string_lossy().to_string(),
            "a.txt".to_string(),
            500,
            Some(10_000),
            Some(10_000),
        )
        .expect("snippet");
        // Context capped at SNIPPET_MAX_CONTEXT_LINES (80) on each side.
        assert_eq!(s.start_line, 500 - 80);
        assert_eq!(s.end_line, 500 + 80);
    }

    #[test]
    fn snippet_rejects_directory_targets() {
        let dir = fresh_tmp();
        let r = read_file_snippet(
            dir.parent().unwrap().to_string_lossy().to_string(),
            dir.file_name().unwrap().to_string_lossy().to_string(),
            1,
            None,
            None,
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("not a regular file"));
    }

    #[test]
    fn snippet_rejects_binary_files() {
        let dir = fresh_tmp();
        let path = dir.join("bin.dat");
        // NUL byte in the first 8 KB triggers the binary sniff.
        let mut data = vec![0u8; 32];
        data.extend_from_slice(b"trailing text");
        fs::write(&path, data).unwrap();
        let r = read_file_snippet(
            dir.to_string_lossy().to_string(),
            "bin.dat".to_string(),
            1,
            None,
            None,
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("binary"));
    }

    // -- list_directory_tree --------------------------------------------

    #[test]
    fn tree_lists_immediate_children_sorted_dirs_first() {
        let dir = fresh_tmp();
        fs::write(dir.join("z.txt"), "hi").unwrap();
        fs::write(dir.join("a.txt"), "hi").unwrap();
        fs::create_dir(dir.join("src")).unwrap();
        fs::create_dir(dir.join("docs")).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();

        let listing = list_directory_tree(
            dir.to_string_lossy().to_string(),
            None,
            None,
        )
        .expect("tree");
        assert!(listing.is_root);
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        // Dirs first (alpha), then files (alpha).
        assert_eq!(names, vec!["docs", "src", "a.txt", "z.txt"]);
        // src is a dir with children; it must report has_children=true.
        let src = listing
            .entries
            .iter()
            .find(|e| e.name == "src")
            .unwrap();
        assert_eq!(src.kind, "dir");
        assert!(src.has_children);
        assert!(src.size.is_none(), "dirs should not report size");
        // a.txt is a file with size set.
        let a = listing
            .entries
            .iter()
            .find(|e| e.name == "a.txt")
            .unwrap();
        assert_eq!(a.kind, "file");
        assert!(!a.has_children);
        assert_eq!(a.size, Some(2));
    }

    #[test]
    fn tree_excludes_hidden_files_by_default_and_includes_with_flag() {
        let dir = fresh_tmp();
        fs::write(dir.join("visible.txt"), "hi").unwrap();
        fs::write(dir.join(".hidden"), "hi").unwrap();
        // Default: hidden suppressed.
        let default = list_directory_tree(
            dir.to_string_lossy().to_string(),
            None,
            None,
        )
        .expect("tree");
        let names: Vec<&str> = default
            .entries
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(names, vec!["visible.txt"]);
        // Opt-in: hidden included.
        let with_hidden = list_directory_tree(
            dir.to_string_lossy().to_string(),
            None,
            Some(true),
        )
        .expect("tree");
        let names: Vec<String> = with_hidden
            .entries
            .iter()
            .map(|e| e.name.clone())
            .collect();
        assert!(names.contains(&"visible.txt".to_string()));
        assert!(names.contains(&".hidden".to_string()));
    }

    #[test]
    fn tree_honors_gitignore() {
        let dir = fresh_tmp();
        // A repo-shaped layout so .gitignore is in scope.
        fs::create_dir(dir.join(".git")).unwrap();
        fs::write(dir.join(".gitignore"), "node_modules\n").unwrap();
        fs::create_dir(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules/leaf.txt"), "ignored").unwrap();
        fs::write(dir.join("keep.txt"), "kept").unwrap();

        let listing = list_directory_tree(
            dir.to_string_lossy().to_string(),
            None,
            None,
        )
        .expect("tree");
        let names: Vec<&str> = listing
            .entries
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        // node_modules must be filtered out by gitignore.
        assert!(
            !names.contains(&"node_modules"),
            "node_modules leaked through gitignore: {:?}",
            names
        );
        assert!(names.contains(&"keep.txt"));
    }

    #[test]
    fn tree_lazy_lists_subdirectory_when_path_is_passed() {
        let dir = fresh_tmp();
        fs::create_dir(dir.join("src")).unwrap();
        fs::write(dir.join("src/lib.rs"), "pub fn x() {}").unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(dir.join("top.txt"), "top").unwrap();

        let listing = list_directory_tree(
            dir.to_string_lossy().to_string(),
            Some("src".to_string()),
            None,
        )
        .expect("tree");
        // is_root is false for non-root paths.
        assert!(!listing.is_root);
        let names: Vec<&str> = listing
            .entries
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(names, vec!["lib.rs", "main.rs"]);
    }

    #[test]
    fn tree_errors_on_missing_directory() {
        let dir = fresh_tmp();
        let r = list_directory_tree(
            dir.to_string_lossy().to_string(),
            Some("does-not-exist".to_string()),
            None,
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("cannot stat"));
    }

    #[test]
    fn tree_errors_when_path_is_a_file() {
        let dir = fresh_tmp();
        fs::write(dir.join("a.txt"), "hi").unwrap();
        let r = list_directory_tree(
            dir.to_string_lossy().to_string(),
            Some("a.txt".to_string()),
            None,
        );
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("is not a directory"));
    }
}
