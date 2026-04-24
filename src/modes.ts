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
   * show e.g. `[audit] grok-4-fast` in xterm before the request fires.
   */
  preferredModel: string;
}

export const MODES: Mode[] = [
  {
    name: "audit",
    aliases: ["/audit", "/second-pass"],
    description: "Audit code for refactor incompleteness (read-only)",
    info:
      "Read-only investigation that catches wiring gaps AI editors miss: " +
      "renamed symbols still referenced, dead imports, callers passing old " +
      "shapes to updated callees, half-applied renames. Outputs a structured " +
      "findings list \u2014 no edits. " +
      "Scope: '/audit' alone audits the working tree vs HEAD. Pass a ref " +
      "('/audit HEAD~3') to audit the last N commits as one refactor, a " +
      "range ('/audit HEAD~5..HEAD'), or a path ('/audit @src/pages') to " +
      "scope to one file or directory. Uses grok-4-fast (2M context) by " +
      "default.",
    preferredModel: "x-ai/grok-4-fast",
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
