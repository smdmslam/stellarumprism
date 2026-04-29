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

### 2.4 Highlight visibility
- Improve the visibility of highlights that are currently too faint.
- Acceptance goal: highlights are obvious without feeling harsh.

### 2.5 New-conversation affordance
- Add a clearer “start a new chat” affordance.
- Add an agent-window prompt around long conversations (for example at ~40
  turns) recommending that the user fork the chat to keep work focused.
- Add a contextual agent-window prompt such as “Has the topic changed?” that
  recommends starting a new chat when the conversation appears to have shifted.
- Acceptance goal: users can easily tell how to begin a fresh conversation,
  and are gently guided toward forking or starting a new chat when a thread has
  become long or changed topics.

### 2.6 Task/progress visibility
- Make active work / checklist state more obvious in the UI.
- Acceptance goal: users can tell what Prism is currently doing and what is
  completed.

---

## 3. File explorer / file viewer improvements

These are practical IDE-surface improvements that will be felt constantly.

### 3.1 File explorer settings
- Add a settings icon to the file explorer.
- Allow toggling metadata visibility such as:
  - file size
  - modified date
- Acceptance goal: explorer metadata is user-configurable.

### 3.2 Explorer context actions
- Add right-click actions for:
  - new file
  - new folder
- Acceptance goal: common file-tree actions are discoverable and mouse-friendly.

### 3.3 File viewer drag/resize polish
- Improve the file viewer right-border drag behavior.
- Acceptance goal: resizing feels reliable and easy to grab.

### 3.4 File viewer visibility toggle
- Add an explicit icon/button to hide/show the file viewer.
- Acceptance goal: the preview/file-view surface is easier to control.

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

## 6. Skills system / executable skills

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

## 7. Lower-level plumbing / persistence cleanup

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

## 8. Backlog features / ideas (not urgent fixes)

These are valid ideas, but should not outrank the categories above.

### 8.1 Fullscreen-in-app affordance
- Add an expand-to-fullscreen view mode inside the app.

### 8.2 HTML / Markdown viewer
- Add a richer file/content viewer for HTML or Markdown.

### 8.3 Quick model / command toggles from chrome
- Let users click the CMD/model UI to bring up options.

### 8.4 Decorative / brand polish
- Consider adding the Prism-colored divider above tabs.

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

### Phase 3 — file explorer / viewer quality-of-life
12. Explorer context actions
13. File viewer hide/show control
14. Explorer settings (date / size)
15. File viewer resize polish
16. Recent paths in prompt area
17. IDE-style hotkeys for pane visibility

### Phase 4 — protocols / discoverability
18. Toolbar Protocols menu
19. Disabled/inapplicable recipe entries
20. Protocol report card polish
21. Recipe drift safeguards

### Phase 5 — analysis engine upgrades
22. Verifier/reviewer methodology tuning
23. Dedicated `/review` mode

### Phase 6 — larger infrastructure
24. Skills runtime wiring
25. Structured executable skills
26. Package-manager / monorepo-aware recipes

### Phase 7 — cleanup + optional features
27. Path/persistence cleanup items
28. Fullscreen / viewer / chrome extras

---

## Notes
- Items in sections 1–3 are the best candidates for short focused sessions.
- Section 4 is the main productization wave.
- Sections 5–6 are architecture / capability investments.
- Section 8 should stay deprioritized until the trust and workflow basics are
  solid.
