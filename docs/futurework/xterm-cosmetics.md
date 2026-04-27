Antigravity collapses the same activity into:
•  "Worked for 28s ▼" — one-line collapsible session header
•  "Explored 2 commands ▼" — grouped tool runs
•  "Thought for 8s ›" — chain-of-thought panel
•  Tool calls rendered as cards (header bar, content, exit code, "Always run") not stream-of-text
•  Final prose rendered as rich markdown, isolated from the tool log

Concrete cosmetic deltas to close (in priority order):

1. Phase grouping. Wrap each agent turn into a single "Worked for Ns ▾" collapsible block; everything between user prompt and final answer collapses by default. Tool log only opens on click.
2. Card-style tool rendering. → tool_name({...json...}) is too noisy. Replace with a one-line summary card: tool name, human-readable args (web_search "AI code verification 2026"), result-size pill, exit/ok glyph.
3. Suppress shell prompt leakage. Lines like stevenmorales@Stevens-Mac-mini-2 StellarumAtlas % are drifting into the agent stream. Should never appear inside an agent turn.
4. Markdown render in xterm output. Final answer is plaintext-with-asterisks; should render headings, bullets, and inline code chips like Antigravity does (we already render audit findings with ANSI; same machinery should run on agent prose).
5. "Files Modified" footer. Antigravity's bottom-of-turn artifact list is a great pattern for /build and /fix turns — surface a tiny Files Modified ⓘ chip with the changed paths.

Items 1–3 are the highest-leverage and don't touch agent semantics — pure xterm presentation. Worth queuing as the next bite-sized polish pass.

---

## Resizable layout (must-do, not optional)

The current shell is fixed-grid: `.blocks-sidebar` width and the file-preview height are hard-coded in CSS. This is fine as a v0 but breaks down the moment a real workspace shows up — long file paths in the tree get clipped, audit findings push the file preview below the fold, etc.

What we need:

1. **Sidebar width drag-handle.** A 4–6px hit zone on the right edge of `.blocks-sidebar`. Drag persists per-workspace into `<cwd>/.prism/state.json` (under a new `layout` key) so reopening the project restores the user's width. Min ~180px, max ~50% of viewport.
2. **File-preview horizontal divider.** When the preview overlay is open, give it a draggable top edge so the user can give it more room without dismissing it. Same persistence story.
3. **Problems-panel width.** Already a sibling pane on the right; same treatment.
4. **Snap points.** Double-click on a divider snaps to a sensible default (sidebar 240px, preview 50% height). Cheap, high signal.
5. **Keyboard parity.** `Cmd+Opt+[` / `Cmd+Opt+]` nudge the focused divider in 16px steps so resize is reachable without a mouse.

Implementation note: do this in vanilla JS pointer-event handlers on the dividers, not a library. We already have a workspace-scoped `ResizeObserver` driving `fitTerminalWithGutter()` — the new dividers just write `--sidebar-width` / `--preview-height` CSS custom properties on the workspace root, and the existing observer picks up the size change. Persistence piggybacks on the workspace-state plumbing landing in the "persisted workspace state" ticket, so no new IPC.

---

## Rounded code-block cards (deferred — needs HTML overlay)

In modern AI-tool UIs (Cursor, Claude desktop, Antigravity), assistant
prose has two stylistic moves we don't yet match in xterm:

1. **Inline code** (file paths, identifiers, ` `foo.ts` `) is rendered in
   a contrasting color, monospace inside otherwise-proportional prose.
2. **Fenced code blocks** are wrapped in rounded containers with a soft
   tinted background.

**#1 — Inline code coloring** is feasible inside xterm via ANSI
escape codes. Implemented in `agent.ts`'s `onToken` streaming layer
with a small backtick state-machine (handles tokens that split across
chunks, distinguishes single from triple backticks). Cyan-on-default
gives the right visual weight without competing with the prose color.

**#2 — Rounded containers** are NOT feasible in pure xterm. xterm
renders character cells; it cannot draw rounded rectangles or
background tints that span partial cells. Two paths exist:

  - **ANSI-only fake**: emit Unicode box-drawing characters (`╭─╮│ │╰─╯`)
    around fenced code. Looks decent in mono terminals but no real
    rounded corners, no background tint, doesn't match modern UIs.

  - **HTML overlay** (proper way): when a fenced code block streams in,
    intercept the tokens, suppress them from xterm, and render a
    `<div class="code-card">` overlay above the terminal with real CSS
    `border-radius` + bg tint. This is what HTML-based AI tools
    (Cursor, Claude desktop) do because they're not terminal-based.
    For Prism it is a **bigger architectural shift** — code blocks
    become DOM nodes outside xterm's text grid, which means:
      - layout has to flow around them (the terminal grid stops
        being the only renderer)
      - selection, copy/paste, search inside the card need their own
        DOM-level handlers
      - vertical scroll has to be coordinated across xterm + cards

**Recommended deferral**: pick this up alongside **Phase 2 of the IDE
shell** (the tabbed CodeMirror editor pane). At that point the
renderer for assistant prose moves from xterm to a CodeMirror-based
component anyway, and rounded code-block cards come essentially free
from the existing CodeMirror styling. Doing it earlier would mean
building a one-off card renderer that we'd throw away at IDE Phase 2.

Until then, Prism users see fenced code blocks as raw monospace text
inside xterm, which is fine for terminal-native workflows but doesn't
match the modern AI-tool feel for prose-heavy assistant responses.

Short answer: after the test campaign + first beta cohort, before public launch.

Why not now
•  Daily-driver UX still has rough edges (chat readability, save/load, modal flow). Stabilize the terminal-native experience first.
•  Phase 2 is ~3–6 weeks of work. Adds layout coordination (xterm + DOM editor), file open/save flow, dirty-buffer tracking, undo/redo, syntax highlighting, save-via-approval. None of that helps you finish the eval campaign.
•  The wedge is verification, not editing. Every week you ship Phase 2 instead of audit polish is a week competitors aren't worried about you.

Why not later than launch
•  Once Prism brands as "the verification layer," users will ask "can I edit here?" within minutes of trying it. Without an editor pane the tool feels half-finished for a serious workflow.
•  Code-block rendering polish (the deferred #2) compounds well with Phase 2; doing it before is wasted work.

The trigger
•  Test campaign across 4–6 LLMs is complete and you've shipped fixes from those findings.
•  5+ external beta testers have used Prism daily for ≥1 week and the chat/audit/load surface is genuinely smooth.
•  Then start Phase 2 — and ship code-block cards with it.

Concretely: probably 2–4 weeks from now, not tonight, not next month.
