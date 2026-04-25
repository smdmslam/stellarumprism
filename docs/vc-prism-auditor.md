# Prism — Substrate-Gated Development

*A diagnostic substrate for AI-assisted coding. Catches the wiring gaps your editor missed; gates every edit on the substrate before it lands.*

> **Cursor edits. Antigravity executes. Prism verifies — and now builds, refactors, scaffolds, and tests on the same substrate.**

## TL;DR

AI coding tools (Cursor, Antigravity, Copilot) are now good enough to execute large refactors. They are **not** good enough to execute them completely. Every meaningful refactor ships with incomplete renames, dangling references, half-rewired call sites, and dead imports — and the very tool that made the refactor is the wrong tool to audit it.

**Prism** is a terminal-native AI development environment built around a single insight: **deterministic checks should run BELOW the LLM, not above it.** The substrate (compile, cross-reference, type resolution, runtime probe, schema inspection, LSP analysis, end-to-end flow) runs first. The LLM only writes findings the substrate can confirm. The grader, not the model, picks the confidence tier.

That substrate now powers six consumers — `/audit`, `/fix`, `/build`, `/refactor`, `/test-gen`, `/new` — plus a CI-friendly CLI (`prism-audit`) and an emerging IDE shell (file tree + Problems panel today; tabbed editor + inline squiggles + run/debug surface in flight). Same seven cells, six surfaces. That's the architectural bet: **build the substrate once, ride it across every workflow.**

The wedge is verification. The vector is everything that follows verification. The defensibility is that competitors built editors first and have to retrofit a substrate; we built the substrate first and can grow editor surfaces on top of it without giving up the correctness floor.

---

## The problem

AI-assisted refactoring has a silent failure mode.

A concrete, recent example from our own development:

> Stellarum Atlas had a single 12,000-line main app page. Google Antigravity — the most precise AI editor I've found — couldn't refactor it in one pass without hitting token limits. So I broke it up manually, then used Antigravity to refactor the split pieces.
>
> The refactor "worked": tests passed, the app loaded, superficial flows looked right.
>
> When I asked Warp to review the work, it immediately found **9 areas of incomplete implementation** — half-rewired callers, old-path references, missing exports. Actual usage surfaced **at least 4 more** wiring gaps over the following days.

This is the typical outcome of any large AI refactor today. Not a Cursor problem, not an Antigravity problem, not a user-skill problem. It's structural:

1. **The editor and the reviewer should not be the same agent.** An editor is biased toward confirming its own work. The same model that renamed `fooBar` is the last one you want asking "did I miss any callers of `fooBar`?" It's a Dunning–Kruger loop in silicon.
2. **Context windows are the bottleneck.** Even 2M-token models can't hold a real codebase plus an active diff plus every import graph. Editors optimize for *completing an edit*; they don't stop to do holistic wire-checks afterward because they're out of budget.
3. **IDEs are optimized for writing, not reviewing.** Cursor, Antigravity, VS Code + Copilot — all UI and UX is oriented around "make this change." There's no first-class "scan the whole project for refactor incompleteness" mode. You get line-level linting and type-checking, neither of which catches semantic wiring gaps (e.g. a caller that now passes the old shape to a callee expecting the new shape, when both shapes are structurally compatible but logically different).
4. **Humans don't catch these either.** Wiring gaps tend to be invisible until the specific code path runs in production. They're the class of bug that shows up as "it worked yesterday" three sprints later.

The result: every major AI-assisted refactor carries hidden debt. The industry has quietly accepted this as the cost of doing business. It shouldn't be.

## The solution

Prism is a *diagnostic substrate* with thin LLM consumers on top. The substrate runs deterministic checks the LLM can't fake: compile the project, resolve symbols, run tests, probe HTTP endpoints, walk migrations, query an LSP server, replay end-to-end flows. The consumers (audit, fix, build, refactor, test-gen, new) interpret those results, dedupe, and either write a findings report or generate code that's gated on the substrate. Pushing the deterministic work below the LLM is what makes the output trustworthy — the model can only emit findings or edits the substrate can confirm.

**The substrate today (eight cells, all shipping):**

1. `typecheck` — runs the project's actual `tsc` / `cargo check` / `pyright` / `go build` and parses real diagnostics. Compiler-grounded findings are the highest-confidence tier in the grader.
2. `ast_query` — TypeScript-compiler-backed symbol resolution. The deterministic answer to "does this identifier exist in scope?" — the question grep cannot answer.
3. `run_tests` — runs the project's test suite (vitest / jest / cargo test / pytest / go test). Behavior regressions become confirmed evidence.
4. `lsp_diagnostics` — language-agnostic LSP analysis (rust-analyzer / pyright / gopls / typescript-language-server). Catches what bare `cargo check` misses.
5. `http_fetch` — runtime probe against the dev server. Live response is runtime-tier evidence.
6. `e2e_run` — multi-step stateful flows (login → action → assert), JSON-path extraction across requests. Strongest runtime signal Prism produces.
7. `schema_inspect` — Prisma / Drizzle / SQLAlchemy / Django / Rails migration-state inspection. Catches the "works on my machine, broken in prod" class of bug.
8. `run_shell` — shell-execution gated on approval. Argv-array only; hardcoded deny-list (rm -rf /, fork bomb, dd of=/dev/, etc.) rejects destructive patterns BEFORE the approval card and cannot be bypassed via session-approval; optional config allowlist on argv[0]; cwd scoped to the project root; 32 KB / stream + 60s default timeout. Closes the long-standing gap that forced consumers like `/new` to print 'next steps' instead of running them.

**The consumers riding the substrate (six modes today):**

- `/audit` — read-only verification. Runs the substrate, produces a structured findings report.
- `/fix` — applies findings from a prior audit through the existing approval flow.
- `/build` — generates new features against the substrate (plan → execute → verify → iterate).
- `/refactor` — same-symbol rename across the project, gated on `ast_query` resolution at every site.
- `/test-gen` — generates tests for an existing symbol, post-verifies with `run_tests`.
- `/new` — scaffolds new projects from a stack description, hand-rolled (no shell-execution tool by design).

Each consumer is the same agent + tool surface, specialized by system prompt and a per-mode round budget. New consumers are days of work, not weeks.

The core workflow:

```bash path=null start=null
# You did your first pass somewhere else.
cursor .
# …refactor…

# Then you run Second Pass.
prism
> /audit HEAD~3
```

Second Pass reads the diff, enumerates every symbol touched, cross-references against the full repo, and returns something like:

```text path=null start=null
FINDINGS (12)
[error]   src/pages/app.tsx:342   — call site still passes { oldProp }; new signature expects { newProp }
[error]   src/api/client.ts:88    — import of legacyAuth is dead; callers were migrated
[error]   src/lib/router.ts:117   — matches the old route shape; new router expects path array
[warning] src/hooks/useAuth.ts:24 — returns User; callers in 3 files still destructure {user, loading}
…
```

Each finding is actionable. Each points at a specific file:line. You work down the list, fix what's real, discard what's noise. Your AI-refactored codebase is now actually done.

### The handoff: three flows, one artifact

Every audit writes a durable markdown report to `./.prism/second-pass/audit-<timestamp>.md`. That single file is the contract. From there, users pick whichever workflow fits:

- **Manual.** Read the findings in the terminal, fix them yourself in whatever editor you use.
- **Agent handoff.** Tell Cursor / Antigravity / Copilot Chat: *"Read `.prism/second-pass/audit-*.md` and fix each finding."* The editor's own agent does the work.
- **In-Prism.** Run `/fix 1,3,5` or `/fix all` and Prism itself works through findings using the existing edit-with-approval flow — you never leave the terminal.

The report is always written. The fix mechanism is your choice. This is the critical UX move: **Prism doesn't force users to leave their current editor to get value.** A Cursor user runs Second Pass, gets a markdown file, feeds it back to Cursor. A Prism-only user stays in Prism. Both work; both are first-class.

### The architectural principle

**The filesystem is the database. Markdown is the format.**

Every meaningful artifact Prism produces — audit reports, chat transcripts, skills, notes — is a markdown file in a well-known folder. Any agent (Prism's, Claude's, Antigravity's, a future one) can consume it. No vendor lock-in, no proprietary schema, no migration tax when you switch tools. This is a deliberate choice and a competitive moat: tools built on markdown folders outlast tools built on proprietary DBs.

### Skills: bring your own knowledge

Prism reads markdown files from `~/.prism/skills/` (global) and `./.prism/skills/` (per-project) as **skills** — reusable knowledge packs the agent pulls into context on demand or automatically at session start. Same pattern Anthropic formalized as Claude Skills, same file format, but usable against any model Prism routes to.

This is where Second Pass compounds into something more than a lint tool. Every audit you run can be archived as a skill: `./.prism/skills/past-refactor-gotchas.md`. Over time the agent gets smarter at *your specific codebase* because its own past findings feed back in. You build institutional memory automatically, just by using the tool.

## Why this, why now

Three market conditions make this the right wedge, right now.

**1. AI-assisted editing is suddenly ubiquitous.** Cursor, Antigravity, Claude Code, Copilot, Windsurf — every working developer in 2026 is using at least one. The volume of AI-generated refactors is higher than it has ever been and is growing. The blast radius of the silent-incompleteness problem is growing with it.

**2. No one else is building this.** Every AI dev tool in the market today positions itself as a better *editor*. Cursor, Zed AI, Antigravity, Copilot Chat, Codeium — they compete on inline-edit quality, long-context size, agent autonomy. None of them brand themselves as **the tool you run after the edit**. That positioning is open.

**3. The reviewer approach is uniquely well-suited to terminal-native UX.** An editor-style tool has to live next to the code it edits. A reviewer tool just needs to read the filesystem, run grep, diff git, and print a list. That fits a terminal like a glove. It also means Second Pass can sit next to any editor the user already has — Cursor, VS Code, Antigravity, Vim — without asking them to switch. Low adoption friction, high utility.

## Differentiators

Against the general AI-coding market:

- **Dedicated reviewer persona.** Not an afterthought in a generalist agent.
- **Compiler-grounded.** The substrate runs the project's actual build. Findings the LLM emits are confirmed by deterministic checks, not inferred from source text. False positives drop accordingly.
- **Scanning tools, not just edit tools.** grep / find / git_diff are first-class.
- **Long-context by default for audits.** Routes to 1M–2M ctx models automatically.
- **Structured output.** Findings are a checklist, not a paragraph.
- **Editor-agnostic.** Works alongside Cursor / Antigravity / VS Code / Vim — doesn't ask users to switch IDEs to benefit.
- **Terminal-native.** Fits into existing developer workflows without a new UI paradigm to learn.
- **Model-agnostic by design.** Works on any capable tool-using model from any provider. Not tied to Anthropic, OpenAI, or any single lab.

Against Warp specifically (the closest existing thing):

- Warp is a generalist AI terminal; audit capability is emergent, not targeted.
- Prism Second Pass will ship audit-specific tools (grep / find / git_diff / bulk_read) and a dedicated mode with a structured findings schema.
- Prism Second Pass will route audits to long-context models automatically; Warp doesn't distinguish.

## Why this is durable

Most AI coding tools on the market are **model bets**. Cursor's value is inseparable from Claude Sonnet or GPT-5.4's quality; Copilot is an OpenAI skin. If the underlying model provider has an outage, raises prices, or falls behind a competitor, the product suffers immediately.

Prism is a **tool-loop bet**. The intelligence is distributed across four layers, not concentrated in one:

- The system prompt + tool schemas teach the agent *when* to grep, *when* to read, *when* to diff.
- The iterative loop orchestrates tool calls across rounds.
- The tool results themselves ground every response in the user's real filesystem, not the model's training data.
- Only the remaining share is the LLM's own reasoning.

This ratio shows up in practice. In our own testing, a mid-tier model (DeepSeek V3.2, roughly $0.28 per million tokens) completed every tested audit workflow — iterative grep/find/git_diff/bulk_read loops, cross-referencing symbols across files, producing coherent reports — nearly as well as frontier models priced 10–30× higher. The primary model is a commodity underneath a thick, deliberately-designed tool surface.

Three investor-relevant consequences follow:

1. **Elastic cost structure.** Premium per-turn quality is available when a task needs it (frontier models for long-context audits, vision tasks, gnarly reasoning). Day-to-day workflows run on cheap open-weights models with near-equivalent outcomes. That's a defensible unit-economic story at both the individual and team tier.
2. **Vendor risk is diffused.** A single provider's outage, price change, or model deprecation doesn't break the product — we route to another capable model from the 20+ supported. Prism inherits the aggregate quality of the open model ecosystem rather than being pinned to one lab.
3. **Open-weights progress is trivially adoptable.** Adding a new model to the router is a single-file config change (one `ModelEntry` in `src/models.ts`, ~10 lines). There's no architecture work, no retraining, no integration project. When a better open-weights model drops — Qwen 4, DeepSeek V4, Llama next — slotting it into the agentic and thrifty presets is minutes of work, and Prism's cost-per-audit drops on the next release. Competitors with deep single-model integration cannot take that trade at anything like the same speed.

The historical parallel is cloud infrastructure. AWS didn't win because Intel made the best CPUs; it won because virtualization was the real product and the CPU was the commodity underneath. Prism is making the same bet at the tool-loop layer, above LLMs.

### The real compounding moat: accumulated knowledge

The stronger claim under the durability umbrella isn't about LLMs at all — it's about the fact that **Prism accumulates project- and user-specific knowledge as a side effect of being used.**

Every workflow in Prism produces markdown artifacts in a well-known folder structure:

- `./.prism/second-pass/audit-<ts>.md` — every audit report, archived automatically.
- `./.prism/skills/*.md` — project-specific knowledge (auto-captured learnings, user corrections, patterns the agent has noticed in this codebase).
- `~/.prism/skills/*.md` — user-level preferences across all projects ("we use snake_case here," "always run prettier after an edit," "prefer Vitest over Jest").

The agent both *reads* these on session start (as context) and *writes* to them as it works (when the user corrects it, when an audit finishes, when it notices a stable pattern). Over weeks of use, the tool develops a real model of **your** codebase and **your** preferences. None of that transfers when a user switches to Cursor, Antigravity, or anything else.
This is the moat Cursor, Windsurf, and Claude Code all independently converged on in 2026 — for good reason. It turns usage into compounding value. Switching cost stops being hypothetical and becomes "three months of institutional memory I'd have to rebuild."

Prism's markdown-as-format + filesystem-as-database choice is what enables this. Proprietary-schema competitors cannot offer the same file-portable, inspectable memory layer even if they wanted to.

### Comprehensive context, not retrieved fragments

Most AI editors retrieve. Prism reads.

Cursor / Copilot / Antigravity / Codex rely on embedding-based retrieval for project context. They tokenize the codebase, index chunks, and at each turn fetch the top-K nearest neighbors of the user's prompt. For tactical edits this is fine — the closest 8–16 chunks of source carry enough signal to write a function.

For comprehensive work it falls apart. A user trying to write a market-positioning doc against the whole project, a pitch deck cognizant of every shipped capability, an RFC reflecting the entire architecture, or a narrative diff explanation that holds the full refactor in mind — they get a model that has never seen the document end-to-end, only ranked fragments stripped of structural coherence. The output is piecemeal because the input is piecemeal.

Prism takes a different path. The `read_file` tool returns the whole file (up to 128 KB per call) into a long-context model that holds it for the entire conversation. Every follow-up turn anchors on the full document, not a re-retrieved fragment. The competition-analysis session in `docs/prism-competition.md` is the canonical example: a single `read_file` on the 22.6 KB auditor doc, plus five `web_search` calls, produced a coherent multi-section market analysis that referenced the project's own positioning verbatim. None of the existing AI editors can produce that shape of output reliably because their retrieval layer fragments the source.

The user-visible consequence is a wedge in its own right. Vibe-coders shipping complete products run into the comprehensive-context wall every day: trying to write a pitch deck, an investor memo, or a launch announcement that holds the full project in mind, in Cursor or Copilot, returns piecemeal output that has to be manually stitched. Prism does it natively. This is distinct from the verification wedge but anchored on the same architectural choice (whole-document tool reads + long-context routing) and it serves the same kind of user (the senior or solo developer who needs end-to-end project coherence to ship).

## Expansion path

Second Pass is the wedge. It earns the daily-driver slot through a narrow, sharp, underserved capability. Once users are in Prism for audits, two expansions become natural:

**Adjacent modes** (weeks, not months):

- `/explain` — produce a narrated walkthrough of code or a diff
- `/review-pr` — audit-style review scoped to a PR branch
- `/test-gen` — generate tests for the surface area a refactor touched
- `/debug` — interactive root-cause analysis for a failure

Each is the same agent + tool set + structured output pattern, specialized by system prompt. Near-zero marginal engineering cost.

**Editor surface** (months):

Once users live in Prism for verification-adjacent work, extending them into editing is a much smaller leap than landing them cold against Cursor. And critically: the IDE phase doesn't add a new product. It adds a new *renderer* on top of the diagnostic substrate that already exists. Squiggles, problems panel, pre-commit verification, and inline `Cmd+K` edits that won't apply unless they pass the substrate's checks. Same Findings schema. Same checks. New surface.

The IDE phase adds:

- CodeMirror editor pane
- File tree
- Inline `Cmd+K` agent edit on selection — gated on the substrate
- Git UI, diff viewer, LSP diagnostics rendered through the same Findings schema

This is the classic Cursor play run in reverse, but with a structural advantage. Cursor started as an editor and bolted reviewing on top — where reviewing has to fight the editor's speed-first architecture for every CPU cycle. Prism starts as a reviewer and grows an editor that *inherits* the reviewer's correctness floor. In a crowded editor market, "every edit is verified before it's accepted" is a position no one currently holds.

## Opportunity

**TAM (loose, top-down).** Every professional developer using AI-assisted tooling is a candidate. In 2026, that's essentially every professional developer — call it conservatively 20M+ globally. Even a fraction adopting a $10–20/month verification tool is a meaningful business.

**Monetization paths:**

- Per-seat subscription for individual developers
- Team tier with shared audit history and CI integration (run Second Pass against every PR)
- Eventually: an IDE tier, once we get there

**Strategic moat:** the audit workflow generates a data asset competitors don't have — a growing corpus of "what kinds of wiring gaps are typical in AI-generated refactors." That dataset feeds better audit-specific fine-tuning, which compounds over time.

There's a second, more immediate moat: the **self-reinforcing skills loop.** Every audit Prism runs can be archived as a markdown skill and re-loaded as context for the next audit. The tool learns your codebase as a side effect of being used. Switching to a competitor means throwing away accumulated institutional memory. Stickiness comes free with usage.

And a third, macro-level: **model-agnosticism as a hedge.** Every AI coding tool today is implicitly betting on one or two model providers continuing to lead. Prism benefits from the opposite trend — whenever open-weights or commodity models close the gap with frontier, Prism's cost-per-audit drops and the moat widens. Competitors with deep single-model integration can't take that trade.

## Naming

Working name: **Second Pass** (`prism second-pass` / `/audit` / `/second-pass`).

Rationale:

- Names the workflow directly — "I did my first pass with X; now I run Second Pass."
- Implies humility: the AI did the first pass, Second Pass catches what it missed.
- Short, memorable, easy to brand.

Alternatives considered:

- **Prism Audit** — accurate but generic; every tool says "audit"
- **Wire** / **Wiring** — captures the specific problem (wiring gaps) but narrow
- **Trace** — evocative but overloaded (debugger "trace", network "trace")
- **Verify** — plain
- **Quorum** — the idea of multiple reviewers; too abstract
- **Afterpass** — secondary feel but unfamiliar coinage

Recommendation: **Second Pass** as the product brand, `/audit` as the in-app command (brand and functional command can coexist cleanly).

## Current state

The project has moved well past the original Phase 4 plan. As of 2026-04-25, the substrate, consumers, CLI, and IDE-shape phase 1 are all shipping. Test status: 186 cargo + 172 TypeScript + 9 prism-audit binary tests passing; tsc clean.

**Substrate (eight cells, all shipping, Rust):** typecheck, ast_query, run_tests, http_fetch, e2e_run, lsp_diagnostics, schema_inspect, run_shell. Each cell has its own argv-override + per-call timeout knobs in `~/.config/prism/config.toml`, returns a structured payload (not free text), and contributes to a deterministic confidence grader. The grader — not the LLM — decides confidence: `confirmed` (compiler / LSP / runtime / test / schema), `probable` (AST), `candidate` (grep- or LLM-only). The `run_shell` cell is the one capability gap-fill among the eight: write tools (`write_file` / `edit_file`) and now `run_shell` are the only tools that hit the user-approval card; everything else is read-only or substrate-deterministic.

**Consumers (six modes, all shipping):** `/audit`, `/fix`, `/build`, `/refactor`, `/test-gen`, `/new`. Each ships with its own system prompt + prompt-contract tests pinning the language so future copy-edits can't silently regress the discipline.

**CLI (`prism-audit`):** standalone Rust binary that runs the substrate cells without an LLM. Three output formats (text / JSON / GitHub Actions). Exit codes 0/2 per a `--fail-on` policy. Same JSON sidecar shape as the GUI — interchangeable with `/fix`. Designed for CI gates.

**IDE shell:**
- Problems panel (right-side): renders findings grouped by file with severity + confidence + source chips. Click any finding → inline code window with the target line highlighted.
- File tree (left-side, IDE-shape phase 1, shipped today): gitignore-honored, lazy-loaded, keyboard-navigable. Click-to-preview overlay above the terminal. `.prism/` always visible (audit reports + sidecars surface natively); a Show-hidden toggle reveals other dotfiles when needed.
- Phases 2–4 in flight: tabbed CodeMirror editor with save-via-approval, inline squiggles fed by the same substrate, run/debug button row tied to the existing PTY blocks.

**Workflow infrastructure:** filesystem-as-database (`./.prism/second-pass/audit-*.md` + JSON sidecar per run); skills loader (`~/.prism/skills/` global + `./.prism/skills/` per-project); approval flow on every write; runtime-probe URL auto-detection; LSP server auto-detection from project shape; ORM auto-detection for schema_inspect.

**What's NOT built yet (deliberate):** in-editor inline squiggles (IDE phase 3), run/debug surface (IDE phase 4), telemetry / log probe (was queued as substrate v8 — now bumped to v9 since `run_shell` claimed v8), real multi-file refactor beyond rename, deploy/preview integration. System-prompt updates that teach `/new`, `/build`, and `/refactor` to use `run_shell` are queued as a separate review pass so the cell + plumbing PR stayed reviewable.

## The ask

*(Placeholder — to be filled in per-audience: fundraise, hiring, design partner, early customers, etc.)*

---

*Document owner: Steven Morales. Last updated: 2026-04-25.*
