// Pure helpers for the `/test-gen` slash command.
//
// V1 scope: generate tests for a single existing symbol in the user's
// project. The agent uses ast_query to verify the symbol exists,
// read_file to learn its signature + neighboring test style, edit_file
// (or write_file) to add tests gated on approval, and run_tests to
// confirm the new tests pass without breaking the existing suite.
//
// Lives in its own file so the test runner can import this module
// without dragging in the UI surface (xterm, CodeMirror, Tauri APIs)
// from `workspace.ts`. The slash-command handler imports from here.

/**
 * Test framework hint the user can pass via --framework. The agent
 * also auto-detects from package.json + existing test files; this
 * override is for the rare case where detection misfires.
 */
export type TestFrameworkHint =
  | "vitest"
  | "jest"
  | "node"
  | "cargo"
  | "pytest"
  | "go";

export interface ParsedTestGenArgs {
  /** The symbol the user wants tests for. Required. */
  symbol: string;
  /**
   * Optional path scope. When set, restricts the agent to writing
   * tests in/near the file (e.g. `src/auth/login.ts` → tests live
   * next to that file). When unset, the agent picks based on
   * project conventions.
   */
  file?: string;
  /** Optional framework override. */
  framework?: TestFrameworkHint;
  /**
   * Per-call override for the agent's tool-round cap. When omitted,
   * the test-gen mode's floor (80) and the user's
   * `agent.max_tool_rounds` config setting govern.
   */
  maxToolRounds?: number;
  /** Surfaces parse errors to the caller without throwing. */
  error?: string;
}

const FRAMEWORK_VALUES: ReadonlySet<string> = new Set([
  "vitest",
  "jest",
  "node",
  "cargo",
  "pytest",
  "go",
]);

/**
 * Parse the argument tail of `/test-gen ...`. Recognized shapes:
 *   /test-gen <symbol>
 *   /test-gen <symbol> --file=<path>
 *   /test-gen <symbol> --framework=<vitest|jest|node|cargo|pytest|go>
 *   /test-gen <symbol> --max-rounds=<N>
 *   (space-form variants of all flags also accepted)
 *
 * The symbol must look like a plain identifier
 * (`[A-Za-z_$][A-Za-z0-9_$]*`). Member access (`Foo.bar`) and
 * file-prefixed forms (`auth.ts:login`) are rejected with a precise
 * error so v2 can extend the grammar deliberately.
 */
export function parseTestGenArgs(raw: string): ParsedTestGenArgs {
  const empty: ParsedTestGenArgs = { symbol: "" };
  if (!raw || !raw.trim()) {
    return {
      ...empty,
      error:
        "/test-gen expects a symbol name (e.g. /test-gen parseAuditTranscript). Add --file=<path> to scope or --framework=<name> to override detection.",
    };
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  let file: string | undefined;
  let framework: TestFrameworkHint | undefined;
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
    const eqFile = /^--file=(.+)$/.exec(t);
    if (eqFile) {
      file = eqFile[1];
      continue;
    }
    if (t === "--file") {
      const next = tokens[i + 1];
      if (next === undefined) {
        return {
          ...empty,
          error:
            "--file expects a path (e.g. --file=src/auth/login.ts)",
        };
      }
      file = next;
      i++;
      continue;
    }
    const eqFw = /^--framework=(.+)$/.exec(t);
    if (eqFw || t === "--framework") {
      const valueRaw = eqFw ? eqFw[1] : tokens[i + 1];
      if (valueRaw === undefined) {
        return {
          ...empty,
          error:
            "--framework expects one of: vitest, jest, node, cargo, pytest, go",
        };
      }
      const value = valueRaw.trim().toLowerCase();
      if (!FRAMEWORK_VALUES.has(value)) {
        return {
          ...empty,
          error: `--framework expects one of: vitest, jest, node, cargo, pytest, go (got "${valueRaw}")`,
        };
      }
      framework = value as TestFrameworkHint;
      if (!eqFw) i++;
      continue;
    }
    positional.push(t);
  }

  if (positional.length === 0) {
    return {
      ...empty,
      error:
        "/test-gen expects a symbol name (e.g. /test-gen parseAuditTranscript)",
    };
  }
  if (positional.length > 1) {
    return {
      ...empty,
      error: `/test-gen expects exactly one symbol; got ${positional.length} (${positional
        .map((p) => `"${p}"`)
        .join(", ")}). Use --file=<path> to scope instead of passing extra positional args.`,
    };
  }
  const symbol = positional[0];
  const idRe = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  if (!idRe.test(symbol)) {
    return {
      ...empty,
      error: `symbol "${symbol}" is not a plain identifier. v1 of /test-gen only generates tests for bare identifiers; member access (Foo.bar) and file-prefixed forms (auth.ts:login) are not yet supported.`,
    };
  }
  return { symbol, file, framework, maxToolRounds };
}

/**
 * Wrap the parsed args into a test-gen-mode user prompt. The
 * TEST_GEN_SYSTEM_PROMPT on the Rust side carries the playbook; this
 * function frames the request so the model knows it's the start of a
 * test-gen turn and has unambiguous input.
 */
export function buildTestGenPrompt(args: {
  symbol: string;
  file?: string;
  framework?: TestFrameworkHint;
}): string {
  const lines: string[] = [];
  lines.push(
    `Generate tests for the symbol \`${args.symbol}\` using the substrate-gated test-generation flow defined in your system prompt.`,
  );
  lines.push("");
  lines.push(`symbol: ${args.symbol}`);
  if (args.file) {
    lines.push(`file: ${args.file}`);
  } else {
    lines.push("file: <auto-detect>");
  }
  if (args.framework) {
    lines.push(`framework: ${args.framework} (user override)`);
  } else {
    lines.push("framework: <auto-detect from package.json + existing tests>");
  }
  lines.push("");
  lines.push(
    "Start by locating the declaration with ast_query op=resolve. If unresolved, STOP and say so \u2014 do not write tests for a symbol that doesn't exist. Then read the declaration's file + a neighboring test file to learn the project's testing style. Plan your cases (happy path, edge cases, error paths) and print the plan ONCE before writing. Apply via edit_file or write_file (each gated on user approval). Finish with run_tests; new tests must pass and existing tests must still pass. Produce the final TEST GEN REPORT block when done.",
  );
  return lines.join("\n");
}
