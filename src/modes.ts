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
  /** Short description shown in /help and the autocomplete popup. */
  description: string;
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
    description:
      "Second Pass \u2014 audit the repo (or a git range) for refactor incompleteness. Read-only; produces a structured findings list.",
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
