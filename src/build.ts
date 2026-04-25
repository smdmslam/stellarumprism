// Pure helpers for the `/build` slash command.
//
// Lives in its own file so the test runner can import this module
// without dragging in the UI surface (xterm, CodeMirror, Tauri APIs)
// from `workspace.ts`. The slash-command handler in `workspace.ts`
// imports from here.

export interface ParsedBuildArgs {
  /** The feature description the user wants built. */
  feature: string;
  /**
   * Per-call override for the agent's tool-round cap. When omitted,
   * the build mode's floor (100) and the user's `agent.max_tool_rounds`
   * config setting govern.
   */
  maxToolRounds?: number;
  /** Surfaces parse errors to the caller without throwing. */
  error?: string;
}

/**
 * Parse the argument tail of `/build ...`. Recognized flags:
 *   --max-rounds=N  (or `--max-rounds N`) raises the per-turn round cap.
 * Everything else is treated as part of the feature description and
 * joined back together preserving original token order. Empty feature
 * returns an error so the caller can surface a precise message.
 */
export function parseBuildArgs(raw: string): ParsedBuildArgs {
  if (!raw || !raw.trim()) {
    return {
      feature: "",
      error:
        "/build expects a feature description (e.g. /build add Google auth to the landing page)",
    };
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  let maxToolRounds: number | undefined;
  const featureTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eqRounds = /^--max-rounds=(.+)$/.exec(t);
    if (eqRounds) {
      const n = Number(eqRounds[1]);
      if (!Number.isFinite(n) || n < 1) {
        return {
          feature: "",
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
          feature: "",
          error: "--max-rounds expects a value (e.g. --max-rounds=120)",
        };
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        return {
          feature: "",
          error: `--max-rounds expects a positive integer, got "${next}"`,
        };
      }
      maxToolRounds = Math.floor(n);
      i++;
      continue;
    }
    featureTokens.push(t);
  }

  const feature = featureTokens.join(" ").trim();
  if (!feature) {
    return {
      feature: "",
      error:
        "/build expects a feature description after any flags (e.g. /build --max-rounds=120 add Google auth)",
    };
  }
  return { feature, maxToolRounds };
}

/**
 * Wrap the user's feature description into a build-mode user prompt.
 * The wrapping is deliberately minimal \u2014 the BUILD_SYSTEM_PROMPT on
 * the Rust side carries the playbook; this function just frames the
 * request so the model knows it's the start of a build turn.
 */
export function buildBuildPrompt(feature: string): string {
  return [
    `Build the following feature using the substrate-gated flow defined in your system prompt.`,
    "",
    `Feature: ${feature}`,
    "",
    "Start with PLAN. Read just enough of the codebase to understand the surface area, then produce the numbered plan, then BASELINE typecheck, then EXECUTE step by step. Produce the final BUILD REPORT block when done.",
  ].join("\n");
}
