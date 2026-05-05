# Tab Naming & File Save Misalignment Investigation

**Date**: 2026-04-29  
**Status**: Investigation Complete  
**Severity**: Medium (UX Issue)

---

## Problem Summary

**User Report**: When writing a message and pressing Enter, the tab is initially named "New Tab". After saving the chat file, the filename doesn't match the tab content.

**Root Cause**: The tab title and saved chat filename are derived from different sources that get out of sync:

1. **Tab Title**: Set automatically from the FIRST user input (command or agent prompt)
2. **Filename**: Generated from the tab title at the time `/save` is executed  
3. **Content**: The actual chat messages between then and now

---

## The Tab Naming Flow

### Initial State
```
Tab Title: "New Tab"
autoTitleDone: false
```

### When User Submits Input
**Location**: `workspace.ts`, line 3337-3343 in `setTitleFromText()`:

```typescript
private setTitleFromText(text: string): void {
  if (this.autoTitleDone) return;  // ONLY SETS TITLE ONCE!
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return;
  this.title = trimmed.length > 36 ? trimmed.slice(0, 33) + "…" : trimmed;
  this.autoTitleDone = true;  // LOCKS IT FOREVER
  this.cb.onTitleChange(this.id, this.title);
}
```

**Key Issue**: `autoTitleDone` is set to `true` on the FIRST submission, so the tab title NEVER CHANGES AGAIN, even if the user continues chatting about completely different topics.

### When User Saves Chat
**Location**: `workspace.ts`, line 3766-3810 in `saveChat()`:

```typescript
async saveChat(full: boolean = false): Promise<void> {
  const count = this.agent.getMessageCount();
  if (count === 0) {
    this.notify("[save] nothing to save — no chat messages yet");
    return;
  }
  const slug = slugify(this.title) || "chat";  // <-- Uses CURRENT title
  const ext = full ? "full.md" : "md";
  const defaultPath = this.cwd
    ? `${this.cwd}/.prism/chats/${slug}-${shortStamp()}.${ext}`
    : await expandTilde(
        `~/Documents/Prism/Chats/${slug}-${shortStamp()}.${ext}`,
      );
  // ... saveDialog shows this filename to user
}
```

---

## Example Scenario

### What Happens
1. **User opens tab**: Tab shows "New Tab"
2. **User enters first message**: `"build: my awesome feature"`
   - Tab auto-renames to: `"build: my awesome feature"`
   - `autoTitleDone` is set to `true`
3. **User continues chatting** (20+ messages later):
   - Tab title STILL shows: `"build: my awesome feature"` (unchanged)
4. **User runs `/save`**:
   - Filename becomes: `build-my-awesome-feature-<timestamp>.md`
   - But the file contains the full 20-message history covering multiple topics
   - **Mismatch**: Filename says "build: my awesome feature" but file has diversified chat

### Why This Matters
- Filename doesn't reflect actual conversation content
- User can't tell what a saved chat is about from the filename alone
- Browsing the `.prism/chats/` folder shows misleading labels
- Easy to confuse which saved session is which

---

## Additional Finding: Chat Title Display

**Location**: `workspace.ts`, line 3818 in `exportChat()`:

```typescript
const result = await invoke<{...}>("save_chat_markdown", {
  chatId: this.id,
  path: target,
  model: this.agent.getModel(),
  title: this.title,  // <-- Also locked at first input
  full,
});
```

The saved markdown file also embeds this locked title in its metadata/header, so even the saved file's internal title doesn't reflect what the user has actually been discussing.

---

## Affected Code Files

1. **`tabs.ts`**
   - Line 250: Persists tab title to `session.json`
   - Line 267: Renders tab title in strip

2. **`workspace.ts`** (PRIMARY)
   - Line 172: Initial `title = "New Tab"`
   - Line 316-322: Restore from session
   - Line 854: Reset on `/new` command
   - Line 2337-2343: `setTitleFromText()` - **CORE ISSUE**
   - Line 3766-3810: `saveChat()` - Uses locked title
   - Line 3818: `exportChat()` - Passes locked title to Rust
   - Line 3825-3850: `duplicateSession()` - Uses locked title

3. **Session Persistence** (`session.ts`)
   - Title is persisted with every window unload/tab close
   - Restored on next app launch

---

## Data Flow Diagram

```
User presses Enter with "build: my awesome feature"
         ↓
  detectIntent() → intent.payload = "build: my awesome feature"
         ↓
  handleSubmit() calls setTitleFromText(intent.payload)
         ↓
  this.title = "build: my awesome feature"
  this.autoTitleDone = true  ← LOCKS HERE
         ↓
  cb.onTitleChange() → TabManager updates tab strip
         ↓
  Tab displays: "build: my awesome feature"
         ↓
  [User continues chatting for 20 messages]
         ↓
  Tab still displays: "build: my awesome feature"  (UNCHANGED)
         ↓
  User runs /save
         ↓
  saveChat() reads this.title (still "build: my awesome feature")
         ↓
  slugify() → "build-my-awesome-feature"
         ↓
  Filename: "build-my-awesome-feature-2026-04-29-14-32-15.md"
  Content: 20-message chat covering [multiple topics]
         ↓
  MISMATCH: Filename title ≠ Actual chat content
```

---

## Recommended Solutions

### Option A: Track Latest Topic (Low Risk)
- Extract meaningful keywords from **latest** user message (not first)
- Preserve auto-titling but make it REFRESH periodically or on each input
- **Pro**: More accurate filenames without UI churn
- **Con**: Could feel jarring if tab title changes mid-conversation

### Option B: Hybrid Approach (Recommended)
- Keep current behavior for display: `autoTitleDone` still locks visual tab name
- BUT: At save time, prompt user to **confirm or update** the filename
- Or: Auto-generate filename from latest substantial message instead of first
- **Pro**: No UI disruption, more control, explicit user confirmation
- **Con**: Slightly more friction in save flow

### Option C: Manual Title Edit
- Add a "Rename Tab" UI (context menu on tab, keyboard shortcut)
- Let user explicitly update tab title anytime
- Then filename derives from current (potentially user-edited) title
- **Pro**: Maximum control and clarity
- **Con**: Extra UI surface, requires user action

---

## Recommended Implementation Path

### Phase 1 (Quick Win)
**Modify `saveChat()` to use latest message content for filename generation:**

```typescript
async saveChat(full: boolean = false): Promise<void> {
  const count = this.agent.getMessageCount();
  if (count === 0) {
    this.notify("[save] nothing to save — no chat messages yet");
    return;
  }
  
  // Option A: Use latest message for slug
  const history = await this.agent.getHistory();
  const lastUserMsg = history
    .filter(m => m.role === 'user')
    .pop()?.content || this.title;
  const slug = slugify(lastUserMsg) || slugify(this.title) || "chat";
  
  // ... rest of function
}
```

**Pros**: 
- Single-line fix in one function
- Preserves visual tab title (no UI churn)
- Filenames become more accurate

**Cons**:
- May generate long filenames if last message is verbose
- Needs truncation logic similar to current title truncation

### Phase 2 (Better UX)
**Add rename-tab UI:**
- Right-click context menu on tab: "Rename tab"
- Modal dialog with current title
- User can edit before saving or anytime

### Phase 3 (Full Solution)
**Implement Option C + refresh strategy:**
- Allow manual tab renames (keep across session)
- Optional: Auto-refresh tab title every N messages (user preference)
- Update persisted session data appropriately

---

## Testing Checklist

- [ ] Tab starts as "New Tab"
- [ ] After first message, tab renames to that message (truncated at 36 chars)
- [ ] Tab name does NOT change on subsequent messages
- [ ] Running `/save` uses the first message as filename
- [ ] File content matches what's in the actual chat
- [ ] Close/reopen tab preserves the tab name via `session.json`
- [ ] `/new` command resets tab to "New Tab"
- [ ] Duplicate session copies the title correctly
- [ ] Tab name persists across app restarts

---

## References

- **Entry Point**: `workspace.ts` - `setTitleFromText()` method
- **Save Flow**: `workspace.ts` - `saveChat()` and `exportChat()` methods
- **Persistence**: `tabs.ts` - `flushSessionWrite()` and `render()` methods
- **Session Restore**: `session.ts` - `PersistedTab` interface

---

## Notes for Future Work

1. Consider whether auto-title refresh is actually desired UX or if keeping it locked is intentional
2. The 36-character truncation logic is replicated in multiple places—consider centralizing
3. Audit all uses of `this.title` to understand full impact of any changes
4. Discuss product intent: should tab title reflect "context" or "latest message"?
