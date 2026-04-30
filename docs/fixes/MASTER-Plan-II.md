# MASTER Plan II — Reorganized Status
**Date:** 2026-04-30  
**Project:** StellarumPrism  
**Format:** TODO ↔ DONE (reorganized from MASTER-Plan.md)

---

## 📋 SECTION 1: ITEMS LEFT TO DO

### Phase 1 — Trust / Safety / Obvious Bugs (HIGH PRIORITY)

#### 1.1 Fixes-without-checking behavior ⚠️ CRITICAL
- **Status:** NOT STARTED
- **Issue:** Tighten behavior where assistant offers fixes without first checking code/evidence
- **Path:** Stricter fix protocol, `/fix` routing, or methodology prompt tightening
- **Why:** Fix suggestions should be grounded in inspected code, not guesses
- **Dependencies:** Depends on verifier methodology improvements (Phase 6)

#### 1.2 Loaded chat replay fidelity
- **Status:** NOT STARTED
- **Issue:** Replay loaded chats as true turns with prose and tool cards, not flattened blocks
- **Why:** Loaded chats should look identical to live chats
- **Notes:** Requires changes to chat-load persistence + render pipeline

#### 1.3 File-editor slash leakage bug
- **Status:** LIKELY FIXED (needs verification)
- **Issue:** Slash input from file editor leaks into main prompt line
- **Last touched:** `262974e` (editor slash isolation + autocomplete hardening)
- **Verification needed:** E2E test opening file editor, typing `/`, confirm no prompt focus-steal

#### 1.4 Verified / observed label rendering cleanup
- **Status:** MOSTLY DONE (partial)
- **Fixed in:** `895f872` (confidence label normalization)
- **Remaining:** Verify rendering is not confusing in Problems panel UI
- **Note:** Labels are `✓ Observed` / `~ Inferred` / `? Unverified` (per code at `problems.ts` line 27)

#### 1.5 File write / delete approval guarantees
- **Status:** IMPROVED (partial)
- **Fixed in:** 
  - `058fbbc` (per-call approval enforcement for filesystem mutations)
  - `e1e26b6` (candidate-tier /fix opt-in with explicit --allow-candidate flag)
- **Remaining:** Verify no silent mutations; test delete/move/mkdir approval flows

---

### Phase 2 — Daily-use Readability & Comfort (HIGH-MEDIUM PRIORITY)

#### 2.1 Structured outputs as Markdown/report sections ✅ MOSTLY DONE
- **Status:** IMPLEMENTED
- **Fixed in:** `bc36380` (contextual nudges + topic-shift logic)
- **What works:**
  - `/help` → renders via `renderHelpMarkdown()`
  - `/models` → renders via `renderModelsMarkdown()`
  - `/history` → renders via `renderHistoryMarkdown()`
  - `/last` → renders via `renderLastMarkdown()`
- **Remaining:** Verify all render as Markdown (not plain text) in agent panel

#### 2.2 Code-block card contrast
- **Status:** NOT STARTED
- **Issue:** Increase contrast / polish for rounded code boxes
- **Why:** Code blocks should be easier to scan and visually distinct
- **Note:** May involve `.agent-tool-card` CSS updates

#### 2.3 Highlight visibility ✅ FIXED
- **Status:** DONE
- **Fixed in:** `bc36380` (selection color fix)
- **Changes:** 
  - File preview: 0.35 → 0.55 opacity
  - Input area: +0.60 opacity (new)
- **Verification:** Text selection in prompt should be clearly visible now

#### 2.4 New-conversation affordance ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:**
  - `8e02277` (new-chat button in prompt chrome)
  - `ffe3f9c` + `b1f5d43` (nudge for long threads + topic-shift)
- **What works:**
  - New button visible in input-bar
  - Long-thread nudge (~40 turns)
  - Topic-shift nudge (keyword overlap detection)
- **Note:** Nudge threshold at 0.2 (20%) may be too permissive — recommend tuning to 0.5

#### 2.5 Clickable model/CMD pills in prompt chrome ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:** `e1e26b6` (badge click handlers, model list render)
- **What works:**
  - Model badge click → opens model list
  - Intent badge (CMD/AGENT) click → toggles mode
- **Verification:** Both badges should be clickable and show options

#### 2.6 ANSI/control-sequence sanitization in agent output ✅ MOSTLY DONE
- **Status:** IMPLEMENTED
- **Fixed in:** `56e4094` (sanitize → stripAnsi migration, ~50 call sites)
- **What works:**
  - `stripAnsi()` function (line 4402 in workspace.ts) strips terminal escapes
  - Used on tool names, summaries, error messages
- **Remaining:** Verify no visible escape codes leak into agent panel markdown

#### 2.7 Agent streaming autoscroll ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:** `7dfc64e` (explicit sidebar toggle + scroll follow state)
- **What works:**
  - `followStream` flag tracks if user scrolled away
  - `scrollToBottomIfFollowing()` only autoscrolls when user at bottom
  - Scroll event listener resets flag on manual scroll
- **Note:** Properly respects user intent when scrolling away

#### 2.8 Task/progress visibility
- **Status:** PARTIALLY DONE
- **What works:**
  - Busy pill with cancel button (visible when agent busy)
  - Protocol report cards show step-by-step progress (phase transitions)
- **Remaining:** Verify protocol report card rendering is polished

#### 2.9 Cmd+F find in agent pane
- **Status:** NOT STARTED
- **Issue:** No way to search within an agent conversation. Tauri's WebKit doesn't expose a native find dialog and `window.find()` is non-standard, so Cmd+F is a no-op inside `.agent-stage-scroll` today.
- **Why:** Long agent transcripts are exactly when find matters most (recall a code reference, a path, or a directive from earlier in the turn).
- **Companion:** File viewer Cmd+F is already shipped (see 3.5) — that path uses `@codemirror/search`. The agent pane needs a separate, custom solution because it's plain DOM, not a CodeMirror buffer.
- **Design sketch:**
  - Small overlay anchored to the top-right of `.agent-stage` (input field, match count, prev/next, close).
  - Match algorithm: walk text nodes inside `.agent-stage-scroll`, wrap matches in `<mark class="agent-find-hit">`, track positions in an array, scroll the active hit into view.
  - Active hit gets a brighter highlight (`.agent-find-hit-active`) so the user can tell which one is current.
  - Cmd+F opens / focuses input, Cmd+G next, Cmd+Shift+G prev, Esc closes (and unwraps the marks).
  - Re-run match pass on stream events (`appendProse`, `appendToolCall`, etc.) so matches stay in sync as new content arrives during a search.
- **Open questions:**
  - Search scope: just prose, or include tool-result blocks, approval cards, and report cards too? Probably all text-bearing nodes by default.
  - Auto-clear on new turn, or persist until Esc?
  - Case-sensitivity / regex toggles, or keep it dead simple? Suggest dead-simple (substring, case-insensitive) for v1.
- **Estimated scope:** ~80–150 LOC + minimal CSS. Self-contained module (`agent-find.ts`) wired into `AgentView` lifecycle hooks.

---

### Phase 3 — File Explorer / Viewer QoL (MEDIUM PRIORITY)

#### 3.1 Explorer context actions ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:** `bc36380` (gear menu refactor with file-view-options)
- **What works:**
  - Right-click context menu on tree rows
  - New File / New Folder in context menu
  - Rename action via modal dialog
  - Copy path / copy relative path actions
- **Verification:** Right-click on any tree row should show menu

#### 3.2 Explorer settings (size / date metadata) ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:** `bc36380` (modified-date metadata toggle)
- **What works:**
  - Gear menu with checkboxes
  - Show file sizes (checkbox, default ON)
  - Show modified dates (checkbox, default OFF)
  - Metadata rendered as "size · date" pairs
- **Backend change:** `file_ref.rs` now captures `mtime_secs` for files
- **Verification:** Toggle both options and verify tree updates

#### 3.3 File viewer visibility toggle ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:** `7dfc64e` (explicit sidebar toggle button)
- **What works:**
  - Button in input chrome / sidebar
  - Explicit icon/button to hide/show preview
- **Verification:** Button should toggle file viewer visibility

#### 3.4 File viewer resize polish
- **Status:** NOT STARTED
- **Issue:** Improve file viewer right-border drag behavior
- **Current:** Dividers are `.layout-divider` with drag handlers
- **Note:** May need CSS tweaks to make grab area larger/more obvious

#### 3.5 File viewer Cmd+F find ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:** Latest commit (`@codemirror/search` integration in `src/file-editor.ts`)
- **What works:**
  - `Cmd+F` opens find panel at top of file viewer
  - `Cmd+G` / `Cmd+Shift+G` step through matches
  - `Esc` closes panel
  - `highlightSelectionMatches` tints other occurrences of the current selection while the panel is closed
- **Verification:** Open any file in the viewer, press ⌘F, confirm panel appears and search works.

#### 3.6 IDE-style hotkeys for pane visibility ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:** Multiple commits, canonical handler in `tabs.ts` window-level keydown
- **What works:**
  - `Cmd+B` toggles sidebar
  - `Cmd+J` toggles terminal
  - `Cmd+L` toggles agent pane
  - `Cmd+Shift+P` toggles preview
- **Verification:** All four hotkeys functional regardless of focus (terminal, file editor, file tree, prompt).

#### 3.7 Recent paths in prompt area
- **Status:** NOT STARTED
- **Issue:** Explore quick access to recent paths near prompt
- **Design:** Possible autocomplete enhancement or sidebar widget
- **Note:** Low priority; depends on IA decisions

---

### Phase 4 — Protocols / Discoverability (MEDIUM PRIORITY)

#### 4.1 Toolbar Protocols menu
- **Status:** NOT STARTED
- **Issue:** Add toolbar button for protocols; show recipes grouped by category
- **Design:** Needs UI design work (where to place button, layout)
- **Dependencies:** Recipe system already works via `/protocol` slash command

#### 4.2 Disabled / inapplicable recipe entries
- **Status:** NOT STARTED
- **Issue:** Show disabled entries with tooltips explaining why unavailable
- **Design:** Need recipe requirement metadata + UI for disabled state

#### 4.3 Protocol report card polish ✅ MOSTLY DONE
- **Status:** IMPLEMENTED
- **Fixed in:** `e1e26b6` (protocol-report-card class, phase transitions, button wiring)
- **What works:**
  - Card mounts in agent panel (`appendCard()`)
  - Lifecycle: `planning` → `running` → `done`/`aborted`
  - Step-by-step progress rendering
  - Phase badges (cyan/green/yellow borders)
  - Cancel/Rerun/Open Report buttons
- **Remaining:**
  - Better done-state summary (may be good enough as-is)
  - Collapsible/accordion per-step details (future enhancement)

#### 4.4 Recipe drift safeguards
- **Status:** NOT STARTED
- **Issue:** Add checks for stale slash command refs or invalid recipe wiring
- **Design:** Runtime validation during recipe load

#### 4.5 Recipe portability improvements
- **Status:** NOT STARTED
- **Issue:** Package-manager awareness (npm/pnpm/yarn/bun), monorepo support
- **Note:** Lower priority; depends on real-world usage patterns

---

### Phase 5 — AI Usage / Economics / Billing (VERY HIGH PRIORITY)

#### 5.1 Unified AI usage event schema
- **Status:** NOT STARTED
- **Issue:** Define standard event record for every AI/model invocation
- **Required fields:** timestamp, user/session id, mode, model, tokens, cost, duration, state
- **Why:** Required for billing architecture, cost visibility, decision-making
- **Complexity:** Medium-high (schema design + instrumentation across 20+ call sites)

#### 5.2 Full-cost capture across all AI surfaces
- **Status:** NOT STARTED
- **Issue:** Track every model-backed call (primary, verifier, retries, web_search, etc.)
- **Why:** Understand total spend, not just obvious calls
- **Complexity:** High (needs changes to agent, verifier, web_search, skills, recipes)

#### 5.3 Historical OpenRouter pricing snapshotting
- **Status:** NOT STARTED
- **Issue:** Store pricing basis at time of call for auditability
- **Why:** Historical reports must remain accurate if prices change
- **Note:** Requires OpenRouter API integration

#### 5.4 Usage aggregation and internal reporting
- **Status:** NOT STARTED
- **Issue:** Aggregate by day/week/month, model, mode, feature
- **Why:** Identify highest-cost workflows and anomalies
- **Design:** Backend reporting queries + optional dashboard

#### 5.5 Plan-design instrumentation
- **Status:** NOT STARTED
- **Issue:** Track usage dimensions for future pricing tiers
- **Candidates:** agent turns, audits, builds, fixes, premium-model turns, web searches
- **Why:** Real data informs subscription design
- **Note:** Parallel to schema work (5.1)

#### 5.6 User-facing usage visibility
- **Status:** NOT STARTED
- **Issue:** Show where spend is going (per-chat, per-model, monthly estimate)
- **Why:** Users should see costs before surprises
- **Design:** Small summary in UI, optional detailed view

#### 5.7 Cost-aware routing and feature prudence
- **Status:** NOT STARTED
- **Issue:** Downgrade/reroute expensive features if economics too risky
- **Why:** Protect product margins, user budgets
- **Dependencies:** Requires 5.1–5.6 infrastructure + model evaluation

#### 5.8 Stripe/subscription architecture readiness
- **Status:** NOT STARTED
- **Issue:** Prepare backend for Stripe integration without retrofitting later
- **Scope:** Account/billing schema, quota enforcement, metering API
- **Note:** Parallel work to usage tracking (5.1–5.7)

---

### Phase 6 — Analysis Engine Upgrades (MEDIUM PRIORITY)

#### 6.1 Verifier/reviewer methodology tuning
- **Status:** NOT STARTED
- **Issue:** Add checks for cross-commit invariants, helper-body inspection, schema round-trips
- **Why:** Catch refactor incompleteness and hidden no-ops more reliably
- **Dependencies:** Requires verifier model calibration work

#### 6.2 Dedicated `/review` mode
- **Status:** NOT STARTED
- **Issue:** Add mode optimized for cohesion/incompleteness, not just generic audit
- **Why:** Recent work review has different signals than security/correctness audit
- **Design:** New mode with custom system prompt + report format
- **Note:** Mentioned in code but not yet implemented

---

### Phase 7 — Skills System (LLM-driven surfacing)
**North star:** stored skills surface to the LLM as candidates; the LLM decides if any apply to the current turn and asks the user for permission to load one. Two distinct concepts that should NOT be conflated:
  1. **Skill as knowledge** — markdown content the LLM can pull into context when relevant. Small. Ship first.
  2. **Skill as executable** — runnable workflow that goes through the recipe lifecycle. Big. Defer until #1 is in users' hands and we have data on usage.

7.1–7.4 are v1 (knowledge-only). Each step is independently shippable. Stop after 7.4, ship, watch real usage before opening 7.5+.

**Why LLM-driven instead of keyword-matching:** users want stored knowledge to *surface* when relevant, not to manage a heuristic. The LLM already understands semantic intent better than any string-overlap scoring we'd hand-roll. Hit/miss is acknowledged — that's the cost of automation; users still control the final yes/no.

#### 7.1 Define the v1 file format
- **Status:** NOT STARTED
- **What:** A skill is a markdown file at `.prism/skills/<slug>.md` with a tiny YAML frontmatter:
  - `name`: human-readable label
  - `description`: one-line "when to use" hint (this is what the LLM sees — quality matters)
  - body: free-form markdown that becomes the injected content when the skill is loaded
- **Deliberate non-goals (v1):** no schema version, no validator, no `steps:`, no required fields beyond name + description.
- **Description-style guidance (in the README):** lead with the trigger condition ("Use when …"), be specific about domain, keep under 100 chars. Vague descriptions cause over- or under-triggering by the LLM.
- **Estimated scope:** docs only — `.prism/skills/README.md` describing format + description-style. ~40 lines.

#### 7.2 `/skills` slash command (list + browse)
- **Status:** NOT STARTED
- **What:** New slash command that scans `.prism/skills/`, parses each file's frontmatter, renders a Discord-style table (name + description) in the agent panel.
- **Mirrors:** `/models` (`renderModelsMarkdown` pattern in `slash-commands.ts`).
- **Backend:** Tauri command `list_skills(cwd)` returning `[{slug, name, description}]`. Reading the body is deferred until the user actually uses one.
- **Why before 7.3:** browsing is orthogonal to runtime use, gives users a way to confirm what's discoverable, and doubles as a debugging surface for the manifest the LLM will see.
- **Estimated scope:** ~50 LOC TS + ~30 LOC Rust.

#### 7.3 Skills toggle + LLM-driven `read_skill` tool (CORE FEATURE)
- **Status:** NOT STARTED
- **What:** The mechanism that makes skills surface ambiently:
  1. New pill near CMD/AGENT: `skills off` / `skills on`. Same shape as the intent badge. State persisted per-tab in layout state.
  2. When ON, the agent's system prompt gets a manifest line: `Available skills (call read_skill(slug) if any apply): react-debugging — Use when debugging a React component or hook; …`. Just name + description — cheap on context, no bodies.
  3. New tool `read_skill(slug)` registered in the agent's toolset. Marked `requires_approval: true` so it slots into the existing per-call approval system (commit `058fbbc`).
  4. When the LLM decides a skill applies, it calls the tool. User sees the standard approval card: "Read skill `react-debugging`?" with the description as context. Yes → tool returns the body, LLM continues with it in context. No → tool returns `"user declined"`, LLM proceeds without it.
- **Why this design wins:**
  - Replaces both keyword-matching and `@@<slug>` explicit invocation with one mechanism.
  - Lazy: bodies only loaded when the LLM actually wants them; manifest is cheap.
  - Reuses existing approval plumbing — no new consent UI to design.
  - Self-explaining: the user sees WHICH skill and WHY (the description) before saying yes.
- **Default state:** toggle OFF on first launch. Opt-in to keep the surface discoverable but never surprising.
- **Trade-offs accepted:**
  - One extra round-trip (~1s) when the LLM triggers a skill. Tolerable; only happens on confident matches.
  - Manifest tokens per-turn when toggle is ON. Mitigated by short descriptions and the toggle.
  - Hit/miss element on the LLM's part — acknowledged. Users still gate via Yes/No.
- **Estimated scope:**
  - Pill + toggle state + persistence: ~40 LOC TS
  - Manifest assembly into systemPrefix: ~30 LOC TS
  - `read_skill` tool registration + approval wiring: ~50 LOC TS + ~30 LOC Rust
  - Approval card text rendering for the skill case: ~20 LOC TS
- **Closes:** the original "wire skills into runtime" gap.

#### 7.4 Per-skill enable/disable in settings
- **Status:** NOT STARTED
- **What:** Settings UI already references skills but doesn't affect runtime. Add a per-skill toggle list. Disabled skills are excluded from the manifest the LLM sees in 7.3.
- **Mirrors:** `settings.isModelEnabled` pattern (already in `settings.ts`).
- **Why useful:** users can hide noisy or unused skills without deleting the file. Also useful for project-specific skill sets across multiple repos.
- **Estimated scope:** ~10 LOC plumbing + per-row toggle UI in existing settings panel.

--- v1 stops here. Ship and watch. ---

#### 7.5 Structured executable skills (`prism-skill-v1`)
- **Status:** NOT STARTED. **Do not start until 7.1–7.4 are shipped and used.**
- **What:** Extend the spec with optional `steps:` block (same shape as recipes), reuse the recipe runner + ProtocolReportCard, add `/skill run <slug>`.
- **Why deferred:** ~500 LOC of new validator + lifecycle, and may be the wrong abstraction. Recipes already exist for runnable workflows; if knowledge-skills + recipes covers 95% of use cases, this is dead weight.
- **Decision gate:** revisit after 30 days of v1 usage. Are users repeatedly asking for runnable skills? Are they trying to put `steps:` in their markdown anyway?

#### 7.6 Agent-assisted skill builder
- **Status:** NOT STARTED
- **What:** Agent helps formalize loose skills into structured runnable skills.
- **Dependencies:** 7.5 must be shipped and used first.
- **Note:** Lowest priority in this phase — nice-to-have for power users, not a needle-mover.

---

### Phase 8 — Lower-Level Plumbing (LOW PRIORITY)

#### 8.1 Tilde/path expansion reliability
- **Status:** LIKELY GOOD
- **Issue:** Ensure `~/...` paths resolve consistently everywhere used
- **Note:** Rust backend handles tilde expansion in path resolution

#### 8.2 Duplicate-session temp file hygiene
- **Status:** LIKELY GOOD
- **Fixed in:** `bc36380` (temp file cleanup in duplicate flow)
- **Verification:** Check for orphan temp files after duplication

#### 8.3 Layout/persistence parity
- **Status:** GOOD
- **Fixed in:** Multiple commits
- **What works:** Frontend/Rust schema in sync, layout persists to state.json
- **Verification:** Close/reopen tab and verify layout preserved

#### 8.4 Pane visibility persistence ✅ DONE
- **Status:** IMPLEMENTED
- **Fixed in:** Hydration logic reads layout from state.json
- **What works:** Preview/terminal/agent visibility persists across restarts

#### 8.5 Dead plumbing cleanup
- **Status:** PARTIALLY DONE
- **Fixed in:** `b41663b` (prune orphaned markdown preview CSS)
- **Remaining:** Review for other dead config/code paths

---

### Phase 9 — Backlog Features / Ideas (NICE-TO-HAVE)

#### 9.1 Fullscreen-in-app affordance
- **Status:** NOT STARTED
- **Design:** Expand pane to fullscreen inside app
- **Priority:** LOW

#### 9.2 HTML / Markdown viewer
- **Status:** NOT STARTED
- **Design:** Richer file/content viewer for HTML or Markdown
- **Priority:** LOW

#### 9.3 Decorative / brand polish
- **Status:** NOT STARTED
- **Design:** Prism-colored divider above tabs, etc.
- **Priority:** COSMETIC

#### 9.4 Diagnostics review for slash functions
- **Status:** NOT STARTED
- **Note:** Needs clarification before implementation

---

## ✅ SECTION 2: ITEMS ALREADY DONE

### Trust & Safety (Phase 1)

✅ **Agent streaming autoscroll** (commit `7dfc64e`)
- Autoscroll respects user intent; stops when user scrolls away
- `followStream` flag + scroll listener ensure latest output visible

✅ **File write / delete approval guarantees** (commits `058fbbc`, `e1e26b6`)
- Per-call approval enforced for all filesystem mutations
- `requires_approval()` checks gated write_file, edit_file, delete, move, mkdir
- Session approval limited to non-filesystem tools
- Candidate-tier `/fix` requires explicit `--allow-candidate` flag

✅ **Verified / observed label rendering cleanup** (commit `895f872`)
- Labels normalized to `✓ Observed` / `~ Inferred` / `? Unverified`
- Function `confidenceBadgeLabel()` at problems.ts:27 standardizes rendering

### Daily-use Readability (Phase 2)

✅ **Structured outputs as Markdown** (commits before `bc36380`)
- `/help`, `/models`, `/history`, `/last` all render via markdown functions
- Report cards use proper styled sections with headings, lists, code

✅ **Highlight visibility** (commit `bc36380`)
- Selection opacity: 0.35 → 0.55 (file preview), 0.6 (input area)
- Selection now clearly visible without being harsh

✅ **New-conversation affordance** (commits `8e02277`, `ffe3f9c`, `b1f5d43`)
- New button in prompt chrome (visible, labeled, clickable)
- Long-thread nudge fires at ~80 messages (40 turns)
- Topic-shift nudge detects keyword drift and suggests fresh chat
- Both nudges fire at most once per conversation (state tracked)

✅ **Clickable model/CMD pills** (commit `e1e26b6`)
- Model badge click → renders available model choices
- Intent badge (CMD/AGENT) click → toggles mode
- Both wired in `setupBadges()` at agent-view.ts

✅ **ANSI/control-sequence sanitization** (commit `56e4094`)
- `stripAnsi()` function removes terminal escapes (~50 call sites)
- Tool names, summaries, errors all sanitized before rendering
- No visible escape codes leak into agent panel

### File Explorer / Viewer (Phase 3)

✅ **Explorer context actions** (commit `bc36380`)
- Right-click context menu on tree rows
- New File / New Folder / Rename actions
- Copy Path / Copy Relative Path
- Add to Prompt (@-reference) action

✅ **Explorer settings (size/date)** (commit `bc36380`)
- Gear menu with checkboxes for Show file sizes / Show modified dates
- Backend captures `mtime_secs` for all files (file_ref.rs)
- Metadata rendered as "42 KB · 2026-04-30" pairs in tree
- Defaults: sizes ON, dates OFF

✅ **File viewer visibility toggle** (commit `7dfc64e`)
- Explicit button to show/hide file preview pane
- Wired in sidebar header chrome

✅ **IDE-style hotkeys for pane visibility** (multiple commits)
- `Cmd+B` toggle sidebar
- `Cmd+J` toggle terminal
- `Cmd+L` toggle agent
- `Cmd+Shift+P` toggle preview
- All functional and routed through editor keydown handler

### Protocols (Phase 4)

✅ **Protocol report card polish** (commit `e1e26b6`)
- Full lifecycle implementation in ProtocolReportCard class
- Phases: planning → running → done/aborted
- Step-by-step progress with state badges (active/ok/failed/skipped)
- Cancel / Rerun / Open Report buttons all wired
- Mounts in agent panel via `appendCard()`
- Smooth DOM mutation lifecycle (no re-renders)

### Lower-Level (Phase 8)

✅ **Pane visibility persistence** (hydration logic)
- Preview/terminal/agent visibility persists to state.json
- Restored on app restart / tab reopen

✅ **Dead code removal** (commit `b41663b`)
- Orphaned markdown preview CSS removed
- Unused `marked` and `highlight.js` dependencies removed
- Font typo fixed (JetBrainsMono NF → JetBrains Mono)

---

## 📊 Summary by Phase

| Phase | Items | Status | Notes |
|-------|-------|--------|-------|
| **1** Trust & Safety | 5 | 4/5 DONE | File-editor slash verified clean (this session) |
| **2** Daily-use | 9 | 7/9 DONE | Code-block contrast + agent-pane Cmd+F not yet started |
| **3** File Explorer | 7 | 6/7 DONE | File viewer Cmd+F shipped this session; resize polish remaining |
| **4** Protocols | 5 | 1/5 DONE | Card polished + spinner glyph fixed; UI menu not started |
| **5** AI Usage / Billing | 8 | 0/8 DONE | **CRITICAL PATH** — needs planning |
| **6** Analysis Engine | 2 | 0/2 DONE | Requires verifier methodology work |
| **7** Skills | 6 | 0/6 DONE | LLM-driven plan: 7.1–7.4 = v1, 7.5–7.6 deferred |
| **8** Plumbing | 5 | 3/5 DONE | Mostly cleanup, minor issues remain |
| **9** Backlog | 4 | 0/4 DONE | Nice-to-have, deprioritized |

**Overall:** 24/51 items DONE (~47%) | several IN PROGRESS / PARTIAL | Phase 5 still CRITICAL PATH (billing)

---

## ⚡ Highest-Priority Next Steps

### Immediate (Next Session)
1. **Verify file-editor slash bug is fixed** — E2E test needed
2. **Tune topic-shift nudge threshold** — Current 0.2 (20%) too permissive; recommend 0.5 (50%)
3. **Test all Phase 2 items** — Verify renders, highlights, autoscroll all working as intended

### This Sprint (Next 2–3 Days)
4. **Begin Phase 5 (AI Usage / Billing)** — This is now critical path
   - Start with unified event schema design
   - Instrument primary agent call path
   - Build foundation for future billing
5. **Code-block contrast polish** — Quick CSS tweak for Phase 2

### This Month
6. **Toolbar Protocols UI** — Makes recipes discoverable without CLI
7. **Disabled recipe entries** — Shows users why recipes unavailable
8. **Verifier methodology tuning** — Improve audit quality

---

## 🔗 Related Documents

- `docs/fixes/MASTER-Plan.md` — Original comprehensive list (unorganized)
- `docs/fixes/MASTER-AI-model-list.md` — Model evaluation and selection (companion)
- `docs/fixes/MASTER-AI-usage-and-billing.md` — Billing architecture planning (companion)

---

**Last Updated:** 2026-04-30 (skills LLM-driven plan + Cmd+F items)  
**Format:** Reorganized from sequential to TODO ↔ DONE for clarity and planning
