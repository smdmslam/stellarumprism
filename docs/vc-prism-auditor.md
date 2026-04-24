# Prism — Second Pass

*A verification layer for AI-generated code. Catches the wiring gaps your editor missed.*

> **Cursor edits. Antigravity executes. Prism verifies.**

## TL;DR

AI coding tools (Cursor, Antigravity, Copilot) are now good enough to execute large refactors. They are **not** good enough to execute them completely. Every meaningful refactor ships with incomplete renames, dangling references, half-rewired call sites, and dead imports — and the very tool that made the refactor is the wrong tool to audit it.

**Prism Second Pass** is a terminal-native AI verifier whose entire job is to catch what the editor missed. It reads the whole repo (or the specific diff), cross-references every symbol touched by the refactor, and produces a structured findings report: *what's broken, where, and how to fix it*.

It's not an IDE. It's the tool you run **after** your IDE.

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

Prism Second Pass is a dedicated verification agent with three things the editor doesn't have:

1. **Audit-tuned tooling.** `grep`, `find`, `git_diff`, `bulk_read` over the real filesystem — not an in-editor proxy. The agent can enumerate every caller of a symbol, diff against any git reference, and read dozens of files in a single pass.
2. **Long-context routing by default.** Audits route to 1M–2M context models (Grok 4 Fast, GPT-5.4) so the whole repo fits. No chunking, no progressive-rediscovery tax.
3. **A review persona, not an edit persona.** The system prompt explicitly forbids edits and instructs the agent to produce a structured findings list: `[severity] file:line — description — suggested fix`. The output isn't prose; it's a checklist you work through.

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

## Expansion path

Second Pass is the wedge. It earns the daily-driver slot through a narrow, sharp, underserved capability. Once users are in Prism for audits, two expansions become natural:

**Adjacent modes** (weeks, not months):

- `/explain` — produce a narrated walkthrough of code or a diff
- `/review-pr` — audit-style review scoped to a PR branch
- `/test-gen` — generate tests for the surface area a refactor touched
- `/debug` — interactive root-cause analysis for a failure

Each is the same agent + tool set + structured output pattern, specialized by system prompt. Near-zero marginal engineering cost.

**Editor surface** (months):

Once users live in Prism for verification-adjacent work, extending them into editing is a much smaller leap than landing them cold against Cursor. The IDE phase adds:

- CodeMirror editor pane
- File tree
- Inline `Cmd+K` agent edit on selection
- Git UI, diff viewer, LSP diagnostics (which render as the same findings schema from Second Pass)

This is the classic Cursor play run in reverse: Cursor started as an editor and grew into a reviewer. Prism starts as a reviewer and grows into an editor. In a crowded editor market, the reviewer wedge is the cheaper door in.

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

- Prism the underlying tool exists and is usable: multi-model agent, tool loop with read/write/web_search, approval flow, shell integration, multi-tab.
- Second Pass as a dedicated capability is Phase 4 on the roadmap — not yet built.
- Phase 4 scope:
  - Four new Rust tools: `grep`, `find`, `git_diff`, `bulk_read`
  - Mode registry (persona + system prompt + preferred preset, reusable for future `/explain`, `/review-pr`, `/test-gen`, `/debug`)
  - `/audit` mode with specialized system prompt and long-context default preset (Grok 4 Fast, GPT-5.4)
  - Structured findings schema + ANSI renderer for xterm
  - **Markdown report output** to `./.prism/second-pass/audit-<timestamp>.md` — the durable handoff artifact
  - **Skills loader**: `~/.prism/skills/` + `./.prism/skills/` conventions, `/skill <name>` command, optional auto-load via frontmatter
  - `/fix <range>` follow-up command that lets Prism fix findings in-app via the existing approval flow
- Estimated build time: 2–3 focused weeks to a shippable v1.

## The ask

*(Placeholder — to be filled in per-audience: fundraise, hiring, design partner, early customers, etc.)*

---

*Document owner: Steven Morales. Last updated: 2026-04-24.*
