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

---

## Plan forward — xterm Phase 1 (dogfooding Prism, Atlas, OnMind)

Goal: convert xterm output from "mostly noise" to "scannable diary" so Prism can be daily-driven against three real projects without leaving the terminal. Pure ANSI/xterm work — no HTML overlay required, no IDE Phase 2 dependency.

### Tier A — ship first, biggest daily payoff

- [ ] **Files Modified footer**
  - End every turn that ran `write_file` / `edit_file` with a grouped footer listing each file + tool used
  - Already half-instrumented: `onToolCall()` sees every tool invocation; track writes in a per-turn list, render in `onDone()`
  - **Estimate:** ~1 hour
  - **Why first:** highest signal-per-keystroke when actually doing work — you immediately see what hit your filesystem

- [ ] **"Worked for Ns" turn footer**
  - Capture `Date.now()` at `query()`, render a dim summary in `onDone()`: `[done in 4.2s · 3 tools · <model>]`
  - **Estimate:** ~30 minutes
  - **Why:** closes the psychological "is it done?" gap on long turns; gives scroll-back anchors

- [ ] **Tool result size pill**
  - Append a dim pill to the tool-summary line: `✓ ok (2,134 lines · 87 KB)` or `✓ ok (12 matches)`
  - Summary string already carries the data; just format it
  - **Estimate:** ~30 minutes
  - **Why:** tells you at a glance whether the agent saw a lot or a little

### Tier B — polish that compounds

- [ ] **Markdown heading + bullet rendering**
  - Stream-aware regex on line starts:
    - `^#{1,3} ` → bold + brand-cyan, dim hash glyph
    - `^- ` / `^\* ` → swap dash for `•` in dim cyan
    - `^\d+\. ` → keep digit, dim the period
  - Reuses the streaming state-machine pattern from `src/inline-code-format.ts`
  - **Estimate:** ~2–3 hours including tests
  - **Why:** assistant prose stops reading like a wall of dim text

- [ ] **Suppress shell prompt leakage during agent turns**
  - When `agent.busy === true`, buffer or dim PTY output matching the prompt pattern (OSC 7 + the `%` / `$` line)
  - Drop on the floor, or replay dimmed after `onDone()`
  - **Estimate:** ~1–2 hours
  - **Why:** currently the most visually jarring thing in long agent sessions

### Tier C — investigate before committing

- [ ] **`git status` ghost-changes bug** (the note from earlier in this file: "Prism made changes … git status didn't find any changes")
  - Likely candidates, in order:
    1. Agent's `run_shell` ran `git` from a cwd that wasn't the repo root (cwd_for_tools resolution suspect)
    2. Agent ran `git status` before its own `write_file` flush completed (race)
    3. Agent edited a file outside the repo via path-resolution mistake
  - **Action:** 15-minute repro the next time it shows up; don't pre-commit a fix

### Deferred (correct deferral — do not do in Phase 1)

- Phase-grouping collapsibles (`Worked for Ns` block that hides tool log on click)
- True card UI for tool calls
- Rounded fenced code-block cards
- "Click a tool to expand its full output" interaction

All four need a DOM overlay sitting on top of xterm with click handlers. Faking the visual in pure ANSI is feasible; faking the click is not. **IDE Phase 2 (tabbed CodeMirror + overlay surface) is the right home for this entire group.** Do not build it twice.

### Recommended sequencing for one focused session

Do Tier A items 1, 2, 3 + Tier B item 5 (suppress shell-prompt leakage) in one sitting (~4 hours, all four independent, all four hit you on every turn). Then Markdown rendering (Tier B item 4) as a follow-up. Investigate Tier C (the git bug) opportunistically. Together, the four-item batch is the inflection point that makes Prism feel like a daily-driver instead of a demo.

