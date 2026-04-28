---
title: "review ● /Users/stevenmorales/Dev…"
model: openai/gpt-5.4
chat_id: d2bd3d80-c5b3-4d3c-a260-190ea99939d7
created: 2026-04-28T14:27:40Z
messages: 2
format: prism-chat-v1
---

# review ● /Users/stevenmorales/Dev…

## User

Current real-world date: 2026-04-28. Treat this as authoritative; it is NEWER than your training cutoff.

Current working directory: /Users/stevenmorales/Development/StellarumPrism

Recent commands (newest last):
  [1] exit=0 $ cd 'Development/StellarumPrism/'

User question: review ●
/Users/stevenmorales/Development/StellarumPrism/docs/fixes/2026.04.28.recent-commits-loose-ends.md

which is a list of loose ends found in the last 18 commits.

---

## Assistant

Reviewed. Most items in the doc are still real, but a few are already fixed or need narrowing.

## Already fixed / no longer a loose end

- **#5 Missing `typecheck` script** — already fixed.
  - `package.json` has:
    ```json
    "typecheck": "tsc --noEmit"
    ```

- **#6 `agent_pane_width` Rust-side schema verification** — already fixed.
  - `src-tauri/src/workspace_state.rs` includes:
    - `pub agent_pane_width: Option<u32>,`
  - `src/workspace.ts` also hydrates and persists it.

## Confirmed real issues

- **#1 Slash-command output still leaks into xterm**
  - Confirmed. `src/workspace.ts` still has many agent-ish `this.term.write(...)` calls.
  - Your acceptance check is slightly stale though: there are also legitimate raw PTY writes:
    - shell startup error
    - PTY output stream
    - shell exit
  - So the stricter real target is:
    - keep only:
      - startup error
      - PTY passthrough (`this.term.write(e.payload)`)
      - shell exit
    - move everything else to `AgentView`

- **#2 “Duplicate Full Session” is half-built**
  - Confirmed.
  - `duplicateSession()` returns `loadChatPath`
  - constructor stores `restore`
  - but `init()` never consumes `restore.loadChatPath`

- **#3 `expandTilde` stub**
  - Confirmed by behavior in `workspace.ts` usage.
  - It’s still being used for duplicate temp paths and save/load defaults.
  - This is a real correctness risk.

- **#4 Temp dup files never cleaned up**
  - Confirmed by design.
  - I don’t see cleanup wired in the loaded path.

- **#7 Tab context menu polish**
  - Likely still real, though I didn’t inspect the menu implementation file directly here.

- **#8 Editor font-size fallback mismatch**
  - Confirmed:
    - `src/editor.ts` → `var(--editor-font-size, 13px)`
    - `src/file-editor.ts` → `var(--editor-font-size, 12px)`
    - `src/settings.ts` default = `12`

- **#9 Pane visibility state not persisted**
  - Confirmed.
  - `previewVisible`, `terminalVisible`, `agentVisible` are runtime booleans.
  - `persistLayout()` only writes widths/heights, not visibility flags.

- **#10 Theme UI commented out, plumbing still exists**
  - Confirmed.
  - `settings.ts` still exposes `theme`, `getTheme`, `setTheme`.

## Needs correction / refinement in the doc

### #1 acceptance check should be updated
Your doc says grep should return only two shell-lifecycle lines. In reality it should allow **three categories**:

- startup error
- PTY passthrough output
- shell exit

Because this line is valid and should remain:
```ts
this.term.write(e.payload);
```

### #6 should be removed from the loose-ends list
It’s already landed.

### #5 should be removed from the loose-ends list
Also already landed.

## One additional nuance worth adding

`renderLoadedTranscript()` still writes the loaded chat transcript into xterm. Depending on your intended architecture, that may or may not be acceptable.

If the rule is truly **“xterm = shell only”**, then this is also architectural debt:
- `[load] ...`
- transcript replay block
- saved-model note

should move to `AgentView`, not xterm.

Right now the doc mentions `/load` generally, but I’d explicitly call out:
- `loadSavedChat()`
- `renderLoadedTranscript()`

as a special case, because they are a large remaining source of non-shell xterm output.

## Recommended edited verdict

I’d trim the list to:

- Keep: **#1, #2, #3, #4, #7, #8, #9, #10**
- Remove as already fixed: **#5, #6**
- Amend #1 acceptance check to allow PTY passthrough

If you want, I can also turn this into an **updated/reconciled version of the markdown file** ready to paste back in.

