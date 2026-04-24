//! `@file` reference reader.
//!
//! Given the shell's cwd and a raw path the user typed (e.g. `@README.md`,
//! `@~/notes.txt`, `@/etc/hosts`), read the file's text content so the
//! frontend can inline it into the agent's context.
//!
//! Size- and type-safe: refuses files over 256 KB (truncates and flags),
//! refuses non-text files (detected by NUL-byte sniff).

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
