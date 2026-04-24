The strategy, sharpened

You're describing a classic wedge product play:

•  Wedge (blue ocean): Refactor auditor / wiring verifier. Distinct, sharp, underserved.
•  Expansion (disciplined red ocean): Full IDE. Once users are in Prism for audits, extending them into editing is a much easier sell than landing them cold against Cursor.

One-line positioning that captures it:

> Cursor edits. Antigravity executes. Prism verifies — and eventually everything.

The wedge earns the user's trust and daily-driver slot. The IDE expansion monetizes that slot. You don't ship an also-ran Cursor competitor on day one; you ship the tool nobody else is making, and grow into the big market from there.

The architectural commitment that makes this work

The trap is building the wedge in a way that forces a rewrite to add the IDE. We avoid that with three principles from day one:

Principle 1: Every audit-phase tool is also an IDE-phase tool

grep, find, git_diff, bulk_read are not audit-specific. Any IDE workflow benefits from them. So we're not investing in throwaway infrastructure — we're investing in the foundation the IDE sits on top of. Zero wasted work.

Principle 2: "Modes" are a first-class concept, not a regex hack

When we add /audit, we're really introducing the idea of a persona-switched agent turn: same tools, same session, but with a different system prompt and potentially a different preferred model. We'll want the same thing later for /explain, /debug, /test-gen, /review-pr, etc.

So instead of one-off slash commands, build a small mode registry:

{
  audit: { system_prompt: "...", preset: "long-context", tools: [...] },
  explain: { ... },
  debug: { ... },
}

One pattern, many applications. IDE phase adds more modes on the same rails.

Principle 3: Findings are structured from day one, rendered to xterm for now

Today we render audit findings as prose in the terminal. But the internal representation should be structured:

{
  "findings": [
    {
      "severity": "error" | "warning" | "info",
      "file": "src/foo.ts",
      "line": 42,
      "category": "broken_reference" | "dead_import" | "wiring_mismatch" | ...,
      "description": "...",
      "suggested_fix": "..."
    }
  ]
}

Today, that renders as an ANSI list in xterm. In the IDE phase, the exact same schema renders as a clickable Problems panel. Zero rework — just a new renderer.

Principle 4 (implicit): Keep the layout composable

The current layout has titlebar + tabs + workspace (blocks sidebar + content column). Don't hard-wire the content column to xterm. When IDE phase arrives, we'll replace the content column with a split pane (editor + terminal). Making sure Workspace doesn't assume "the content column is xterm" saves a layout refactor later.

The phased roadmap

Here's what I'd propose to carry us from today to IDE, in order:

Phase 4 — Audit tools + /audit mode (the wedge)
•  grep, find, git_diff, bulk_read tools
•  Mode registry infrastructure
•  /audit mode with structured findings output
•  Long-context preset (Grok 4 Fast / GPT-5.4) as default for audit mode
•  ANSI renderer for findings in xterm
•  Deliverable: a user can say /audit HEAD~3 and get a numbered wiring-audit report

Phase 5 — Audit polish + more modes
•  Findings persist to a per-tab list (re-queryable: "fix finding #3")
•  Additional modes: /explain, /review-pr, /test-gen
•  Project index tool (cached structure summary so the agent doesn't re-explore every turn)
•  Deliverable: audits feel like a conversation you return to, not a one-shot

Phase 6 — Editor surface (IDE wedge expansion begins)
•  CodeMirror editor pane behind a feature flag
•  File tree sidebar (replaces or complements blocks sidebar)
•  Split-pane layout (editor + terminal)
•  Inline Cmd+K agent edit on selection
•  Same agent, same tools — just a new surface to show files in
•  Deliverable: you can realistically consider staying in Prism for a coding session

Phase 7 — IDE polish
•  Diff viewer (findings from audits link directly to diffs)
•  Git UI (staging, commit, PR create)
•  Diagnostics from LSPs (squiggles)
•  Format-on-save
•  Problems panel (rendering of the same findings schema from Phase 4)
•  Deliverable: daily-driver IDE


What this means for the next commit

Nothing yet. We've just agreed on direction. What I'd suggest as the immediate next action:

Commit Phase 4 as a proper plan document before writing any code, because Phase 4 has enough scope (four new tools + mode infrastructure + new system prompt + structured findings + ANSI renderer) that a written plan prevents drift.

Want me to create that plan now? It'd cover:
•  The four new Rust tools (signatures, approval rules, caps)
•  Mode registry design (TS + Rust)
•  /audit system prompt (draft)
•  Findings schema + ANSI renderer
•  How long-context routing hooks into modes
•  Testing approach (can we unit-test audit on a known refactored repo?)
