## Status review — xterm cosmetics

### Cosmetic deltas to close

- [ ] **Phase grouping**
  - Wrap each agent turn into a single collapsible `Worked for Ns` block
  - Collapse tool logs by default and reveal on click
  - **Status:** pending
  - **Evidence:** no matching implementation found in `src/agent.ts`, `src/workspace.ts`, or `src/styles.css`

- [-] **Card-style tool rendering**
  - Replace noisy raw tool-call text with compact one-line cards
  - Show tool name, human-readable args, result-size pill, exit/ok glyph
  - **Status:** partial
  - **Evidence:** `src/agent.ts` now renders cleaner one-line tool summaries via `onToolCall()` and `prettyToolArgs()`
  - **Still missing:** true card UI, collapsibility, result-size pill, richer visual chrome

- [ ] **Suppress shell prompt leakage**
  - Prevent shell prompts from appearing inside agent turns
  - **Status:** pending
  - **Evidence:** no explicit prompt-filtering/suppression logic found in `src/agent.ts` or `src/workspace.ts`

- [-] **Markdown render in xterm output**
  - Render headings, bullets, and inline code more like a modern AI UI
  - **Status:** partial
  - **Evidence:** inline code coloring is implemented in `src/inline-code-format.ts` and used by `src/agent.ts`
  - **Still missing:** broader markdown-style rendering for assistant prose in xterm

- [ ] **Files Modified footer**
  - Show a bottom-of-turn `Files Modified` chip/footer for `/build` and `/fix`
  - **Status:** pending
  - **Evidence:** no matching implementation found in current UI code

- () ** Prism made changes to the file xterm-cosmetics.md. but when i asked it to git and push the check status function did not find any changes...
  -  actually maybe they they need to be staged then committed? investigate. 
### Resizable layout

- [x] **Sidebar width drag-handle**
  - **Status:** done
  - **Evidence:** `src/workspace.ts` divider wiring for `sidebar`; `src/styles.css` uses `--sidebar-width`

- [x] **File-preview horizontal divider**
  - **Status:** done
  - **Evidence:** `src/workspace.ts` divider wiring for `preview`; `src/styles.css` uses `--preview-height`

- [x] **Problems-panel width**
  - **Status:** done
  - **Evidence:** `src/workspace.ts` divider wiring for `problems`; `src/styles.css` uses `--problems-width`

- [x] **Snap points**
  - Double-click divider resets to default
  - **Status:** done
  - **Evidence:** `src/workspace.ts` `onDblClick` resets to `DEFAULT_LAYOUT`

- [x] **Keyboard parity**
  - `Cmd+Opt+[` / `Cmd+Opt+]` nudges focused/recent divider in 16px steps
  - **Status:** done
  - **Evidence:** `src/workspace.ts` global + per-divider key handlers; `KEYBOARD_NUDGE_PX = 16`

- [x] **Persistence to `<cwd>/.prism/state.json`**
  - **Status:** done
  - **Evidence:** `persistLayout()` + hydration logic in `src/workspace.ts`; `.prism/state.json` contains `layout`

- [x] **Clamp on apply**
  - Prevent bad saved values from making panes unreachable
  - **Status:** done
  - **Evidence:** `clampLayout`, `clampSidebar`, `clampProblems`, `clampPreview` in `src/workspace.ts`

### Rounded code-block cards

- [x] **Inline code coloring**
  - Backtick-delimited inline code rendered with ANSI styling in xterm
  - **Status:** done
  - **Evidence:** `src/inline-code-format.ts`; integrated in `src/agent.ts`

- [ ] **Rounded fenced code-block cards / HTML overlay**
  - **Status:** pending / deferred
  - **Evidence:** no `code-card` overlay implementation found; `src/inline-code-format.ts` comments explicitly defer fenced-block rendering

