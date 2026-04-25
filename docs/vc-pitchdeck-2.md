**SLIDE 01 — COVER**
`STELLARUM / PRISM · SEED ROUND · 2026`

# The verifier in your AI coding loop.

*Not a chatbot. Not an editor. The layer that runs after one.*

**SYSTEM SPEC · MVP 1 SHIPPED**
— 7 substrate cells
— 6 consumers
— IDE surface (file tree · editor · squiggles)
— Persistent workspace spine
— 400+ tests passing
— $0.28 /MTok inference
— 2m 42s audit runtime

---

**SLIDE 02 — THE PROBLEM**
`SLIDE 02 · THE PROBLEM`

# AI editors confidently guess wrong. Then they forget.

**REAL INCIDENT · ATLAS 12K-LINE REFACTOR**
Antigravity finished. Tests passed. Warp's review found 9 incomplete implementations. Real usage surfaced 4 more over the following week.

**MISSED CALLERS** — Functions renamed; callers still reference old signature
**DEAD IMPORTS** — Removed exports leave stale import chains
**DRIFTED TYPES** — Type signatures diverge silently from implementations
**HALF-REWIRED ROUTES** — API routes point to handlers that no longer exist

**AND THEN THE TAB CLOSES**
The reviewer ran. The fixes shipped. Three days later the chat scrolls away and you've lost the plan, the findings, and the build report. Every AI tool today is a write-once memory.

*The editor and the reviewer should never be the same agent — and the workspace should remember what they found.*

---

**SLIDE 03 — WHY NOW**
`SLIDE 03 · TIMING`

# Every developer ships AI-generated diffs in 2026.

**01 — VOLUME**
AI editing volume is at all-time highs and accelerating. Cursor, Copilot, Antigravity each handle thousands of diffs daily.

**02 — NEW BUG CLASS**
Silent-incompleteness is the bug type no linter catches — only a reviewer layer trained on your actual compiler output can.

**03 — ECONOMICS**
Long-context + cheap open-weights make whole-repository verification finally affordable at $0.28/MTok.

*The window is now — competition is still optimising for inline-completion latency.*

---

**SLIDE 04 — OUR PRINCIPLE**
`SLIDE 04 · ARCHITECTURAL INSIGHT`

# DON'T GUESS.
# VERIFY.

```
LLM  →  thin interpreter
typecheck · lsp · run_tests · schema_inspect · ast_query
```
← INVERTED STACK · THE SUBSTRATE IS THE BRAIN · LLM IS A THIN INTERPRETER ON TOP

A mid-tier model at $0.28/MTok performs near-frontier — because intelligence lives in the tool loop, not the model.

---

**SLIDE 05 — THE PRODUCT**
`SLIDE 05 · THE PRODUCT`

# A terminal-native dev environment that investigates before it concludes.

**TYPICAL LOOP**
Refactor in Cursor → /audit HEAD~3 → substrate runs → findings land → click a file → squiggles in the editor → /fix all → approval gate → /save the plan

**CONSUMERS**
**/audit** — Verify any diff or PR; structured findings
**/fix** — Apply findings from any audit report
**/build** — Generate a feature; plan-verify-iterate gated
**/refactor** — AST-verified rename at every call site
**/test-gen** — Write tests; post-verified with run_tests cell
**/new** — Scaffold a fresh project, directory-scoped

**IDE SURFACE · MVP 1**
▸ File tree (gitignore-aware, lazy-loaded)
▸ CodeMirror editor (Cmd+S, mtime-safe writes)
▸ Inline audit squiggles (gutter + wavy underline)
▸ Resizable panes (drag · double-click snap · Cmd+Opt+[ / ])
▸ /save · /load · /last (chat round-trip + spine summary)

*Markdown report per run · Approval gate on every write · Works alongside any editor*

---

**SLIDE 06 — THE DIAGNOSTIC SUBSTRATE**
`SLIDE 06 · DEFENSIBILITY`

# Seven deterministic cells. One agent surface. Built in the right order.

**typecheck** — compiler as source of truth
**lsp_diag** — live editor diagnostics
**run_tests** — post-edit regression gate
**ast_query** — structural code understanding
**schema_inspect** — DB / API contract verification
**http_fetch** — runtime endpoint probe
**e2e_run** — full-stack integration gate

**THE MOAT**
Competitors started as editors. They'll need a rewrite to bolt on a substrate. We built the substrate first — every new cell compounds for all consumers.

*New cells slot in without touching consumers. Competitors can't retrofit a substrate on a speed-first architecture.*

---

**SLIDE 07 — THE WORKSPACE SPINE**
`SLIDE 07 · COMPOUNDING MEMORY`

# The filesystem is the database. Every project remembers itself.

```
<cwd>/.prism/
  state.json          last_audit · last_build · recent files · layout
  second-pass/        audit-<ts>.md  +  audit-<ts>.json
  builds/             build-<ts>.md  +  build-<ts>.json
```

**WHAT THE SPINE BUYS**
▸ Reopen a tab — Problems panel hydrates from the previous session, no re-audit
▸ /last — one line summarising the most recent audit + build, anywhere in the project
▸ /save + /load — chat tabs round-trip to markdown; load a plan from yesterday into a fresh tab
▸ Layout persists per workspace — sidebar, problems panel, preview pane sizes all sticky
▸ CI artifact and GUI artifact are the same JSON — `prism-audit` in CI feeds /fix in the GUI

**WHY IT'S A MOAT**
Switching to Cursor means rebuilding three months of project memory. Every audit, every build report, every plan accumulates as institutional knowledge inside the repo — versioned in git if the team wants it.

*Atomic writes · schema-versioned · cwd-change-driven hydration · corrupt files self-heal on next run.*

---

**SLIDE 08 — MARKET + BUSINESS MODEL**
`SLIDE 08 · MARKET + BUSINESS MODEL`

# Every professional developer is a candidate.

**20M+** professional devs using AI-assisted tooling
**↑ ∞** AI-generated code share — still climbing
**$0** credible reviewer-first product exists today

**PRICING TIERS**

| Tier | Price | Note |
|------|-------|------|
| Individual | $15 / mo | Solo developer SKU |
| Team | $50 / seat / mo | Shared audit history + CI gate |
| Enterprise | Custom | Self-hosted + private model routing |

---

**SLIDE 09 — TRACTION + TRAJECTORY**
`SLIDE 09 · TRACTION + TRAJECTORY`

# Substrate done. IDE shipped. Compounding now.

**SHIPPING → NOW (MVP 1)**
▸ 7 substrate cells, 6 consumers, 1 CI binary
▸ IDE surface — file tree, editable buffer, inline audit squiggles, resizable panes
▸ Persistent workspace spine — last audit, last build, layout, recent files
▸ Chat /save + /load round-trip
▸ 400+ tests passing (Rust + TypeScript)
▸ 13+ real bugs found via dogfood
▸ 20+ model router — open-weights friendly

**ROADMAP**

| Phase | Detail | Status |
|-------|--------|--------|
| IDE Phase 2 | Editable CodeMirror buffer + Cmd+S | SHIPPED |
| IDE Phase 3 | Inline audit squiggles + gutter markers | SHIPPED |
| Workspace spine | state.json + builds sidecars + chat round-trip | SHIPPED |
| Resizable layout | Drag / snap / keyboard nudge / persisted | SHIPPED |
| Substrate v8 | Telemetry/log probe — runtime evidence verticals | DESIGNED |
| /explain + /review-pr | New consumers — days of work on existing substrate | DESIGNED |
| Multi-file refactor | Move-to-file, extract-function | DESIGNED |
| 1K paying individuals | Bottoms-up wedge — eng → team → org | TARGET |
| 50 teams on CI gate | Budget-line trigger for team SKU upgrade | TARGET |

---

**SLIDE 10 — THE ASK**
`SLIDE 10 · THE ASK`

# Seed round.
18 months. Team to 6. Substrate v8 + enterprise pilots.

| Date | Milestone | Note |
|------|-----------|------|
| Q3 2026 | /explain + /review-pr ship | New consumers on existing substrate |
| Q4 2026 | 1,000 paying individual users | Bottoms-up motion validates pricing |
| Q1 2027 | 50 teams on CI gate | Team SKU upgrade trigger proven |
| Q2 2027 | Substrate v8 + enterprise pilots | Runtime-evidence verticals unlocked |

*Prism · prism.dev · steven@dmwfinancegroup.com*

**DON'T GUESS. VERIFY.**
