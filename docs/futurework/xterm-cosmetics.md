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
