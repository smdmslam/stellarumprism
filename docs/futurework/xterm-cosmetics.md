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

---

## UI surfaces — toolbar + settings page (queued, post Phase 1)

These aren't xterm cosmetics in the strict sense; they're the next layer of UI chrome ON TOP of the terminal stage. Tracked here because this file is the de-facto UI backlog and we want a single place to look. Should ship after the Phase 1 dogfooding window so we have signal on what's worth surfacing first.

### Thin toolbar

- [ ] **Slim chrome strip below the titlebar / tab strip**
  - Single-row, low-visual-weight band hosting global affordances
  - First inhabitants:
    - Settings entry (gear glyph) — opens the settings pane
    - Model picker (move it here from the input meta row, or mirror it; deciding is part of the design pass)
    - Verifier on/off toggle (currently buried in slash commands)
    - Optional: a global busy/cancel indicator that stays visible even when the input bar scrolls off-screen
  - **Why:** centralizes "global state" controls so the input bar stops carrying turn-scoped + global concerns at once
  - **Why now:** unblocks the settings page (which needs an entry point) and gives model curation a visible home

### Settings page

- [ ] **Pane or modal (shape TBD) replacing today's `config.toml`-only configuration**
  - Currently every knob lives in `~/.config/prism/config.toml`. Fine for early users; a non-starter for shipping to anyone who hasn't read the README
  - **Phase 1 surface area** (in priority order):
    1. **Models — show/hide curation** (the driver, see next section)
    2. API key entry + provider toggles (OpenRouter today; future: direct provider keys)
    3. Default model
    4. Verifier (enabled / model)
    5. Approval defaults (per-tool: always-prompt vs session-allow)
    6. Substrate command overrides (typecheck / run_tests / lsp / schema commands and timeouts)
  - All of this already exists as config; the work is purely adding a UI that reads + writes the same TOML
  - **Round-trip principle:** the settings UI MUST read and write `config.toml` directly, not a parallel store. Power users editing the file by hand and casual users clicking toggles must see the same source of truth, or we re-introduce the same divergence problem CRDTs were invented to solve

### Models show/hide curation (the driving requirement)

- [ ] **Per-model visibility flag, exposed in settings**
  - **Strategic context:** every model in the registry gets tested against real workflows (Prism, Atlas, OnMind). Some give subpar performance — wrong tool-use patterns, hallucinated paths, format drift, runaway loops, silent empty responses. Shipping a smaller, curated, *known-good* set is strictly better than dumping every supported model into the picker and trusting the user to discover which ones work
  - **Behavior:**
    - Each `ModelEntry` in `src/models.ts` gains an `enabled: boolean` (default true)
    - The auto-router (`src/router.ts`) only considers enabled models for its presets
    - `/model <slug>` allows enabled-only by default; a `--include-disabled` escape hatch keeps power users unblocked
    - The model picker UI hides disabled rows by default; a "Show all" expander reveals them with a dim caveat ("tested subpar — use at your own risk")
  - **Storage:**
    - Default visibility ships with the registry (`enabled: false` on the ones we've identified as subpar)
    - User overrides live in `config.toml` under `[models.visibility]` so a user can re-enable a hidden model OR disable a default-enabled one
    - Settings UI writes overrides; the registry default is never mutated at runtime
  - **Why this matters as product:** quality floor is the wedge. "Everything works" beats "every option available" when the user is shipping real code. Curation is the operational expression of the same thesis as substrate-gated edits and Grounded-Chat rigor enforcement — we filter known failures before the user has to encounter them
  - **Why this isn't censorship:** the escape hatch is one toggle away. We're not preventing access; we're picking sane defaults the way `git` picks `merge` over `rebase` for the first-time user

### Sequencing

1. Toolbar shell first (visual + entry-point only — no inhabitants beyond the gear glyph)
2. Settings pane scaffolding (route from gear, render placeholder sections)
3. Models show/hide (the actual payoff)
4. Backfill the remaining settings sections opportunistically as each becomes painful to live without

Doing them in this order means each step ships something visible AND each step works even if we stop after it.

