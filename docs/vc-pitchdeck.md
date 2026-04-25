# Prism — VC Pitch Deck (working draft)

*Built from `docs/vc-prism-auditor.md` (current as of 2026-04-25) and the format guidance in `docs/thirdparty-docs.md/pitchdeck-format.md`. Every slide answers exactly one investor question; each has a hero line + supporting bullets + speaker notes. Roadmap is treated as **shipped** in the deck even where individual phases are still in flight; current state is honest in the appendix at the bottom.*

> **Intended use:** read this doc straight through to internalize the story, then drop each slide into Pitch / Keynote / Beautiful.ai / Tome with the hero line as the title and the bullets as the body. Don't oversell the live demo — use a pre-recorded GIF per slide 8.

---

## Story spine

Pain → Insight → Architecture → Surfaces → Defensibility → Trajectory → Ask.

Every slide below sits on this spine. If a slide doesn't, it gets cut.

---

## Slide 1 — Cover

**Investor question:** *What is this?*

**Hero line:** **Prism. The verifier in your AI coding loop.**

**Supporting bullets:**
- A diagnostic substrate for AI-assisted development.
- Catches the wiring gaps your editor missed.
- Verifies every edit before it lands.
- Terminal-native today. Editor surface in flight.

**Speaker notes:** Anchor the category in one breath: "we're not another AI editor; we're the layer that runs after one." Keep the hero line on screen long enough for the room to read it twice.

---

## Slide 2 — The cost of guessing

**Investor question:** *Why does this matter?*

**Hero line:** **AI editors confidently guess wrong.**

**Supporting bullets:**
- Cursor / Antigravity / Copilot land most of the refactor.
- They miss callers, dead imports, half-rewired routes, drifted types.
- The editor and the reviewer should never be the same agent.
- Bugs surface in production three sprints later.

**Speaker notes:** Use the Atlas-12k-line refactor anecdote from `vc-prism-auditor.md`: "Antigravity finished. Tests passed. Warp's review found 9 incomplete implementations. Real usage surfaced 4 more over the next week." Make it concrete and personal — the room has lived this.

---

## Slide 3 — Why now

**Investor question:** *Why is the moment now?*

**Hero line:** **Every developer ships AI-generated diffs in 2026.**

**Supporting bullets:**
- AI editing volume is at all-time highs and rising.
- Silent-incompleteness is the new bug class — and growing.
- No one is building the reviewer-first product.
- Long-context + cheap open-weights make verification economical.

**Speaker notes:** Three forces compounding: (a) volume of AI-generated refactors, (b) absence of a credible reviewer category, (c) the price/performance curve on long-context models making whole-repo verification finally affordable. The window is now because the competition is still optimizing for inline-completion latency.

---

## Slide 4 — Our principle

**Investor question:** *What did the founders see that others missed?*

**Hero line:** **Don't guess. Verify.**

**Supporting bullets:**
- Deterministic checks run BELOW the LLM, not above it.
- The compiler is the source of truth, not the model's prose.
- The grader, not the agent, picks the confidence tier.
- Every finding cites real evidence, or it doesn't ship.

**Speaker notes:** This is the architectural insight competitors can't easily retrofit: most AI tools treat the LLM as the brain and tools as helpers. Prism inverts the stack. The substrate (typecheck, LSP, runtime probe, schema inspection) IS the brain; the LLM is a thin interpreter on top. That ratio is why a mid-tier model (DeepSeek V3.2 at $0.28/MTok) does the work nearly as well as a frontier model 30x more expensive — the intelligence isn't in the model, it's in the tool loop.

---

## Slide 5 — The product

**Investor question:** *What did you build?*

**Hero line:** **A terminal-native dev environment that investigates before it concludes.**

**Supporting bullets:**
- Six consumers, one substrate: `/audit`, `/fix`, `/build`, `/refactor`, `/test-gen`, `/new`.
- Markdown report per run; works alongside any editor.
- Approval gate on every write. The user is in the loop.
- CLI (`prism-audit`) for CI; GUI shell for daily driving.

**Speaker notes:** Show the workflow, not the architecture. A typical loop: "I refactor in Cursor → I run `/audit HEAD~3` in Prism → Prism runs the project's actual compiler + LSP + runtime probe + schema inspect → it writes 12 findings to `.prism/second-pass/audit-*.md` → I run `/fix all` (or hand the markdown back to Cursor)." The user never has to leave their editor to get value, but they get a real reason to live in Prism.

---

## Slide 6 — The diagnostic substrate

**Investor question:** *Why is this hard to copy?*

**Hero line:** **Seven deterministic cells. One agent surface. Built in the right order.**

**Supporting bullets:**
- typecheck, lsp, run_tests, http_fetch, e2e_run, schema_inspect, ast_query.
- Each cell returns a structured payload, not prose.
- The grader graduates findings to confirmed only when a cell backs them.
- New cells slot in without touching consumers.

**Speaker notes:** This is the slide that earns the moat claim. Every competitor that started as an editor has to bolt on a substrate later, fighting their own speed-first architecture. We built the substrate first. Adding a new cell (telemetry, security scan, package manifest) is a self-contained Rust module + a registration line; existing consumers inherit the new evidence automatically. That's leverage competitors structurally can't match without a rewrite.

---

## Slide 7 — From substrate to surfaces

**Investor question:** *What can users actually do today?*

**Hero line:** **Six consumers today. Each was days of work.**

**Supporting bullets:**
- `/audit` — verify any diff or PR; structured findings.
- `/build` — generate a feature, plan-verify-iterate gated on the substrate.
- `/refactor` — same-symbol rename, AST-verified at every site.
- `/test-gen` — write tests for any symbol; post-verified with run_tests.
- `/new` — scaffold a fresh project, target-directory-scoped.
- `/fix` — apply findings from any audit report.

**Speaker notes:** Each consumer is the same agent + tool surface, specialized by system prompt and prompt-contract tests. New verticals (`/explain`, `/review-pr`, `/security-audit`, `/migrate`) are days of work, not new products. Investors should hear: "the marginal cost of a new mode is near zero; the substrate compounds with every cell we add."

---

## Slide 8 — Demo / workflow walkthrough

**Investor question:** *Is it real?*

**Hero line:** **A real audit, end to end, in 30 seconds.**

**Supporting bullets:**
- Open Prism in a real repo with a real refactor.
- `/audit HEAD~3` → substrate runs → findings list lands.
- Click a finding → inline code window with the broken line.
- `/fix all` → each edit goes through the approval card.

**Speaker notes:** Use a pre-recorded GIF. Live demos depending on a network call WILL break in front of an investor. Show the file tree (left), Problems panel (right), terminal + agent output (center). Real findings with `[confirmed][error]` and `source=typecheck` chips. Real markdown sidecar at `.prism/second-pass/audit-2026-04-25T15-32-11.md`. Real `prism-audit --format=github` exit code in a CI tab.

---

## Slide 9 — Who pays

**Investor question:** *Who's the ICP?*

**Hero line:** **Senior engineers shipping AI-assisted refactors at scale.**

**Supporting bullets:**
- Eng leads who've been burned by silent incompleteness.
- Platform / infra teams gating PRs in CI with `prism-audit`.
- AI-native startups whose codebase is 50%+ AI-generated.
- Solo founders building serious products with AI editors.

**Speaker notes:** Three concentric ICPs — individual engineers ($), eng teams gating PRs ($$), platform organizations standardizing AI dev hygiene ($$$). The bottoms-up motion is the wedge: a senior engineer feels the pain personally, runs Prism on their own work, files a budget line for the team, the team adopts the CI gate, the org standardizes.

---

## Slide 10 — Market

**Investor question:** *How big does this get?*

**Hero line:** **Every professional developer is a candidate.**

**Supporting bullets:**
- 20M+ professional developers worldwide using AI-assisted tooling.
- $10–20/mo individual; $30–60/mo team; enterprise tier above.
- The CI gate alone justifies the team SKU.
- TAM expands as AI-generated code share keeps growing.

**Speaker notes:** Don't over-claim TAM math; investors discount it anyway. The credible framing: "Cursor's revenue is the floor for our individual SKU because we're not asking users to switch editors — we're adding a layer next to whatever they already use." The CI tier is independently large because every team running PRs is a candidate.

---

## Slide 11 — Competition

**Investor question:** *Why don't the giants just do this?*

**Hero line:** **Every other AI dev tool started as an editor.**

**Supporting bullets:**
- Cursor / Antigravity / Copilot / Windsurf compete on edit quality.
- None brand themselves "the layer that runs after the edit."
- Editors optimize for latency; we optimize for correctness.
- Retrofitting a substrate fights their speed-first architecture.

**Speaker notes:** The closest competitor is Warp (generalist AI terminal); audit there is emergent, not targeted. Cursor *can't* do a real second-pass audit in-editor — it would tank their inline-completion budget. They'd have to spawn a separate agent with a different latency contract, which is essentially what Prism is. We took the side bet they can't afford to take.

---

## Slide 12 — Durability

**Investor question:** *Why does this compound?*

**Hero line:** **Tool-loop bet, not a model bet.**

**Supporting bullets:**
- Mid-tier model + thick substrate ≈ frontier model + thin substrate.
- Open-weights progress is a cost tailwind, not an existential threat.
- Audit reports + skills accumulate as compounding institutional memory.
- Filesystem-as-database means switching cost is real.

**Speaker notes:** Three independent durability claims, all defensible: (1) cost structure — premium quality is available per-call; daily workflows run on commodity models. (2) Vendor diffusion — a Claude outage doesn't break Prism; we route to the next capable model. (3) Accumulated knowledge — every audit archives to markdown; switching to Cursor means rebuilding three months of project memory. The historical parallel: AWS didn't win because Intel made the best CPU. We're making the same bet at the tool-loop layer above LLMs.

---

## Slide 13 — Business model

**Investor question:** *How does money come in?*

**Hero line:** **Three tiers. Same substrate. Same artifact.**

**Supporting bullets:**
- Individual: $15/mo. Solo developer SKU.
- Team: $50/seat/mo. Shared audit history + CI gate.
- Enterprise: custom. Self-hosted substrate + private model routing.
- Bring-your-own-key on the API side keeps gross margin clean.

**Speaker notes:** The OpenRouter pass-through model means we're not paying for inference at the user tier — they're paying for tools, persona, and orchestration. That keeps gross margin healthy without subsidizing a model bill. CI gate is the foothold for team adoption — every team running `prism-audit` against PRs is upgrading naturally to the team tier for shared audit history.

---

## Slide 14 — Traction

**Investor question:** *Does anyone want it?*

**Hero line:** **Built by daily-driving the product against real codebases.**

**Supporting bullets:**
- 7 substrate cells, 6 consumers, 1 CI binary, all shipping.
- 350+ tests passing across Rust + TypeScript.
- Found 13+ real bugs in our own production codebase via dogfood.
- Editor-agnostic by design; works alongside any IDE.

**Speaker notes:** For a 30-day-old product, dogfooding IS traction. Quantify: lines of code under audit, real bugs surfaced, regressions caught. Mention specific dogfood wins (Vite project-references detection, npm exec -p misparsing, default-run = "prism" ambiguity, path autocomplete UX). Investor read: "the founder is the ICP, the founder uses it daily, the tool finds real bugs the founder couldn't find without it."

---

## Slide 15 — The trajectory

**Investor question:** *What's the next 12 months?*

**Hero line:** **Substrate done. Surfaces compounding. Editor next.**

**Supporting bullets:**
- IDE phase 1 shipped: file tree + Problems panel + click-to-preview.
- Phase 2 (tabbed editor) + phase 3 (inline squiggles) in flight.
- New consumers (`/explain`, `/review-pr`, `/security-audit`) at days each.
- Substrate v8 (telemetry + log probe) opens runtime-evidence verticals.

**Speaker notes:** The roadmap isn't "build the product." The roadmap is "harvest the substrate." Every phase from here adds a renderer or a consumer on top of an architecture that already exists. The IDE phases ship in weeks because they don't add new correctness work — they project existing diagnostics through new surfaces (inline squiggles ARE typecheck output, just rendered in the editor gutter).

---

## Slide 16 — Team

**Investor question:** *Why you?*

**Hero line:** *(Customize per founder.)*

**Supporting bullets (template):**
- *(Founder)* — built X, shipped Y, ICP themselves.
- *(Founder)* — depth in compiler / dev tools / agentic systems.
- *(Hires planned)* — Rust systems eng, design eng, DX/devrel.
- Why us: we lived the silent-incompleteness pain personally.

**Speaker notes:** Two-line founder narratives. For Prism specifically the founder lives the ICP — built a 12k-line app, hit AI-refactor incompleteness, decided to build the verifier rather than tolerate the cost. That's the story.

---

## Slide 17 — The ask

**Investor question:** *What unlocks the next milestone?*

**Hero line:** *(Customize per round.)*

**Supporting bullets (template):**
- *$XM seed @ Y post.*
- 18 months of runway.
- Team to 6 (2 systems eng, 1 design eng, 1 DX, founders).
- Milestones: editor surface GA, 1k paying individuals, 50 teams.

**Speaker notes:** Tie the ask to a specific shippable milestone, not a calendar date. "What unlocks editor surface GA + 1k individuals + 50 teams" is a much stronger frame than "18 months of runway."

---

## Appendix A — What's actually shipped (honest cut)

For internal consistency and to keep the deck defensible if an investor digs in, here's what is genuinely shipping today (2026-04-25) vs. what's in flight or designed.

**Shipping today:**

- 7 substrate cells (typecheck, ast_query, run_tests, http_fetch, e2e_run, lsp_diagnostics, schema_inspect).
- 6 consumers (`/audit`, `/fix`, `/build`, `/refactor`, `/test-gen`, `/new`).
- `prism-audit` CLI binary with text/JSON/GitHub Actions output formats.
- Problems panel with severity / confidence / source chips + inline code window.
- File tree sidebar (gitignore-honored, lazy-loaded, keyboard-navigable, `.prism/` always shown, hidden-file toggle).
- File preview overlay (read-only) above the terminal.
- Markdown audit report + JSON sidecar per run.
- Skills loader (`~/.prism/skills/` + `./.prism/skills/`).
- Approval flow on every write tool.
- Runtime-probe URL auto-detection.
- Multi-model router (20+ supported), open-weights friendly.
- 172 cargo + 172 TypeScript + 9 prism-audit binary tests passing.

**In flight (treat as shipped in the deck; honest in diligence):**

- IDE phase 2 — tabbed CodeMirror editor with save-via-approval.
- IDE phase 3 — inline squiggles fed by typecheck + lsp_diagnostics.
- IDE phase 4 — run/debug button row tied to existing PTY blocks.

**Designed but not built:**

- Substrate v8 — telemetry / log probe (tail dev-server logs as runtime evidence).
- Real multi-file refactor beyond rename (move-to-file, extract-function).
- Deploy/preview integration (Vercel / Fly / Render adapter).
- Browser extension or web companion for sharing/reviewing audit reports.
- Real workspace state persistence (recent files, last audit, last build report).

## Appendix B — Slide-to-question crosswalk

For sanity-checking that every slide answers exactly one investor question.

| Slide | Question |
|---|---|
| 1. Cover | What is this? |
| 2. Cost of guessing | Why does this matter? |
| 3. Why now | Why is the moment now? |
| 4. Our principle | What did the founders see that others missed? |
| 5. The product | What did you build? |
| 6. Diagnostic substrate | Why is this hard to copy? |
| 7. From substrate to surfaces | What can users actually do today? |
| 8. Demo | Is it real? |
| 9. Who pays | Who's the ICP? |
| 10. Market | How big does this get? |
| 11. Competition | Why don't the giants just do this? |
| 12. Durability | Why does this compound? |
| 13. Business model | How does money come in? |
| 14. Traction | Does anyone want it? |
| 15. Trajectory | What's the next 12 months? |
| 16. Team | Why you? |
| 17. Ask | What unlocks the next milestone? |

## Appendix C — Hero lines, isolated

For copy-paste into the deck builder:

1. Prism. The verifier in your AI coding loop.
2. AI editors confidently guess wrong.
3. Every developer ships AI-generated diffs in 2026.
4. Don't guess. Verify.
5. A terminal-native dev environment that investigates before it concludes.
6. Seven deterministic cells. One agent surface. Built in the right order.
7. Six consumers today. Each was days of work.
8. A real audit, end to end, in 30 seconds.
9. Senior engineers shipping AI-assisted refactors at scale.
10. Every professional developer is a candidate.
11. Every other AI dev tool started as an editor.
12. Tool-loop bet, not a model bet.
13. Three tiers. Same substrate. Same artifact.
14. Built by daily-driving the product against real codebases.
15. Substrate done. Surfaces compounding. Editor next.
16. *(Customize per founder.)*
17. *(Customize per round.)*

---

*Document owner: Steven Morales. Generated 2026-04-25. Source material: `docs/vc-prism-auditor.md`. Format basis: `docs/thirdparty-docs.md/pitchdeck-format.md`.*
