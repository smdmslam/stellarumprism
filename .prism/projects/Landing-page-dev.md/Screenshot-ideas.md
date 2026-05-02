# Screenshot Ideas \u2014 Audited Against the Codebase
**Audited:** 2026-05-02. Every idea below cross-checked against the
running source. Each entry cites the file(s) or slash command that
proves the capability ships today. Pure-invention framings from the
previous draft were removed; conflated framings were corrected.

Loose product ideas surfaced by this audit (e.g. visible Grounded-Chat
confidence badges, lifecycle card for `/build`-family modes,
`appendReport` Markdown for `/models` and `/last`) were moved to
`docs/fixes/MASTER-Plan-III.md` under CONSIDER ADDING.

---

## 1. The Problems Panel \u2014 audit findings with the dual confidence axis

Right after `/audit` completes, the Problems panel auto-opens with the
parsed findings list. The screenshot's job: show the **two axes** Prism
displays per finding side-by-side.

* **Severity axis:** `[error]` / `[warning]` / `[info]` (red / yellow /
  cyan).
* **Confidence axis (deterministically graded):** `[confirmed]` /
  `[probable]` / `[candidate]` (green / yellow / dim).

The labels live in `src/findings.ts` (`Severity`, `Confidence`) and
render via `renderAnsiFindings` + the Problems panel chips
(`src/problems.ts`). Confirmed = backed by typecheck / LSP / runtime /
test / schema. Probable = AST. Candidate = grep-only or LLM-only.

> Note: do not confuse this with the Grounded-Chat protocol's
> `\u2713 Observed` / `~ Inferred` / `? Unverified` labels. Those are
> per-claim self-assertions emitted INLINE in chat answers (`grounded-
> rigor.ts`), not the findings axis. Different feature, different
> surface.

---

## 2. The Incomplete Refactor Caught \u2014 the wedge

Split-screen: a renamed function (`getUser` \u2192 `fetchUserById`) on the
left, a stale caller still using the old name on the right. The file
editor renders inline squiggles backed by the latest audit (see
`Workspace.refreshEditorDiagnostics` in `src/workspace.ts`). The
Problems panel below shows the matching `[error]` finding with
`source=typecheck` evidence.

This is the canonical "AI assistant left a half-applied rename" case
the audit pipeline is built to catch.

---

## 3. Runtime Probe \u2014 `http_fetch` evidence

After an audit on a project with HTTP routes, show the Problems panel
with at least one finding tagged `source=runtime`. Hover (or expand)
to reveal the verbatim probe summary. Optionally a "Runtime probes"
section in the markdown report (rendered by `findings.ts:renderMarkdownReport`)
showing the `http_fetch` calls captured during the run.

Tools: `http_fetch` (single endpoint) and `e2e_run` (stateful
multi-step flow) \u2014 both real agent tools. The `runtime_probes` array
on `AuditReport` is populated whether or not the model bothers to
cite them in a finding's evidence stanza, so even sloppy auditor
output preserves the runtime trail.

---

## 4. Confidence Grader \u2014 deterministic downgrade in action

Side-by-side or stacked: an LLM-emitted `[error]` finding whose only
evidence stanza cites `source=grep` (no compiler backing). Show the
graded result alongside: `[error] [candidate]` \u2014 severity preserved,
confidence axis downgraded.

The grader is `src/findings.ts:gradeFinding`. Severity and confidence
are decoupled by design: the model can claim a severity, but the
confidence axis is computed from the evidence sources on each finding
and the model cannot raise it above what the substrate backs.

---

## 5. Approval Card \u2014 write-tool gate

Approval card mid-flight on a `write_file` or `edit_file` call. The
preview is a unified diff colored by the `--- old` / `+++ new` markers
the agent's `onToolApproval` handler styles
(`src/agent.ts`). Buttons:
**Approve**, **Approve all (session)**, **Reject**.

This is Prism's human-in-the-loop story for destructive actions:
no write goes to disk without an explicit click. (Reads, including
`read_skill`, do not gate \u2014 the approval flow is scoped to writes.)

---

## 6. ProtocolReportCard \u2014 lifecycle card for `/protocol <recipe>`

Mid-run screenshot of the card mounted by `/protocol harden` (or any
recipe). Bullets transition pending (.) \u2192 active (spinning ring) \u2192
\u2713 ok / \u2717 failed / \u2014 skipped as the runner's `RunProgress` events
arrive. Footer: **Cancel** during running; **Open full report** +
**Re-run** after done.

Source: `src/protocol-report-card.ts`,
`src/recipes/runner.ts:runRecipe` (Phase B + C), CSS in
`src/styles.css` `.protocol-report-card`. Shipped in commits
`500134e` (runner) and `f688294` (card).

> Replaces the previous "Protocol Report Card with /build" framing
> from the v1 of this doc. The card is tied to the `/protocol`
> recipe-runner pipeline, not `/build`. (Extending it to /build,
> /new, /refactor, /test-gen is a backlog item now in
> MASTER-Plan-III's CONSIDER ADDING section.)

---

## 7. `/models` \u2014 curated model library listing

Run `/models` in the agent panel. Output is a styled listing with the
currently-active model marked, three cost tiers shown via `$` /
`$$` / `$$$` glyphs, multimodal vision marked with `[img]`. Screenshot
at full width so all entries fit (`gpt-5.4`, `gemini-2.5-pro`,
`gemini-2.5-flash`, `gemini-2.5-flash-lite`, `grok-4.1-fast`,
`glm-5`, `claude-haiku-4.5`, `qwen-235b`).

Source: `src/models.ts:MODEL_LIBRARY` and `renderModelListAnsi`.
This is a terminal-styled listing rendered into the agent panel,
not a tabular UI. (Migrating to a Markdown table via `appendReport`
is a backlog item now in MASTER-Plan-III.)

---

## 8. `.prism/` Workspace Spine + `/last`

File-tree screenshot with `.prism/` expanded:
* `state.json` (tab-level pointer)
* `second-pass/audit-2026-XX-XXT...md` + matching `.json` sidecar
* `builds/build-2026-XX-XXT...md` + matching `.json` sidecar
* `chats/<title>-<stamp>.md` (saved chats)
* `skills/<slug>.md` (skill library)

Agent panel below shows `/last` printing the persisted last audit +
last build summaries with relative timestamps.

Source: `src-tauri/src/workspace_state.rs`, `src-tauri/src/second_pass.rs`,
`Workspace.renderLastAnsi` in `src/workspace.ts`. Shipped.

---

## 9. The IDE Surface \u2014 full layout

Wide screenshot of a single workspace with all five surfaces visible:

* Left: file tree (`.file-tree` + Files / Blocks tabs).
* Center top: file editor open on a TS / Rust file with audit-driven
  inline squiggles.
* Center bottom: xterm shell (the `terminal-host`).
* Right: agent panel with a recent turn including a tool-log card +
  prose answer + turn footer.
* Far right (collapsible): Problems panel with the latest audit's
  findings grouped by file.

All five surfaces are real and concurrently mounted (one workspace =
one of each). Layout is persisted via `state.json`'s `layout` block.

---

## 10. Skills \u2014 chip + `/skills` library

Two parts in the same screenshot:

1. **Input bar with an active skill chip** (e.g. `\u25b8 react-debugging
   \u00d7`). Clicking the `\u00d7` unloads the skill. Engagement is per-tab,
   ephemeral, prepended to every agent turn until unloaded.
2. **Agent panel showing `/skills` output** \u2014 a Markdown table of every
   skill in `<cwd>/.prism/skills/*.md` with description and size, plus
   the engaged skill marked.

Source: `src/skills.ts` (`listSkills`, `readSkill`,
`renderSkillsMarkdown`), `src/slash-commands.ts` (`/skills` entry),
`src-tauri/src/skills.rs` (Tauri commands).

> Removed the previous "Approval card for read_skill" framing.
> `read_skill` is non-destructive and does not gate through the
> approval flow. (A small chip-style "engagement notice" affordance
> when an LLM-driven `read_skill` fires is on the backlog in
> MASTER-Plan-III.)

---

## Demo Project

Staged demo project at:

```
/Users/stevenmorales/Development/StellarumPrism Demo Project/prism-demo-shots/
```

Intentional bugs covering:

* Incomplete refactor (stale caller) \u2014 backs screenshot #2
* Type mismatch \u2014 backs typecheck-source confirmed findings (#1, #4)
* Missing export \u2014 backs cross-file finding rendering
* Failing test \u2014 backs `source=test` confirmed findings
* Unused imports \u2014 backs `[info]` low-confidence findings

**Next step:** Run `npm install` in the demo project, then drive
PRISM through each numbered screenshot above. Acceptance: the
screenshot in the landing page matches what the running app
actually produces \u2014 not a stylized mockup.
