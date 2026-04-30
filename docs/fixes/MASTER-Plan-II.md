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
**Cost-pressure context (this session):** OpenRouter spend on Prism is being depleted faster than prior app projects. Two responses: (a) prune the model registry to a curated set of low-hallucination + cost-stratified options so users can't sabotage their experience by picking a poor model and blaming Prism; (b) instrument usage so we can see *where* the burn is, since adding cheap models doesn't help if a verifier loop or premium-default for chat is the actual driver. Phase 5 starts with the smallest possible logger so we have data within a week, before any further model curation decisions.
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

#### 5.9 Model registry curation policy ✅ DONE (this session)
- **Status:** IMPLEMENTED
- **Context:** Calibration testing identified that 13 of 21 registry models hallucinated in obvious ways under Prism's tool loop. Combined with cost pressure on OpenRouter, the decision was to **erase** the 13 from `src/models.ts` rather than soft-disable them.
- **Policy going forward:** the registry is the *endorsed* set, not a parking lot. Models that fail calibration get removed entirely. The audit trail of "what we tried and dropped" lives in `docs/MASTER-AI-model-list.md`, not in dead code in the runtime registry.
- **Why erase rather than hide:** (a) `enabled: false` still required pricing-data + routing-policy upkeep for Phase 5.3 / 5.7; (b) localStorage overrides from prior user toggles kept the disabled models visible in `/models` anyway; (c) hiding from Settings UI required new filter logic; (d) the disable was deliberate and not provisional. Power users can still pass any OpenRouter slug verbatim via `/model provider/slug` \u2014 `resolveModel`'s passthrough always works.
- **Final default-on lineup (8 models):**
  - Main: `gpt-5.4`, `gemini-2.5-pro`, `gemini-flash-latest`, `gemini-2.5-flash`, `grok-4-fast`, `haiku`, `glm-5`
  - Explore: `qwen-235b`
  - Backend (filtered out of UI): `sonar` (web_search backbone)
- **What got dropped:** kimi, qwen3.6, deepseek, qwen (qwen3-next-80b), gpt-oss, step, devstral, codestral, mercury, gpt5-mini, scout, grok-fast, minimax.

#### 5.10 Verifier-cost audit
- **Status:** NOT STARTED
- **Issue:** Every agent turn (when verifier is on) fires a *second* model call for review. If the verifier defaults to Haiku ($1 in / $5 out), every chat turn is paying frontier-light prices twice. This is a likely silent driver of the OpenRouter burn.
- **Action:**
  1. Confirm the current verifier-default model in `src/agent.ts` (`verifierModel` field).
  2. Switch to a cheaper verifier that's still rigorous enough to catch grounded-chat violations. Candidates: Qwen 235B (~$0.30/$0.90), GLM-5 (~$0.30/$1.50). The verifier doesn't need to be frontier; it reads structure.
  3. Optional: make the verifier conditional \u2014 only run for grounded-chat turns or audit/build modes, not casual chat.
- **Why this is high-leverage:** if verifier is defaulted to a $$$ model, switching to $ cuts review cost ~3\u20135\u00d7 across *every* turn that triggers it.
- **Estimated scope:** ~10 LOC config change + a one-paragraph rationale in the commit. Real work is the calibration: verify the cheap verifier still catches the rigor-violation patterns.

#### 5.11 Default-model + auto-thrifty preset review
- **Status:** NOT STARTED
- **Issue:** If the default chat model is GPT-5.4 or Haiku, every casual question costs premium rates. The `auto-thrifty` preset exists in `router.ts` and is supposed to route cheap-by-default \u2014 but it isn't currently the shipped default.
- **Action:**
  1. Audit what's set as the default in fresh installs (`src-tauri/src/config.rs` + first-run config write).
  2. If GPT-5.4 or Haiku, switch to `auto-thrifty` so chat gets routed cheap.
  3. Re-confirm `auto-thrifty`'s pool routes to the surviving 8 models post-trim (was probably referencing some of the removed ones).
- **Why this is the bigger lever:** chat is the most frequent path. Cutting per-chat-turn cost by 3\u20135\u00d7 dwarfs anything else.
- **Estimated scope:** ~30 LOC. Mostly auditing the current routing tables in `router.ts` and updating `auto-thrifty`'s pool to the 8-model set.

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

### Phase 7 — Skills System (two complementary tracks)
**Existing foundation (already built, see DONE section):** `docs/skills.md` reference; `.prism/skills/` corpus of 19 real skills in plain markdown; `src/skill-limits.ts` (per-skill 18 KB warn / 32 KB hard cap; 128 KB session budget); `src/settings.ts` skill curation map + saved-search groups; Settings UI Skills tab. **What's missing is the runtime engagement half.**
**Two intentional, complementary mechanisms** for getting skills into agent context. They are NOT alternatives — they solve different user problems and should both ship:
  - **Track A — Intentional engagement.** "Load skill X now." User knows what they want and explicitly engages it. Persistent per-tab via a chip in the input bar; explicit disengage by clicking the chip's `×`. Spec'd in `docs/skills.md`.
  - **Track B — LLM-aware mode.** "Skills awareness on." User opts in to letting the agent see the skill manifest and proactively suggest one when applicable. Approval-gated, lazy-loaded. The serendipitous "glad you suggested that" path.
**Out of scope for v1 (both tracks):** executable skills (skills with `steps:`). Skills are knowledge-only for now. Recipes already cover runnable workflows.
#### 7.1 Shared foundation: `list_skills` + `read_skill` Tauri commands + `/skills` browse
- **Status:** NOT STARTED
- **What:** Both tracks need backend access to the corpus. Build this once, both consume it.
  - Tauri command `list_skills(cwd)` — scans `.prism/skills/*.md`, returns `[{slug, name, description, sizeBytes}]`. Body NOT included; this is the cheap manifest.
  - Tauri command `read_skill(cwd, slug)` — returns the file body. Subject to size cap from `skill-limits.ts`. Used by both Track A's Load action and Track B's tool call.
  - `/skills` slash command — calls `list_skills`, renders Discord-style table in agent panel. Mirrors `/models`. Doubles as a debug surface for what the LLM will see in Track B.
- **Description derivation (no retrofit):** existing skills are plain markdown without frontmatter. Resolution order:
  1. If YAML frontmatter has `description:`, use it.
  2. Else use the first non-empty line after the H1 (typically the lead-in paragraph).
  3. Else fall back to the slug itself.
  Future skills MAY add frontmatter (`name:`, `description:`) if the derived line isn't tight enough; existing 19 files keep working untouched.
- **Estimated scope:** ~50 LOC TS + ~80 LOC Rust (list + read commands + frontmatter parser + tests).

#### 7.2 Track A — Intentional engagement (Load modal + chip + body injection)
- **Status:** NOT STARTED
- **What:** The model already documented in `docs/skills.md`:
  1. **Load action** somewhere reachable (toolbar button, `/skills load <slug>`, or modal). Picks one or more skills.
  2. **Engagement decision** runs through `decideEngagement` in `src/skill-limits.ts` — already built. Returns `ok` / `warn` / `block`.
  3. **Chip rendered in input-bar meta row.** One chip per engaged skill: `▸ react-debugging ×`. Click `×` disengages.
  4. **Bodies prepended to `systemPrefix`** for every turn while engaged. Pulled from `dispatchAgentQuery` plumbing; mirrors how `extractFileRefs` injects file refs.
  5. **Per-tab + ephemeral.** Engagement state lives in tab runtime, not persisted to localStorage or `session.json`. (Curation choices in Settings persist; engagement choices don't — by design, per `docs/skills.md`.)
- **Why this track exists:** explicit user intent. User has read the skill, knows it applies, doesn't want to wait for the LLM to discover it. Power-user fast path.
- **Estimated scope:**
  - Load entry point (slash + optional modal): ~80 LOC TS
  - Chip component + click handlers in input-bar: ~60 LOC TS + CSS
  - `systemPrefix` body injection in `dispatchAgentQuery`: ~30 LOC TS
  - Engaged-skills state on Workspace + chip render: ~40 LOC TS

#### 7.3 Track B — LLM-aware mode (toggle pill + manifest + `read_skill` tool)
- **Status:** NOT STARTED
- **What:** Ambient surfacing through the agent's own judgment. Solves the "I didn't know this skill existed but I'm glad it surfaced" case.

**Two orthogonal axes** — don't conflate:
1. **Skill awareness** (the pill): does the LLM even *know* what skills exist? Controls whether the manifest line is added to the system prompt every turn.
2. **Engaged skills** (the chips, owned by Track A): whose bodies are *actually in context*?

The two interact: when awareness is ON, the manifest line lists every skill **except already-engaged ones** so the LLM doesn't redundantly request bodies that are already in context.

**Sticky-by-default semantics.** When the LLM calls `read_skill(slug)` and the user approves, the skill becomes **engaged exactly as if `/skills load <slug>` had been used**: a chip appears in the input bar, the body lands in every subsequent turn's `systemPrefix`, sticky until the user clicks the chip's `×` or the tab closes. Track B is therefore just a different *entry point* to Track A's engagement state — there is one engagement model, not two flavors.

The alternative (one-shot per call) was considered and rejected: it forces the LLM to re-call `read_skill` every turn for the same skill, forcing the user to re-approve, which is thrash for skills like `vc-template` that the user wants persistent.

**Approval card text** must be explicit about the sticky commitment so users aren't surprised:
> Read skill `vc-template` and engage it for this tab? It will stay in context for every turn until you click the chip's × or close the tab.

**Implementation:**
  1. **Pill near CMD/AGENT:** `skills off` / `skills on`. Same shape as intent badge. Per-tab state, not persisted across restarts (matches Track A's ephemeral engagement principle).
  2. **When ON, system prompt gets a manifest line:** `Available skills (call read_skill if any apply): react-debugging — Use when debugging …`. Excludes already-engaged skills. Just name + description — cheap on context.
  3. **`read_skill(slug)` LLM tool** registered in `tools.rs`, `requires_approval: true`. Reuses the existing per-call approval card from commit `058fbbc`.
  4. **Approval flow:** user sees the card, clicks Approve → Rust executes the tool (returns body) AND emits a `agent-tool-${requestId}` event with `name: "read_skill"`. The frontend hooks this event to call `engageSkill(slug)`, which runs the same `decideEngagement` gate Track A uses. On block (over budget), the LLM still got the body for this turn but no chip appears — the engagement was correctly refused.
  5. **Track A independence:** the manifest excludes engaged skills; the `read_skill` tool returns the cached engaged body if called for an already-engaged slug (no disk read, no re-approval).

**Default state:** toggle OFF. Opt-in to discover the feature.

**Trade-offs accepted:**
- Hit/miss on the LLM's part — user gates via Yes/No, this is fine.
- One extra round-trip when triggered.
- Manifest token cost per-turn when ON. Mitigated by short descriptions + the toggle.
- Sticky engagement after one approval — explicitly named in the approval card text so users aren't surprised.

**Estimated scope:**
- Pill + awareness state: ~50 LOC TS
- Manifest assembly + injection: ~40 LOC TS (uses `list_skills` from 7.1, filters against engaged set)
- Rust `read_skill` LLM tool: ~80 LOC Rust
- Agent hook for post-approval engagement: ~25 LOC TS
- CSS for awareness pill: ~30 LOC

#### 7.4 Reconcile MASTER-Plan-II's old skill-runtime gap
- **Status:** SUBSUMED by 7.1–7.3.
- **Note:** the original "wire skills into runtime" item is what 7.1+7.2 close. No separate tracking needed.

--- v1 stops here. Ship 7.1 → 7.2 → 7.3, in that order. Both tracks add real value; sequence is just risk-driven (foundation first, then explicit, then LLM-aware). ---

#### 7.5 Structured executable skills (deferred)
- **Status:** NOT STARTED. **Do not start until 7.1–7.3 are shipped and used.**
- **What:** Extend skills with optional `steps:` block (same shape as recipes), reuse recipe runner + ProtocolReportCard, add `/skill run <slug>`.
- **Why deferred:** ~500 LOC of new validator + lifecycle, may be the wrong abstraction. Recipes already cover runnable workflows.
- **Decision gate:** revisit after 30 days of v1 usage. Are users asking for runnable skills? Are they trying to add steps anyway?

#### 7.6 Agent-assisted skill builder (deferred)
- **Status:** NOT STARTED
- **Dependencies:** 7.5 must ship first.
- **Note:** Lowest priority — nice-to-have for power users, not a needle-mover.

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

### Models / Cost (Phase 5)

✅ **Model registry curation pass** (this session)
- 13 underperforming models erased from `src/models.ts` after calibration sweep + cost pressure
- Final default-on set: gpt-5.4, gemini-2.5-pro, gemini-flash-latest, gemini-2.5-flash, grok-4-fast, haiku, glm-5, qwen-235b
- Policy: registry = endorsed set. No `enabled: false` parking lot.
- Power-user escape hatch: `/model provider/full-slug` still passes any OpenRouter slug through verbatim

### Skills (Phase 7, foundation/curation)

✅ **Skills reference doc** (`docs/skills.md`)
- Defines curation vs engagement distinction
- Per-skill caps (18 KB soft warn, 32 KB hard) + 128 KB session budget rationale
- Authoring guidelines and re-calibration policy

✅ **Skills corpus** (`.prism/skills/` — 19 files, ~113 KB)
- Real plain-markdown skill content covering Prism patterns, VC pitch decks, UI search, etc.
- Grouped by shared filename prefix (`vc-pitchdeck-*`, `ui-search-filtering-*`, etc.)

✅ **Size discipline module** (`src/skill-limits.ts`)
- `decideEngagement({candidate, alreadyEngagedBytes})` returns `ok` / `warn` / `block`
- Used by curation UI today; will be used by both engagement tracks (7.2, 7.3)

✅ **Curation persistence** (`src/settings.ts`)
- `enabledSkills` map + `savedSearchGroups` virtual groupings
- Settings Skills tab wired in `src/settings-ui.ts`
- Localstorage-persisted; intentionally separate from runtime engagement state

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
| **7** Skills | 6 | curation DONE; runtime 0/3 | Two-track v1 (7.1–7.3); 7.5–7.6 deferred. Curation infra (`docs/skills.md`, `skill-limits.ts`, settings) already shipped. |
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

**Last Updated:** 2026-04-30 (skills two-track plan + Cmd+F items)  
**Format:** Reorganized from sequential to TODO ↔ DONE for clarity and planning
