// Pure helpers for the `/refactor` slash command.
//
// V1 scope: identifier rename. The user gives an old name and a new
// name; the agent uses `ast_query` to find the declaration, enumerates
// references with grep + ast_query verification, applies edits through
// the existing approval flow, and runs typecheck after to confirm
// nothing broke.
//
// Lives in its own file so the test runner can import this module
// without dragging in the UI surface (xterm, CodeMirror, Tauri APIs)
// from `workspace.ts`. The slash-command handler imports from here.

export interface ParsedRefactorArgs {
  /** Identifier the user wants to rename. Required. */
  oldName: string;
  /** New identifier. Required. */
  newName: string;
  /**
   * Optional path scope (relative to cwd or absolute). When set, the
   * refactor is limited to this file or directory. When omitted, the
   * agent operates project-wide.
   */
  scope?: string;
  /**
   * Per-call override for the agent's tool-round cap. When omitted,
   * the refactor mode's floor (80) and the user's
   * `agent.max_tool_rounds` config setting govern.
   */
  maxToolRounds?: number;
  /** Surfaces parse errors to the caller without throwing. */
  error?: string;
}

/**
 * Parse the argument tail of `/refactor ...`. Recognized shapes:
 *   /refactor <oldName> <newName>
 *   /refactor <oldName> <newName> --scope=<path>
 *   /refactor <oldName> <newName> --max-rounds=<N>
 *   /refactor <oldName> <newName> --scope <path> --max-rounds <N>
 *
 * Identifiers must look like identifiers (`[A-Za-z_$][A-Za-z0-9_$]*`)
 * to keep us out of the business of trying to rename arbitrary tokens.
 * Members like `Foo.bar` or selectors like `.btn-primary` are rejected
 * with a clear error so v2 can extend the grammar deliberately.
 */
export function parseRefactorArgs(raw: string): ParsedRefactorArgs {
  const empty: ParsedRefactorArgs = {
    oldName: "",
    newName: "",
  };
  if (!raw || !raw.trim()) {
    return {
      ...empty,
      error:
        "/refactor expects two identifiers (e.g. /refactor oldName newName). Use --scope=<path> to limit the rename to one file or directory.",
    };
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  let scope: string | undefined;
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
    const eqScope = /^--scope=(.+)$/.exec(t);
    if (eqScope) {
      scope = eqScope[1];
      continue;
    }
    if (t === "--scope") {
      const next = tokens[i + 1];
      if (next === undefined) {
        return {
          ...empty,
          error:
            "--scope expects a path (e.g. --scope=src/auth.ts or --scope src/pages)",
        };
      }
      scope = next;
      i++;
      continue;
    }
    positional.push(t);
  }

  if (positional.length < 2) {
    return {
      ...empty,
      error:
        "/refactor expects two identifiers: an old name and a new name (e.g. /refactor oldName newName)",
    };
  }
  if (positional.length > 2) {
    return {
      ...empty,
      error: `/refactor expects exactly two identifiers; got ${positional.length} (${positional
        .map((p) => `"${p}"`)
        .join(", ")}). Use --scope=<path> to limit the rename instead of passing extra positional args.`,
    };
  }
  const [oldName, newName] = positional;
  const idRe = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  if (!idRe.test(oldName)) {
    return {
      ...empty,
      error: `oldName "${oldName}" is not a plain identifier. v1 of /refactor only renames bare identifiers; member access (Foo.bar) and selectors (.btn-primary) are not yet supported.`,
    };
  }
  if (!idRe.test(newName)) {
    return {
      ...empty,
      error: `newName "${newName}" is not a plain identifier. v1 of /refactor only renames bare identifiers; member access (Foo.bar) and selectors (.btn-primary) are not yet supported.`,
    };
  }
  if (oldName === newName) {
    return {
      ...empty,
      error: `oldName and newName are identical ("${oldName}"). Nothing to rename.`,
    };
  }
  return { oldName, newName, scope, maxToolRounds };
}

/**
 * Wrap the parsed args into a refactor-mode user prompt. The
 * REFACTOR_SYSTEM_PROMPT on the Rust side carries the playbook; this
 * function frames the request so the model knows it's the start of a
 * refactor turn and has unambiguous input.
 */
export function buildRefactorPrompt(args: {
  oldName: string;
  newName: string;
  scope?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `Rename the identifier \`${args.oldName}\` to \`${args.newName}\` using the substrate-gated refactor flow defined in your system prompt.`,
  );
  lines.push("");
  lines.push(`old_name: ${args.oldName}`);
  lines.push(`new_name: ${args.newName}`);
  if (args.scope) {
    lines.push(`scope: ${args.scope}`);
    lines.push("");
    lines.push(
      `Limit the rename to the scope above. Do not edit files outside it.`,
    );
  } else {
    lines.push("scope: <project-wide>");
    lines.push("");
    lines.push(
      `Operate project-wide: every reference to \`${args.oldName}\` that resolves to the SAME declaration as the canonical one must be renamed. References that resolve to a different declaration (shadowed local, unrelated symbol with the same spelling) must be LEFT ALONE.`,
    );
  }
  lines.push("");
  lines.push(
    "Start by locating the declaration with ast_query op=resolve. Enumerate candidate references via grep, then verify each one with ast_query before editing. Apply edits through edit_file (each gated on user approval). After all edits, run typecheck to confirm. Produce the final RENAME REPORT block when done.",
  );
  return lines.join("\n");
}
