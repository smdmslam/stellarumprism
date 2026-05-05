# MASTER Plan
Date: 2026-04-29
Project: StellarumPrism

This file consolidates the remaining work noted across `docs/fixes/` plus
relevant items from `docs/futurework/notes-ideas-fixes.md`, grouped by type
and ordered into a practical implementation sequence.

---

## 1. Immediate trust / safety / correctness fixes

These should go first because they affect user trust, safety, or core editing
behavior.

### 1.1 File write / delete approval guarantees
- Ensure all agent-initiated file writes, edits, moves, and deletes require
  approval through the same approval surface.
- Investigate the reported path where a file change happened without an
  approval box.
- Acceptance goal: no filesystem mutation by the agent occurs silently.

### 1.2 File-editor slash leakage bug
- Fix the bug where slash input from the file edit viewer leaks into the main
  prompt line.
- Acceptance goal: typing `/` inside the file editor stays in the file editor
  and does not trigger prompt-side slash behavior.

### 1.3 Agent streaming autoscroll
- Make sure the agent panel keeps the newest generated text in view while the
  response is streaming.
- Acceptance goal: the latest assistant output stays visible unless the user
  intentionally scrolls away.

### 1.4 “Fixes without checking code” behavior
- Tighten the behavior where the assistant offers fixes without first checking
  the code or evidence.
- Likely path: stricter fix protocol, `/fix` routing, or methodology prompt
  tightening.
- Acceptance goal: fix suggestions are grounded in inspected code, not guesses.

### 1.5 Verified / observed label rendering cleanup
- Fix the confusing rendering / presentation of labels like `✓ Observed` and
  `~ Inferred`.
- Acceptance goal: these states are visually clear, correctly formatted, and
  not misleading.

---

## 2. Agent panel / report rendering polish

These items improve readability and make the product feel more finished during
normal daily use.

### 2.1 Structured outputs as real Markdown/report sections
- Render structural outputs as proper styled report sections instead of plain
  notice text:
  - `/help`
  - `/models`
  - `/history`
  - `/last`
  - structured audit/build-style summaries where appropriate
- Acceptance goal: headings, lists, inline code, and report structure display
  cleanly in the agent panel.

### 2.2 Loaded chat replay fidelity
- Replay loaded chats as true turns with prose and tool cards, not flattened
  blocks.
- Acceptance goal: loaded chats look the same as live chats.

### 2.3 Code-block card contrast
- Increase contrast / polish for rounded code boxes.
- Acceptance goal: code blocks are easier to scan and visually distinct from
  surrounding prose.

### 2.5 New-conversation affordance
- Add a clearer “start a new chat” affordance.
- Add an agent-window prompt around long conversations (for example at ~40
  turns) recommending that the user fork the chat to keep work focused.
- Add a contextual agent-window prompt such as “Has the topic changed?” that
  recommends starting a new chat when the conversation appears to have shifted.
- Acceptance goal: users can easily tell how to begin a fresh conversation,
  and are gently guided toward forking or starting a new chat when a thread has
  become long or changed topics.

### 2.7 Clickable model/cmd pills in the prompt chrome
- Make the model badge/pill clickable.
- Clicking the model pill should open the currently available model choices,
  aligned with whatever the settings toggles currently allow.
- Acceptance goal: the prompt chrome pills are interactive, discoverable
  controls rather than passive labels.

### 2.8 ANSI/control-sequence sanitization in agent output
- Strip, sanitize, or safely render terminal control sequences in the agent
  window and related UI surfaces.
- Prevent raw escape sequences such as `\x1b[2m` / `\x1b[0m` from appearing as
  visible text or replacement-glyph boxes in chat output.
- Acceptance goal: terminal-style formatting codes never leak into rendered
  conversation content.

---

## 3. File explorer / file viewer improvements

These are practical IDE-surface improvements that will be felt constantly.


### 3.5 Recent paths in prompt area
- Explore quick access to recent paths near the prompt area.
- Acceptance goal: easier file/path recall during prompting.

### 3.7 IDE-style hotkeys for pane visibility
- Add a standard set of keyboard shortcuts for common pane toggles and layout
  actions.
- Initial examples:
  - `Ctrl+J` toggles terminal visibility
  - `Ctrl+L` toggles agent window visibility
- Define the rest of the hotkey map based on common IDE conventions where that
  improves familiarity, while avoiding conflicts with platform-reserved
  shortcuts.
- Acceptance goal: users can quickly show/hide major panes with predictable,
  discoverable keyboard shortcuts.


This is the main productization layer for discoverable guided workflows.

### 4.1 Toolbar Protocols menu
- Add a toolbar button for protocols.
- Show recipes grouped by category.
- Launch recipes without requiring slash commands.
- Acceptance goal: a non-CLI user can run a protocol entirely from the UI.

### 4.2 Disabled / inapplicable recipe entries
- Show disabled entries when requirements are unmet.
- Include tooltips explaining why a recipe is unavailable.
- Acceptance goal: failures become discoverable before run time.

### 4.3 Protocol report card polish
- Improve the lifecycle card with:
  - better done-state summary
  - collapsible/accordion per-step details
  - optional help affordance
- Acceptance goal: protocol runs are easy to review after completion.

### 4.4 Recipe drift safeguards
- Add checks for stale slash command references or invalid recipe wiring.
- Acceptance goal: recipes fail less silently as the app evolves.

### 4.5 Recipe portability improvements
- Future work:
  - package-manager awareness (npm / pnpm / yarn / bun)
  - monorepo / workspace-awareness
- Acceptance goal: protocols apply more cleanly across non-Prism projects.

---

## 5. Review methodology / analysis engine improvements

These improve how Prism reasons about recent work and catches subtle regressions.

### 5.1 Verifier/reviewer methodology tuning
- Add methodology checks for:
  - cross-commit invariant tracking
  - helper-body inspection
  - frontend/Rust schema round-trip verification
- Acceptance goal: reviews catch refactor incompleteness and hidden no-op
  helpers more reliably.

### 5.2 Dedicated `/review` mode
- Add a dedicated review mode focused on cohesion / incompleteness / recent-work
  regressions.
- Acceptance goal: recent work can be reviewed with a workflow optimized for
  incompleteness rather than only generic audit behavior.

---

## 6. AI usage metering / cost visibility / billing readiness

This is now urgent enough to deserve its own major track. Prism is unusually
exposed to AI cost drift because it can invoke multiple model-backed actions
inside a single user-visible task, and recent OpenRouter credit exhaustion has
made the need for visibility concrete.

Goals:
- understand exactly where AI spend is coming from
- make expensive model usage visible before it becomes surprising
- support plan/pricing design with real data instead of guesswork
- prepare for future Stripe-backed subscriptions without retrofitting core
  architecture later
- help decide whether some costly features or defaults should be paused,
  downgraded, or rerouted to cheaper models until economics are clearer

### 6.1 Unified AI usage event schema
- Define a standard event record for every AI/model invocation.
- Include at minimum:
  - timestamp
  - user/account/workspace/session/chat id (as available)
  - mode (`chat`, `audit`, `build`, `fix`, `refactor`, protocol, skill, etc.)
  - model slug
  - provider
  - prompt/input tokens
  - completion/output tokens
  - total tokens
  - reasoning tokens if available
  - cached tokens if available
  - request duration
  - success / failure / cancel state
  - estimated cost
- Acceptance goal: every model-backed call can be represented in one durable,
  queryable format.

### 6.2 Full-cost capture across all AI surfaces
- Track not just the obvious foreground model call, but every meaningful
  model-backed path so very little spend escapes attribution.
- Include:
  - primary agent turns
  - verifier / reviewer calls
  - retries
  - follow-up completions
  - `web_search` backend usage (`perplexity/sonar`)
  - future recipe / protocol / skill-triggered model calls
  - vision/image analysis calls
  - any hidden or helper model invocations
- Acceptance goal: a user-visible action can be decomposed into the full set of
  AI calls and estimated cost that it triggered.

### 6.3 Historical OpenRouter pricing snapshotting
- Store the pricing basis used at the time of each call rather than relying
  only on current live provider pricing.
- Capture enough metadata to reconstruct historical cost even if OpenRouter
  later changes prices.
- Acceptance goal: historical usage reports remain accurate and auditable over
  time.

### 6.4 Usage aggregation and internal reporting
- Aggregate usage by:
  - day / week / month
  - account / user / workspace / project
  - model
  - provider
  - mode / feature
- Add internal reporting views or exports for:
  - highest-cost models
  - highest-cost workflows
  - high-frequency users
  - premium vs cheap model mix
  - cost spikes / anomalies
- Acceptance goal: Prism can quickly explain where spend is coming from and
  which features are economically dangerous.

### 6.5 Plan-design instrumentation
- Track usage dimensions that may become pricing units later, not just raw
  tokens.
- Candidate dimensions:
  - agent turns
  - audits
  - builds
  - fixes
  - premium-model turns
  - long-context turns
  - web searches
  - image/vision turns
  - protocol runs
- Acceptance goal: real usage data exists to inform subscription tiers,
  included quotas, overages, and premium-feature gating.

### 6.6 User-facing usage visibility
- Add lightweight visibility so the user can see where usage is going before
  formal billing exists.
- Possible surfaces:
  - per-session usage summary
  - per-chat/model usage summary
  - current-month estimated spend
  - warnings when a conversation or feature path is using unusually expensive
    models
- Acceptance goal: heavy spend is visible early enough that users can change
  behavior before running out of credits unexpectedly.

### 6.7 Cost-aware routing and feature prudence
- Use collected data to evaluate whether some defaults or features should be
  temporarily downgraded, rerouted, or parked if they are economically too
  expensive.
- Tie this directly to model-alternative evaluation work so Prism can switch to
  cheaper acceptable substitutes where quality remains close enough.
- Acceptance goal: product decisions about defaults and feature availability
  are informed by measured cost, not intuition.

### 6.9 Companion planning documents
- Model evaluation companion: `docs/fixes/MASTER-AI-model-list.md`
- Usage / billing companion: `docs/fixes/MASTER-AI-usage-and-billing.md`
- Acceptance goal: the master plan stays concise while detailed AI economics
  and model-selection thinking live in dedicated companion documents.

---

## 7. Skills system / executable skills

This is larger-scope infrastructure and should come after the core trust + UX
work above.

### 6.1 Wire skills into runtime behavior
- Make enabled skills actually influence agent behavior through runtime context
  injection.
- Acceptance goal: toggling a skill changes subsequent behavior in a verifiable
  way.

### 6.2 Structured executable skills (`prism-skill-v1`)
- Add the contract for structured skills.
- Add loader/validator.
- Add `prompt` runner step kind.
- Add:
  - `/skill check`
  - `/skill run`
  - `/skill convert`
- Acceptance goal: a skill can run through the same lifecycle/report-card model
  as a recipe.

### 6.3 Optional agent-assisted skill builder
- Add skill generation/build assistance later if desired.
- Acceptance goal: users can formalize loose skills into structured runnable
  skills with less manual work.

---

## 8. Lower-level plumbing / persistence cleanup

These are worth doing, but after the higher-value UX and trust issues.

### 7.1 Tilde/path expansion reliability
- Ensure path expansion behavior is real and consistent anywhere `~/...` style
  paths are used.
- Acceptance goal: all tilde-based paths resolve correctly and predictably.

### 7.2 Duplicate-session temp file hygiene
- Ensure any temp files used for session duplication are cleaned up reliably.
- Acceptance goal: duplication leaves no orphan temp files.

### 7.3 Layout/persistence parity
- Keep frontend and Rust layout schema in sync as fields evolve.
- Acceptance goal: layout settings persist and round-trip correctly.

### 7.4 Pane visibility persistence
- Persist preview / terminal / agent visibility consistently if that remains a
  desired behavior.
- Acceptance goal: workspaces reopen in the expected UI layout.

### 7.5 Dead plumbing cleanup
- Remove or clarify hidden/deferred plumbing such as old theme support if it is
  no longer intended to ship soon.
- Acceptance goal: less dead configuration surface.

---

## 9. Backlog features / ideas (not urgent fixes)

These are valid ideas, but should not outrank the categories above.

### 8.1 Fullscreen-in-app affordance
- Add an expand-to-fullscreen view mode inside the app.

### 8.2 HTML / Markdown viewer
- Add a richer file/content viewer for HTML or Markdown.

### 8.3 Quick model / command toggles from chrome
- Let users click the CMD/model UI to bring up options.

### 8.5 Diagnostics review for slash functions
- Needs clarification before implementation.

---

## Recommended implementation order

### Phase 1 — trust / safety / obvious bugs
1. File write / delete approval guarantees
2. File-editor slash leakage bug
3. Agent streaming autoscroll
4. Fixes-without-checking behavior
5. Verified / observed label cleanup

### Phase 2 — daily-use readability and comfort
6. Structured outputs as Markdown/report sections
7. Loaded chat replay fidelity
8. Code-block contrast
9. Highlight visibility
10. New conversation affordance
11. Task/progress visibility
12. Clickable model/CMD pills in prompt chrome
13. ANSI/control-sequence sanitization in agent output

### Phase 3 — file explorer / viewer quality-of-life
14. Explorer context actions
15. File viewer hide/show control
16. Explorer settings (date / size)
17. File viewer resize polish
18. Recent paths in prompt area
19. IDE-style hotkeys for pane visibility

### Phase 4 — protocols / discoverability
20. Toolbar Protocols menu
21. Disabled/inapplicable recipe entries
22. Protocol report card polish
23. Recipe drift safeguards

### Phase 5 — AI usage, economics, and billing readiness
24. Unified AI usage event schema
25. Full-cost capture across all AI surfaces
26. Historical OpenRouter pricing snapshotting
27. Usage aggregation and internal reporting
28. Plan-design instrumentation
29. User-facing usage visibility
30. Cost-aware routing and feature prudence
31. Stripe/subscription architecture readiness

### Phase 6 — analysis engine upgrades
32. Verifier/reviewer methodology tuning
33. Dedicated `/review` mode

### Phase 7 — larger infrastructure
34. Skills runtime wiring
35. Structured executable skills
36. Package-manager / monorepo-aware recipes

### Phase 8 — cleanup + optional features
37. Path/persistence cleanup items
38. Fullscreen / viewer / chrome extras

---

## Notes
- Items in sections 1–3 are the best candidates for short focused sessions.
- Section 4 is the main productization wave.
- Sections 5–6 are architecture / capability investments.
- Section 8 should stay deprioritized until the trust and workflow basics are
  solid.
