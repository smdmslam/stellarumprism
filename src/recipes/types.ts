// Recipe data model.
//
// A "recipe" is an ordered sequence of steps the runner executes against
// a workspace. v1 supports two step kinds:
//   - "slash"  — run an existing slash command (e.g. /audit, /review) and
//                wait for the resulting agent turn to complete.
//   - "shell"  — run a pnpm script via the run_pnpm_script Tauri command
//                and capture stdout/stderr/exit_code.
//
// "checklist" steps from the protocol-recipes-and-toolbar.md spec are
// intentionally NOT in v1 — the methodology rules already inject through
// the verifier system prompt globally, so a separate checklist step kind
// would be redundant for the first cut. Add it later if a recipe needs
// to inject context that the verifier prompt doesn't already cover.

export type StepKind = "slash" | "shell";

/** A single ordered step inside a recipe. */
export type StepDef =
  | {
      kind: "slash";
      /** User-facing label shown in progress notices and the report. */
      label: string;
      /** Slash text to dispatch, e.g. "/audit" or "/review HEAD~5..HEAD". */
      command: string;
      /**
       * Whether a non-zero / cancelled outcome should abort the rest of
       * the recipe. Default false (continue) for analysis-only steps.
       */
      onFailure?: "abort" | "continue";
    }
  | {
      kind: "shell";
      /** User-facing label. */
      label: string;
      /** pnpm script name (e.g. "typecheck"). Args not supported in v1. */
      script: string;
      /** Per-step timeout. Default 300s on the Rust side. */
      timeoutSecs?: number;
      onFailure?: "abort" | "continue";
      /**
       * Scripts that must exist in `<cwd>/package.json` for this step
       * to apply. Defaults to `[script]` when omitted. Set to `[]` to
       * skip the pre-flight check entirely (e.g. for a step that runs
       * a non-pnpm command via a future shell kind).
       */
      requires?: string[];
      /**
       * What to do when one or more `requires` scripts are missing in
       * the current cwd's `package.json`:
       *   "abort" (default) \u2014 the recipe aborts BEFORE any step
       *     runs, with a recipe-level message naming the missing
       *     scripts. Prevents a noisy `pnpm exit 254` mid-run.
       *   "skip" \u2014 this step transitions directly to `state: "skipped"`
       *     with a clear note; remaining steps still run. Useful for
       *     optional steps (e.g. `pnpm audit` on a project that has
       *     no audit script).
       */
      onMissing?: "abort" | "skip";
    };

/** Static recipe definition. Source-controlled, not user-authored in v1. */
export interface Recipe {
  /** Stable id used by /protocol and the report filename. */
  id: string;
  /** User-facing name shown in the toolbar menu (Phase D) and reports. */
  label: string;
  /** One-line description. */
  blurb: string;
  /** Drives toolbar grouping in Phase D and report categorization. */
  category: "review" | "security" | "ship" | "wiring";
  steps: StepDef[];
}

/** Outcome state for one executed step. */
export type StepState = "pending" | "active" | "ok" | "failed" | "skipped";

/** Captured output of one executed step. */
export interface StepResult {
  state: StepState;
  /** Wall-clock duration in milliseconds. 0 if the step never ran. */
  durationMs: number;
  /**
   * For slash steps: the assistant's final response text. For shell
   * steps: the full stdout (stderr is in `errorOutput`). Empty string
   * if the step was skipped or failed before producing output.
   */
  output: string;
  /** Standard-error stream from a shell step; empty for slash steps. */
  errorOutput: string;
  /** Process exit code for shell steps; null for slash steps. */
  exitCode: number | null;
  /** Human-readable error message if the step failed. */
  error?: string;
  /** True iff the shell step's timeout elapsed. */
  timedOut?: boolean;
}

/** Top-level recipe run result. */
export interface RecipeReport {
  recipeId: string;
  recipeLabel: string;
  category: Recipe["category"];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Mirrors `steps` in the recipe definition, one entry per step. */
  steps: Array<{ def: StepDef; result: StepResult }>;
  /** True iff every step ended in `ok`. */
  allOk: boolean;
  /** Path to the on-disk markdown copy under ~/Documents/Prism/Reports/. */
  reportPath: string;
}
