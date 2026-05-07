//! Skills foundation (`MASTER-Plan-II#7.1`).
//!
//! Two Tauri commands the frontend needs to surface skills:
//!   - `list_skills(cwd)`  — cheap manifest of every `.md` under
//!     `prism/skills/`, with `{slug, name, description, sizeBytes}`.
//!     Bodies are NOT read here; this is what the LLM-aware track's
//!     manifest line is built from on every turn, so it has to be cheap.
//!   - `read_skill(cwd, slug)` — returns the body. Used by both Track A
//!     (intentional Load → chip → body in systemPrefix) and Track B
//!     (LLM `read_skill` tool call). Subject to the per-skill 32 KB
//!     hard cap from `src/skill-limits.ts` so a runaway file can't
//!     silently bloat agent context.
//!
//! Description derivation (no-retrofit policy): the existing skills
//! corpus is plain markdown without YAML frontmatter. We honor
//! frontmatter when present, but fall back to deriving a description
//! from the first content paragraph so the 19 existing files work
//! untouched. New skills MAY add `name:` / `description:` frontmatter
//! when the derived line isn't tight enough — see
//! `prism/skills/README.md` and `docs/skills.md` for authoring rules.

use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashSet;

use serde::Serialize;

/// Per-skill hard cap, in bytes. Mirrors `SKILL_HARD_CAP_BYTES` in
/// `src/skill-limits.ts` (32 KB). Keep these two in sync — if the
/// frontend cap relaxes, this one should too, and vice versa, so the
/// reason "your skill won't engage" never disagrees between layers.
const SKILL_HARD_CAP_BYTES: usize = 32 * 1024;

/// How long a derived description can be before we ellipsize it.
/// Keeps the LLM-aware manifest line readable and bounds the per-turn
/// token cost when the toggle is on.
const DESCRIPTION_MAX_CHARS: usize = 160;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    /// Filename without the `.md` extension. Stable identifier; used
    /// as the argument to `read_skill` and as the key in
    /// `enabledSkills` (see `src/settings.ts`).
    pub slug: String,
    /// Human-readable label. Frontmatter `name:` wins; else the file's
    /// first H1; else the slug.
    pub name: String,
    /// One-line "when to use" hint. Frontmatter `description:` wins;
    /// else the first content paragraph (skipping H1 / blockquotes /
    /// other headings); else the slug.
    pub description: String,
    /// File size in bytes, used to gate engagement against the
    /// per-skill cap and the per-session budget on the frontend.
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBody {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub size_bytes: u64,
}

/// List every skill under `<cwd>/prism/skills/*.md`. Skips `README.md`
/// (documentation, not a skill) and any file whose frontmatter or
/// content is unreadable; never errors the whole call on a single bad
/// file so the manifest is always at least as complete as it can be.
#[tauri::command]
pub fn list_skills(cwd: String) -> Result<Vec<SkillSummary>, String> {
    let dir = skills_dir(&cwd)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut out: Vec<SkillSummary> = Vec::new();
    // We use a simple recursive walk.
    fn walk_dir(root: &Path, current: &Path, out: &mut Vec<SkillSummary>) {
        let Ok(entries) = fs::read_dir(current) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_dir(root, &path, out);
            } else if is_skill_file(&path) {
                if let Ok(metadata) = fs::metadata(&path) {
                    if let Ok(content) = fs::read_to_string(&path) {
                        // Slug is the path relative to root, minus .md
                        let slug = path.strip_prefix(root)
                            .unwrap_or(&path)
                            .with_extension("")
                            .to_string_lossy()
                            .into_owned();
                        
                        let (frontmatter, body) = parse_frontmatter(&content);
                        let name = frontmatter
                            .iter()
                            .find(|(k, _)| k == "name")
                            .map(|(_, v)| v.clone())
                            .unwrap_or_else(|| derive_name(body, &slug));
                        let description = frontmatter
                            .iter()
                            .find(|(k, _)| k == "description")
                            .map(|(_, v)| v.clone())
                            .unwrap_or_else(|| derive_description(body).unwrap_or_else(|| slug.clone()));
                        
                        out.push(SkillSummary {
                            slug,
                            name,
                            description,
                            size_bytes: metadata.len(),
                        });
                    }
                }
            }
        }
    }

    walk_dir(&dir, &dir, &mut out);
    
    // Stable alphabetical order.
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

/// List all subdirectories under `<cwd>/prism/skills/`.
#[tauri::command]
pub fn list_skill_folders(cwd: String) -> Result<Vec<String>, String> {
    let dir = skills_dir(&cwd)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut folders = HashSet::new();
    
    fn walk_folders(root: &Path, current: &Path, folders: &mut HashSet<String>) {
        let Ok(entries) = fs::read_dir(current) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Ok(rel) = path.strip_prefix(root) {
                    let rel_str = rel.to_string_lossy().into_owned();
                    if !rel_str.is_empty() {
                        folders.insert(rel_str.clone());
                    }
                }
                walk_folders(root, &path, folders);
            }
        }
    }

    walk_folders(&dir, &dir, &mut folders);
    let mut out: Vec<String> = folders.into_iter().collect();
    out.sort();
    Ok(out)
}

/// Read one skill's full body. Errors if missing, oversized, or not a
/// regular file. Used by both engagement tracks; the size cap here is
/// the floor — the frontend may apply additional session-budget checks
/// before deciding to engage.
#[tauri::command]
pub fn read_skill(cwd: String, slug: String) -> Result<SkillBody, String> {
    let dir = skills_dir(&cwd)?;
    let path = dir.join(format!("{}.md", slug));
    let metadata = fs::metadata(&path)
        .map_err(|e| format!("skill `{}` not found: {}", slug, e))?;
    if !metadata.is_file() {
        return Err(format!("skill `{}` is not a regular file", slug));
    }
    let size = metadata.len();
    if size as usize > SKILL_HARD_CAP_BYTES {
        return Err(format!(
            "skill `{}` is {} bytes, over the {} byte per-skill cap; split it into a family",
            slug, size, SKILL_HARD_CAP_BYTES
        ));
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("cannot read skill `{}`: {}", slug, e))?;
    let (frontmatter, body) = parse_frontmatter(&content);
    let name = frontmatter
        .iter()
        .find(|(k, _)| k == "name")
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| derive_name(body, &slug));
    let description = frontmatter
        .iter()
        .find(|(k, _)| k == "description")
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| derive_description(body).unwrap_or_else(|| slug.clone()));
    Ok(SkillBody {
        slug,
        name,
        description,
        body: body.to_string(),
        size_bytes: size,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn skills_dir(cwd: &str) -> Result<PathBuf, String> {
    if cwd.is_empty() {
        return Err("cwd unknown".into());
    }
    Ok(PathBuf::from(cwd).join("prism").join("skills"))
}

/// True if `path` is a `.md` file we should treat as a skill. Skips
/// `README.md` (any case) since that's documentation, not a skill.
fn is_skill_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if !name.to_ascii_lowercase().ends_with(".md") {
        return false;
    }
    if name.eq_ignore_ascii_case("README.md") {
        return false;
    }
    true
}

fn file_slug(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// Hand-rolled YAML-frontmatter parser. The format is dirt-simple
/// (key: value pairs, only the keys we actually use), so a real YAML
/// library would be dead weight. Returns `(pairs, body_after_frontmatter)`;
/// if no frontmatter is detected, returns `(empty, content)` unchanged.
///
/// We return `Vec<(String, String)>` rather than a `HashMap` so the
/// declaration order is preserved — useful if we ever want to stable-
/// hash the parsed result.
fn parse_frontmatter(content: &str) -> (Vec<(String, String)>, &str) {
    // Frontmatter must be the very first thing in the file.
    let stripped = content.strip_prefix("---\n").or_else(|| content.strip_prefix("---\r\n"));
    let Some(after_open) = stripped else {
        return (Vec::new(), content);
    };

    // Find the closing fence. Accept `\n---\n`, `\n---\r\n`, or `\n---` at EOF.
    let close_idx = find_closing_fence(after_open);
    let Some((fence_start, fence_len)) = close_idx else {
        // Open fence with no close — treat as if no frontmatter, to be
        // forgiving about half-edited files.
        return (Vec::new(), content);
    };

    let frontmatter_block = &after_open[..fence_start];
    let body_start = fence_start + fence_len;
    // Trim a single leading newline so the body doesn't start with a blank line.
    let body = after_open[body_start..]
        .strip_prefix('\n')
        .or_else(|| after_open[body_start..].strip_prefix("\r\n"))
        .unwrap_or(&after_open[body_start..]);

    let mut pairs: Vec<(String, String)> = Vec::new();
    for line in frontmatter_block.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
        let key = line[..colon].trim().to_ascii_lowercase();
        let raw_value = line[colon + 1..].trim();
        // Strip matching quotes if present.
        let value = strip_quotes(raw_value);
        if !key.is_empty() && !value.is_empty() {
            pairs.push((key, value.to_string()));
        }
    }
    (pairs, body)
}

/// Find a `---` line that closes the frontmatter. Returns
/// `(offset_into_str, fence_byte_length)` so the caller can split.
fn find_closing_fence(s: &str) -> Option<(usize, usize)> {
    // Scan line-by-line, tracking byte offsets so the slice math is exact.
    let mut offset = 0usize;
    for line in s.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed == "---" {
            return Some((offset, line.len()));
        }
        offset += line.len();
    }
    None
}

fn strip_quotes(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &s[1..s.len() - 1];
        }
    }
    s
}

/// Pull a name out of the body's first H1 (`# Heading`). Falls back to
/// the slug if the body has no H1 in the first few non-empty lines.
fn derive_name(body: &str, slug: &str) -> String {
    for (i, line) in body.lines().enumerate() {
        if i > 8 {
            break; // H1 must be near the top to count.
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            return rest.trim().to_string();
        }
        if trimmed.starts_with('#') {
            continue; // h2/h3/etc — keep scanning.
        }
        // First content line wasn't an H1; don't keep guessing.
        break;
    }
    slug.to_string()
}

/// Pull a one-line description from the first content paragraph.
/// Skips the H1 (already used for name), blockquotes (often footnote-
/// style asides), and any other heading. Concatenates contiguous lines
/// of the first real paragraph, strips the most common inline markdown
/// (`**`, `__`, backticks, `[link](url)` → `link`), trims to one
/// sentence or `DESCRIPTION_MAX_CHARS`.
fn derive_description(body: &str) -> Option<String> {
    let mut acc = String::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !acc.is_empty() {
                break; // Paragraph boundary — we have what we need.
            }
            continue;
        }
        // Skip headings entirely (H1 = name; deeper headings = section labels).
        if trimmed.starts_with('#') {
            continue;
        }
        // Skip blockquotes.
        if trimmed.starts_with('>') {
            continue;
        }
        // Skip horizontal rules.
        if trimmed == "---" || trimmed == "***" {
            continue;
        }
        if !acc.is_empty() {
            acc.push(' ');
        }
        acc.push_str(trimmed);
        if acc.len() >= DESCRIPTION_MAX_CHARS * 2 {
            break;
        }
    }
    if acc.is_empty() {
        return None;
    }

    let cleaned = strip_inline_markdown(&acc);
    Some(truncate_at_sentence(&cleaned, DESCRIPTION_MAX_CHARS))
}

/// Cheap inline-markdown stripper. Not a full parser; just pulls the
/// most common decorations so a description reads cleanly:
///   `**bold**` / `__bold__` → `bold`
///   `*em*` / `_em_`         → `em`
///   `` `code` ``            → `code`
///   `[text](url)`           → `text`
fn strip_inline_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Bold/em with `**` or `__`: just drop the marker pair.
        if i + 1 < bytes.len()
            && (bytes[i] == b'*' && bytes[i + 1] == b'*'
                || bytes[i] == b'_' && bytes[i + 1] == b'_')
        {
            i += 2;
            continue;
        }
        // Single `*` or `_` em — drop.
        if bytes[i] == b'*' || bytes[i] == b'_' {
            i += 1;
            continue;
        }
        // Backtick code — drop the backtick, keep contents as-is.
        if bytes[i] == b'`' {
            i += 1;
            continue;
        }
        // `[text](url)` → `text`.
        if bytes[i] == b'[' {
            if let Some(close_text) = s[i + 1..].find(']') {
                let text_end = i + 1 + close_text;
                if text_end + 1 < bytes.len() && bytes[text_end + 1] == b'(' {
                    if let Some(close_url) = s[text_end + 2..].find(')') {
                        out.push_str(&s[i + 1..text_end]);
                        i = text_end + 2 + close_url + 1;
                        continue;
                    }
                }
            }
        }
        // Default: copy byte through. We index into the original UTF-8
        // string by byte boundaries we control (markers above are all
        // single-byte ASCII), so direct push_str of a 1-byte slice is
        // safe — but we use char-aware advance just in case.
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Truncate to the first sentence terminator (`.`, `!`, `?`) within
/// `max_chars`. If no terminator falls in range, hard-truncate at the
/// nearest char boundary and append a `…`.
fn truncate_at_sentence(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    // Walk char-by-char so we never split a multibyte sequence.
    let mut count = 0usize;
    let mut last_terminator: Option<usize> = None;
    let mut byte_idx = 0usize;
    for ch in s.chars() {
        byte_idx += ch.len_utf8();
        count += 1;
        if matches!(ch, '.' | '!' | '?') {
            last_terminator = Some(byte_idx);
        }
        if count >= max_chars {
            break;
        }
    }
    if let Some(end) = last_terminator {
        return s[..end].to_string();
    }
    let mut out = s[..byte_idx].to_string();
    out.push('\u{2026}'); // ellipsis
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_skills_root() -> PathBuf {
        // One-shot tmp dir per test, cleaned by the OS eventually.
        let mut p = env::temp_dir();
        p.push(format!(
            "prism-skills-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_skill(root: &Path, slug: &str, body: &str) {
        let dir = root.join("prism").join("skills");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{}.md", slug)), body).unwrap();
    }

    #[test]
    fn list_skills_returns_empty_when_dir_missing() {
        let root = fresh_skills_root();
        let out = list_skills(root.to_string_lossy().to_string()).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn list_skills_skips_readme_and_non_md() {
        let root = fresh_skills_root();
        write_skill(&root, "actual-skill", "# Actual\nSomething useful.");
        let dir = root.join("prism").join("skills");
        fs::write(dir.join("README.md"), "# Don't surface me").unwrap();
        fs::write(dir.join("notes.txt"), "not a skill").unwrap();

        let out = list_skills(root.to_string_lossy().to_string()).unwrap();
        let slugs: Vec<&str> = out.iter().map(|s| s.slug.as_str()).collect();
        assert_eq!(slugs, vec!["actual-skill"]);
    }

    #[test]
    fn frontmatter_wins_over_derivation() {
        let root = fresh_skills_root();
        write_skill(
            &root,
            "with-frontmatter",
            "---\nname: Custom Name\ndescription: Use when frobnicating widgets.\n---\n# Different H1\nSome other lead-in paragraph.",
        );
        let out = list_skills(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Custom Name");
        assert_eq!(out[0].description, "Use when frobnicating widgets.");
    }

    #[test]
    fn derives_name_from_h1_and_description_from_first_paragraph() {
        let root = fresh_skills_root();
        write_skill(
            &root,
            "no-frontmatter",
            "# React debugging\n\nWhen inspecting a React issue, start with the component tree before the source.",
        );
        let out = list_skills(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(out[0].name, "React debugging");
        assert_eq!(
            out[0].description,
            "When inspecting a React issue, start with the component tree before the source."
        );
    }

    #[test]
    fn derives_description_when_no_h1() {
        // Mirrors xterm.wordwarp.md style — no H1, just prose at top.
        let root = fresh_skills_root();
        write_skill(
            &root,
            "no-h1",
            "Yes — there is a **standard fix**, and it usually is not what you think.",
        );
        let out = list_skills(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(out[0].name, "no-h1"); // Falls back to slug.
        assert_eq!(
            out[0].description,
            "Yes — there is a standard fix, and it usually is not what you think."
        );
    }

    #[test]
    fn read_skill_returns_body_without_frontmatter() {
        let root = fresh_skills_root();
        write_skill(
            &root,
            "x",
            "---\nname: X\ndescription: Used in tests.\n---\nThe body.",
        );
        let r = read_skill(
            root.to_string_lossy().to_string(),
            "x".to_string(),
        )
        .unwrap();
        assert_eq!(r.name, "X");
        assert_eq!(r.description, "Used in tests.");
        assert_eq!(r.body, "The body.");
    }

    #[test]
    fn read_skill_rejects_oversized_files() {
        let root = fresh_skills_root();
        let huge = "a".repeat(SKILL_HARD_CAP_BYTES + 1);
        write_skill(&root, "huge", &huge);
        let err = read_skill(root.to_string_lossy().to_string(), "huge".to_string())
            .unwrap_err();
        assert!(err.contains("over the"));
        assert!(err.contains("per-skill cap"));
    }

    #[test]
    fn read_skill_errors_on_unknown_slug() {
        let root = fresh_skills_root();
        let err = read_skill(
            root.to_string_lossy().to_string(),
            "does-not-exist".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn description_truncates_at_sentence_when_long() {
        let mut long = String::new();
        for _ in 0..10 {
            long.push_str("This is a sentence. ");
        }
        let root = fresh_skills_root();
        write_skill(&root, "long", &format!("# Long\n{}", long));
        let out = list_skills(root.to_string_lossy().to_string()).unwrap();
        // Should land on a `.` boundary, not in the middle of a word.
        assert!(out[0].description.ends_with('.'));
        assert!(out[0].description.chars().count() <= DESCRIPTION_MAX_CHARS);
    }

    #[test]
    fn list_skills_is_alphabetical() {
        let root = fresh_skills_root();
        write_skill(&root, "zebra", "# Z\nz");
        write_skill(&root, "alpha", "# A\na");
        write_skill(&root, "mike", "# M\nm");
        let out = list_skills(root.to_string_lossy().to_string()).unwrap();
        let slugs: Vec<&str> = out.iter().map(|s| s.slug.as_str()).collect();
        assert_eq!(slugs, vec!["alpha", "mike", "zebra"]);
    }
}
