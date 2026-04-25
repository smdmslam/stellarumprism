// Pure helpers for the `/new` slash command (project scaffolder).
//
// V1 scope: scaffold a fresh project skeleton from a natural-language
// stack description. The agent hand-rolls every file via the existing
// `write_file` / `edit_file` approval flow \u2014 we deliberately do NOT
// run external scaffolding CLIs (no `pnpm create vite`, no
// `cargo new`) because Prism has no general-purpose shell-execution
// tool by design. Every file lands inside a target subdirectory of
// cwd (default: `<project-name>/`) so an existing project is never
// paved over.
//
// Lives in its own file so the test runner can import this module
// without dragging in the UI surface (xterm, CodeMirror, Tauri APIs)
// from `workspace.ts`. The slash-command handler imports from here.

export interface ParsedNewArgs {
  /**
   * The project name (becomes the default scaffold subdirectory).
   * Required. Must be a filesystem-safe slug \u2014 letters, digits,
   * `-`, `_`, `.`. Member access (`Foo.bar`) and path-prefixed
   * forms (`a/b/c`) are rejected; the scaffolder writes into a
   * single subdirectory of cwd, not nested paths.
   */
  projectName: string;
  /**
   * Free-form description of the stack the user wants. Joined from
   * the trailing tokens after the project name; preserved verbatim
   * so the agent can interpret it ("vite + react + typescript",
   * "express api with prisma", "rust cli for parsing markdown",
   * "fastapi + sqlalchemy", etc.). Empty when the user gave only a
   * name \u2014 the agent then asks-by-acting (reads cwd for hints) or
   * picks the simplest sensible default.
   */
  description: string;
  /**
   * When set, scaffold INTO this directory instead of `<projectName>/`.
   * Pass `--into=.` to scaffold directly into cwd (only safe when
   * cwd is empty). Pass `--into=apps/web` for monorepo layouts.
   */
  into?: string;
  /**
   * Per-call override for the agent's tool-round cap. When omitted,
   * the new mode's floor (100, same as build) and the user's
   * `agent.max_tool_rounds` config setting govern.
   */
  maxToolRounds?: number;
  /** Surfaces parse errors to the caller without throwing. */
  error?: string;
}

/**
 * Allowed shape for the project-name slug. Letters, digits, dot,
 * dash, underscore. Leading dot is rejected (would make the
 * scaffold a hidden directory by default \u2014 almost certainly not
 * what the user meant); leading dash is rejected (looks like a CLI
 * flag); leading or trailing dash anywhere makes the name
 * shell-hostile so we trim those at the boundaries. No path
 * separators \u2014 a project name like `foo/bar` is rejected because
 * the scaffolder writes ALL files under a single subdirectory and
 * `--into` is the right knob for nested layouts.
 */
const PROJECT_NAME_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/;

/**
 * Parse the argument tail of `/new ...`. Recognized shapes:
 *   /new <project-name>
 *   /new <project-name> <stack description \u2026>
 *   /new <project-name> --into=<dir>
 *   /new <project-name> --max-rounds=<N>
 *   (space-form variants of all flags also accepted)
 *
 * Bare `/new` (no args) is handled elsewhere in `workspace.ts` and
 * means "clear conversation history". This parser is only called
 * when args are present, so the empty-args case is reported as an
 * error rather than the legacy clear-session behavior.
 */
export function parseNewArgs(raw: string): ParsedNewArgs {
  const empty: ParsedNewArgs = { projectName: "", description: "" };
  if (!raw || !raw.trim()) {
    return {
      ...empty,
      error:
        "/new expects a project name and an optional stack description (e.g. /new todo-app vite + react + typescript). Bare /new with no arguments clears the conversation history instead.",
    };
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  let into: string | undefined;
  let maxToolRounds: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eqRounds = /^--max-rounds=(.+)$/.exec(t);
    if (eqRounds) {
      const n = Number(eqRounds[1]);
      if (!Number.isFinite(n) || n < 1) {
        return {
          ...empty,
          error: `--max-rounds expects a positive integer, got "${eqRounds[1]}"`,
        };
      }
      maxToolRounds = Math.floor(n);
      continue;
    }
    if (t === "--max-rounds") {
      const next = tokens[i + 1];
      if (next === undefined) {
        return {
          ...empty,
          error: "--max-rounds expects a value (e.g. --max-rounds=120)",
        };
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        return {
          ...empty,
          error: `--max-rounds expects a positive integer, got "${next}"`,
        };
      }
      maxToolRounds = Math.floor(n);
      i++;
      continue;
    }
    const eqInto = /^--into=(.+)$/.exec(t);
    if (eqInto) {
      into = eqInto[1];
      continue;
    }
    if (t === "--into") {
      const next = tokens[i + 1];
      if (next === undefined) {
        return {
          ...empty,
          error: "--into expects a directory path (e.g. --into=apps/web or --into=.)",
        };
      }
      into = next;
      i++;
      continue;
    }
    positional.push(t);
  }

  if (positional.length === 0) {
    return {
      ...empty,
      error:
        "/new expects a project name (e.g. /new todo-app vite + react + typescript)",
    };
  }
  const projectName = positional[0];
  if (!PROJECT_NAME_RE.test(projectName)) {
    return {
      ...empty,
      error: `project name "${projectName}" is not a filesystem-safe slug. Use letters, digits, '.', '-', '_' only. Pass --into=<dir> for nested layouts (e.g. --into=apps/web).`,
    };
  }
  const description = positional.slice(1).join(" ").trim();
  return { projectName, description, into, maxToolRounds };
}

/**
 * Wrap the parsed args into a new-mode user prompt. The
 * NEW_SYSTEM_PROMPT on the Rust side carries the playbook; this
 * function frames the request so the model knows it's the start of
 * a scaffold turn and has unambiguous input. The target directory
 * line is the most important part of the framing \u2014 it's the
 * guardrail that stops the agent from paving over the surrounding
 * project.
 */
export function buildNewPrompt(args: {
  projectName: string;
  description: string;
  into?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `Scaffold a new project using the substrate-gated flow defined in your system prompt.`,
  );
  lines.push("");
  lines.push(`project_name: ${args.projectName}`);
  const target = args.into ?? `${args.projectName}/`;
  lines.push(`target_directory: ${target}`);
  if (args.description) {
    lines.push(`stack_description: ${args.description}`);
  } else {
    lines.push(
      `stack_description: <none provided \u2014 ask by acting (read cwd shape, pick simplest sensible default; surface your choice in the SCAFFOLD REPORT)>`,
    );
  }
  lines.push("");
  lines.push(
    `Start by VERIFYING the target directory is empty (or non-existent) so you don't pave over existing files. If it exists with content, STOP and surface 'target directory is not empty' \u2014 do NOT auto-overwrite. Then PLAN the file list, EXECUTE writes through the approval flow, VERIFY with typecheck (when applicable), and produce the SCAFFOLD REPORT block when done.`,
  );
  return lines.join("\n");
}
