## Save and Load Chats

Here's how it works and why the random .md was rejected:

Save format

.md (markdown) — but with Prism-specific structure. Anatomy from src-tauri/src/save_chat.rs:

---
title: "<your tab title>"
model: <openrouter slug>
chat_id: <uuid>
created: 2026-04-26T18:30:00Z
messages: <count>
---

# <your tab title>

## User

<first user message>

---

## Assistant

<first assistant response>

---

## User

<...>

YAML frontmatter at top, then alternating ## User / ## Assistant sections separated by --- rules.

Save folder + filename

•  Default folder: <project>/.prism/chats/ when the tab has a known cwd.
•  Fallback folder: ~/Documents/Prism/Chats/ when no cwd is known yet (for example, a fresh tab before the shell has reported its working directory).
•  Default filename: <slugified-tab-title>-<short-stamp>.md — e.g. tab titled "How many tests" saves as how-many-tests-20260426-1830.md. The user can pick a different name in the dialog.
•  The slug comes from the auto-title (first ~36 chars of your first prompt). If the tab is still "New Tab," the slug is chat.

Current code path

•  Frontend default path logic lives in src/workspace.ts (`saveChat()` / `loadChat()`).
•  Save uses `@tauri-apps/plugin-dialog`'s `saveDialog()` with:
   - `${this.cwd}/.prism/chats/${slug}-${shortStamp()}.md` when cwd is known
   - `~/Documents/Prism/Chats/${slug}-${shortStamp()}.md` as fallback
•  After the user picks a destination, the frontend calls the Tauri command `save_chat_markdown` in src-tauri/src/save_chat.rs.
•  Load uses the same location preference, but directory-only:
   - `${this.cwd}/.prism/chats/`
   - fallback `~/Documents/Prism/Chats/`

Why /load rejected an arbitrary .md

The Rust loader (src-tauri/src/load_chat.rs) parses specifically the Prism chat-export schema. After optional frontmatter it looks for ## User / ## Assistant headings to rebuild messages. If neither heading exists, messages is empty and the loader returns:

> no messages found in <path> — file may not be a Prism chat export



