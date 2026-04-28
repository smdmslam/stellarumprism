// Registry of all slash commands, driving both the autocomplete popup and
// (eventually) a built-in /help listing. Keep these in sync with the handlers
// in `workspace.ts`.

import { MODEL_LIBRARY } from "./models";
import { MODES } from "./modes";
import { RECIPES } from "./recipes";
import { settings } from "./settings";

export interface SlashCommand {
  /** The full command typed, including the leading slash. */
  label: string;
  /** Short one-line description shown in the popup. */
  detail: string;
  /** Longer description shown when the item is focused (optional). */
  info?: string;
  /** If true, the command expects an argument \u2014 we append a trailing space. */
  takesArg?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    label: "/ask",
    detail: "Ask the AI agent a question",
    info: "Forces the next submission to be routed to the AI agent, even if it looks like a shell command. Example: /ask how do I find big files?",
    takesArg: true,
  },
  {
    label: "/cmd",
    detail: "Run as shell command",
    info: "Forces the next submission to be sent to the shell, even if it looks like a question. Example: /cmd how",
    takesArg: true,
  },
  {
    label: "/model",
    detail: "Switch AI model",
    info: "Change the model used by the agent. Accepts a short alias (haiku, kimi, glm-5, gpt-oss, deepseek, \u2026) or a full OpenRouter slug. Example: /model glm-5",
    takesArg: true,
  },
  {
    label: "/models",
    detail: "List available models",
    info: "Prints the curated model library in the terminal with their short aliases and descriptions.",
  },
  {
    label: "/clear",
    detail: "Clear chat history",
    info: "Clears the current tab's conversation history so the next /ask starts from nothing. Same as bare /new (with no arguments). Use /new <project-name> <stack> to scaffold a project instead.",
  },
  {
    label: "/history",
    detail: "Show conversation history",
    info: "Prints the current tab's user/assistant messages inline in the terminal.",
  },
  {
    label: "/save",
    detail: "Save chat to markdown",
    info: "Opens a file dialog to save the current chat to a .md file. Default location: <project>/.prism/chats/ when a project cwd is known, otherwise ~/Documents/Prism/Chats/. The directory is created on demand. Use `/save full` (or `/save --full`) to write the v2 tool-aware format that preserves assistant tool_calls + tool results so a loaded session can be truly continued by another model. Filename gets a `.full.md` extension in that mode.",
    takesArg: true,
  },
  {
    label: "/load",
    detail: "Load chat from markdown",
    info: "Opens a file dialog to load a previously /save'd chat into this tab. Replaces any existing in-memory history; /save first if you want to keep the current conversation. The saved title is adopted and the model used at save time is reported (use /model to switch).",
  },
  {
    label: "/cd",
    detail: "Change shell directory",
    info: "Navigate the current shell to a folder. Tab/click to autocomplete folder names. Spaces in paths are handled automatically.",
    takesArg: true,
  },
  {
    label: "/verify",
    detail: "Toggle reviewer pass",
    info: "Controls the secondary review of agent answers. Usage: /verify on, /verify off, /verify <model> to set the reviewer model, or /verify alone to print the current setting.",
    takesArg: true,
  },
  {
    label: "/help",
    detail: "Show this list",
  },
  {
    label: "/problems",
    detail: "Toggle the Problems panel",
    info: "Open / close / clear the right-side Problems panel that lists the latest audit's findings grouped by file. Auto-opens after /audit completes. Args: show, hide, toggle (default), clear.",
    takesArg: true,
  },
  {
    label: "/files",
    detail: "Switch sidebar to the file tree",
    info: "Show the project file tree in the left sidebar and focus it for keyboard navigation (arrow keys, Enter to open). Click a file to preview its top \u223c80 lines inline above the terminal; click again to open it in the editor (phase 2). The tree honors .gitignore and lazy-loads each subdirectory on expand.",
  },
  {
    label: "/last",
    detail: "Show last audit + last build",
    info: "Print a compact summary of the workspace's persisted state.json: the most recent /audit and the most recent build/new/refactor/test-gen completion, with paths to their full reports under .prism/.",
  },
  {
    label: "/protocol",
    detail: "Run a named protocol (recipe orchestrator)",
    info:
      "Run an ordered recipe of slash + shell steps and persist a " +
      "consolidated Markdown report to ~/Documents/Prism/Reports/. Bare " +
      "/protocol lists the available recipes; pass an id to run one. " +
      "Built-in recipes: refactor-cohesion-review, harden, pre-ship-check, " +
      "wiring-gap-audit. The toolbar UI (Phase D) will surface these " +
      "without requiring users to know the slash command.",
    takesArg: true,
  },

  // -- Modes (persona-switched agent turns) -------------------------------
  // Each mode contributes its primary alias as a slash command. Additional
  // aliases are still accepted by the handler in workspace.ts; they're
  // just not duplicated in the popup to keep it tidy.
  ...MODES.map<SlashCommand>((m) => ({
    label: m.aliases[0],
    detail: m.description,
    info:
      m.info ??
      `Runs this turn in '${m.name}' mode. Defaults to ${m.preferredModel}.`,
    takesArg: true,
  })),
];

/** Render the help listing as an ANSI-colored block for the xterm output. */
export function renderHelpAnsi(): string {
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const CYAN = "\x1b[36m";
  const out: string[] = [];
  out.push(`${BOLD}Slash commands${RESET} ${DIM}(type / to see this inline)${RESET}\r\n`);
  for (const c of SLASH_COMMANDS) {
    const label = `${CYAN}${c.label}${c.takesArg ? " \u2039arg\u203a" : ""}${RESET}`.padEnd(40, " ");
    out.push(`  ${label} ${DIM}${c.detail}${RESET}\r\n`);
  }
  out.push("\r\n");
  out.push(`${BOLD}Tips${RESET}\r\n`);
  out.push(`  ${DIM}\u2022 ${CYAN}?question${RESET}${DIM} is shorthand for /ask${RESET}\r\n`);
  out.push(`  ${DIM}\u2022 Trailing ${CYAN}?${RESET}${DIM} on a sentence also triggers agent mode${RESET}\r\n`);
  out.push(`  ${DIM}\u2022 Ctrl+K toggles sticky agent mode for the whole tab${RESET}\r\n`);
  return out.join("");
}

/**
 * Recipe ids surfaced when the user types `/protocol <space>`. Each
 * entry's label is the recipe id (typed verbatim by the user); the
 * detail line shows the human label + category, and `info` carries
 * the blurb so the second-line description renders Discord-style.
 * Mirrors `modelCompletions()` so the editor can use the same source
 * pattern for both.
 */
export function recipeCompletions(): {
  label: string;
  detail: string;
  info: string;
}[] {
  return RECIPES.map((r) => ({
    label: r.id,
    detail: `${r.label} \u00b7 ${r.category}`,
    info: r.blurb,
  }));
}

/** Aliases for /model, flattened into the list shown when user types `/model `. */
export function modelCompletions(): {
  label: string;
  detail: string;
  info: string;
}[] {
  // Only show models that are enabled in Settings and are not internal backends.
  // `m.enabled !== false` is the registry default; the settings store
  // overrides it on a per-user basis.
  return MODEL_LIBRARY.filter(
    (m) =>
      m.tier !== "backend" &&
      settings.isModelEnabled(m.slug, m.enabled !== false),
  ).map((m) => ({
    label: m.aliases[0],
    // Append "[img]" to the slug shown on row 1 when the model supports images.
    detail: m.vision ? `${m.slug} [img]` : m.slug,
    info: m.description,
  }));
}
