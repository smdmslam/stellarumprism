// Mode registry.
//
// A "mode" is a persona-switched agent turn: same tools, same session,
// but a different system prompt and (optionally) a preferred model. The
// user invokes a mode via a slash command (e.g. `/audit`); the Rust side
// actually swaps the system prompt for that one OpenRouter call based
// on the mode name we pass.
//
// The system prompt bodies live in Rust (src-tauri/src/agent.rs) so
// there's a single source of truth. This file holds the UX metadata:
// which names are valid, what each mode is for, and which model it
// prefers when the user hasn't explicitly pinned one.
//
// Adding a future mode: add an entry here, add a matching constant + a
// match arm in agent.rs::agent_query, add a slash command in
// slash-commands.ts, wire the handler in workspace.ts::handleSubmit.

export interface Mode {
  /** Canonical mode name sent to Rust as the `mode` field on agent_query. */
  name: string;
  /** Slash-command aliases the user can type to invoke this mode. */
  aliases: string[];
  /**
   * Short, punchy description shown as the top line of the autocomplete
   * popup and in /help. Keep under ~50 chars so it doesn't truncate.
   */
  description: string;
  /**
   * Longer expandable description shown when the popup entry is focused.
   * Should cover what the mode does for the user (not how it works
   * internally), the default behavior, and scope/argument examples.
   */
  info?: string;
  /**
   * Model slug this mode prefers when the user hasn't pinned a specific
   * model. Rust also knows the default; this is here so the frontend can
   * show e.g. `[audit] grok-4.1-fast` in xterm before the request fires.
   */
  preferredModel: string;
}

export const MODES: Mode[] = [
  {
    name: "new",
    aliases: ["/new"],
    description: "Scaffold a fresh project from a stack description",
    info:
      "On-ramp consumer that hand-rolls a minimal, runnable project " +
      "skeleton. The agent verifies the target is empty, plans the file " +
      "list, and writes each file through the existing approval flow " +
      "(Prism has no shell-execution tool by design \u2014 no `pnpm " +
      "create vite`, no `cargo new`). Skeletons are minimal-but-runnable " +
      "and produce a SCAFFOLD REPORT with the install + dev-server " +
      "commands you should run next. Usage: '/new <project-name> <stack " +
      "description>' (e.g. '/new todo-app vite + react + typescript'). " +
      "Pass '--into=<dir>' to scaffold into a specific subdirectory " +
      "(default: <project-name>/); '--max-rounds=N' for very large " +
      "skeletons. Bare /new with no arguments still clears the chat " +
      "history. Uses claude-haiku-4.5 by default for precise " +
      "multi-file writes.",
    preferredModel: "anthropic/claude-haiku-4.5",
  },
  {
    name: "build",
    aliases: ["/build"],
    description: "Build a feature with substrate-gated generation",
    info:
      "Generation consumer of the substrate. Drives a plan \u2192 generate \u2192 " +
      "verify (typecheck + ast_query + run_tests) \u2192 iterate flow until the " +
      "feature lands. Every edit goes through the existing approval flow; " +
      "every verification step uses the substrate so 'compiles but breaks at " +
      "runtime' is caught before any commit. Usage: '/build <feature " +
      "description>'. Pass --max-rounds=N for very large features. Uses " +
      "claude-haiku-4.5 by default for precise multi-file edits.",
    preferredModel: "anthropic/claude-haiku-4.5",
  },
  {
    name: "fix",
    aliases: ["/fix"],
    description: "Apply findings from the latest audit report",
    info:
      "Reads the most recent .prism/second-pass/audit-*.json sidecar, lets " +
      "you select which findings to apply, and dispatches a fix-mode agent " +
      "that edits via the existing approval flow. Selectors: '/fix' or " +
      "'/fix all' = every finding; '/fix 1,3' = specific 1-based indices; " +
      "'/fix 1-5' = a range; '/fix #F2,#F4' = explicit Finding ids. Pass " +
      "'--report=<path>' to target a specific report instead of the latest. " +
      "Uses claude-haiku-4.5 by default for precise, surgical edits.",
    preferredModel: "anthropic/claude-haiku-4.5",
  },
  {
    name: "test-gen",
    aliases: ["/test-gen", "/testgen"],
    description: "Generate tests for an existing symbol",
    info:
      "Substrate-gated test generation. Uses ast_query to verify the " +
      "symbol exists, reads the declaration + neighboring test files " +
      "to learn the project's framework and style, plans test cases " +
      "(happy path / edge cases / error paths), and writes them through " +
      "the existing approval flow. A final run_tests confirms the new " +
      "tests pass without breaking the existing suite. Usage: " +
      "'/test-gen <symbol>'. Add '--file=<path>' to scope where the " +
      "tests live; '--framework=<vitest|jest|node|cargo|pytest|go>' to " +
      "override auto-detection. Uses claude-haiku-4.5 by default for " +
      "precise test edits.",
    preferredModel: "anthropic/claude-haiku-4.5",
  },
  {
    name: "refactor",
    aliases: ["/refactor"],
    description: "Rename an identifier across the project safely",
    info:
      "Substrate-gated identifier rename. Uses ast_query to locate the " +
      "declaration, grep to enumerate candidate references, and ast_query " +
      "again at each site to confirm same-symbol resolution (so shadowed " +
      "locals and unrelated symbols with the same spelling are left alone). " +
      "Edits go through the existing approval flow; a final typecheck " +
      "verifies the rename didn't break the build. Usage: '/refactor " +
      "<oldName> <newName>'. Add '--scope=<path>' to limit to one file or " +
      "directory; '--max-rounds=N' for very wide renames. Uses " +
      "claude-haiku-4.5 by default for precise multi-file edits.",
    preferredModel: "anthropic/claude-haiku-4.5",
  },
  {
    name: "review",
    aliases: ["/review"],
    description: "Cohesion review of recent commits (read-only)",
    info:
      "Read-only cohesion review focused on three bug classes that " +
      "grep-only audits routinely miss: (1) refactor cohesion \u2014 when a " +
      "recent commit deprecates an OLD pattern, flag remaining " +
      "occurrences across the whole repo; (2) helper-body inspection \u2014 " +
      "open the body of every helper called by recent code and flag " +
      "stubs / no-ops; (3) frontend\u2194backend schema round-trip \u2014 " +
      "verify persisted frontend fields have a matching server / Rust " +
      "struct field. Outputs a structured FINDINGS list (same format " +
      "as /audit) \u2014 no edits. Scope: '/review' alone reviews the last " +
      "20 commits. Pass a number ('/review 30') to review the last N, a " +
      "ref ('/review HEAD~3'), a range ('/review HEAD~5..HEAD'), or a " +
      "path ('/review @src/pages'). Pass --max-rounds=N for big reviews. " +
      "Uses grok-4.1-fast (2M context) by default.",
    preferredModel: "x-ai/grok-4.1-fast",
  },
  {
    name: "audit",
    aliases: ["/audit", "/second-pass"],
    description: "Verify code via the diagnostic substrate (read-only)",
    info:
      "Read-only verification that catches build and wiring failures editors miss. " +
      "Runs the project's actual typecheck/build (tsc / cargo check / pyright / " +
      "go build) FIRST, then cross-references compiler output with grep + " +
      "git_diff to surface stale barrels, dead imports, half-applied renames, " +
      "and call sites passing the wrong shape. Outputs a structured findings " +
      "list \u2014 no edits. " +
      "Scope: '/audit' alone audits the working tree vs HEAD. Pass a ref " +
      "('/audit HEAD~3') to audit the last N commits as one refactor, a " +
      "range ('/audit HEAD~5..HEAD'), or a path ('/audit @src/pages') to " +
      "scope to one file or directory. Pass --max-rounds=N for big audits. " +
      "Uses grok-4.1-fast (2M context) by default.",
    preferredModel: "x-ai/grok-4.1-fast",
  },
];

/** Resolve a slash command like `/audit` (or `/second-pass`) to a Mode. */
export function findMode(slashCommand: string): Mode | null {
  const q = slashCommand.trim().toLowerCase();
  if (q.length === 0) return null;
  for (const m of MODES) {
    if (m.aliases.some((a) => a.toLowerCase() === q)) return m;
    if (m.name.toLowerCase() === q) return m;
  }
  return null;
}
