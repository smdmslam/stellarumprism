// Recipe runner. Sequentially executes a recipe's steps against the
// workspace, builds a RecipeReport, and persists a consolidated
// Markdown copy under ~/Documents/Prism/Reports/.
//
// v1 design (Phase B in protocol-recipes-and-toolbar.md):
//   - No onProgress callback. Progress goes through workspace.notify()
//     directly. UI work (lifecycle card) lands in Phase C.
//   - No AbortSignal. Recipes run start-to-finish; the existing busy
//     pill cancels the in-flight slash step but won't abort future
//     steps. Cancellation lands with the card in Phase C.
//   - No "checklist" step kind. The methodology rules already inject
//     globally via REVIEWER_SYSTEM_PROMPT; a separate per-step
//     checklist mechanism is redundant for v1.
//
// The runner is a pure module that takes a `RecipeRunnerCtx` shaped
// interface so it doesn't need to import Workspace directly (avoids
// the circular import between `src/recipes/` and `src/workspace.ts`).

import { invoke } from "@tauri-apps/api/core";

import { findRecipe, RECIPES } from "./index";
import type {
  Recipe,
  RecipeReport,
  StepDef,
  StepResult,
  StepState,
} from "./types";

/** Minimal surface the runner needs from the workspace. */
export interface RecipeRunnerCtx {
  /** Shell cwd for shell steps. */
  getCwd(): string;
  /** Append a status notice to the agent panel. */
  notify(message: string): void;
  /** Append an error notice (red) to the agent panel. */
  notifyError(message: string): void;
  /**
   * Dispatch a slash command (e.g. "/audit", "/review 20") and resolve
   * when the resulting agent turn completes. Resolves with the
   * assistant's final response text. The implementation is responsible
   * for waiting until the agent goes busy=true \u2192 busy=false.
   */
  runSlashCommand(text: string): Promise<{
    assistantText: string;
    cancelled: boolean;
  }>;
}

/** Output of one shell step as returned by the run_pnpm_script Tauri command. */
interface ShellStepOutput {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  argv: string[];
  duration_ms: number;
}

/** Output of write_recipe_report. */
interface ReportWriteResult {
  path: string;
  bytes_written: number;
}

/**
 * Run the recipe identified by `id` against `ctx`. Returns the
 * structured report on success; throws if the recipe id is unknown or
 * if persisting the report fails (step failures are captured in the
 * report itself, not surfaced as exceptions).
 */
export async function runRecipe(
  id: string,
  ctx: RecipeRunnerCtx,
): Promise<RecipeReport> {
  const recipe = findRecipe(id);
  if (!recipe) {
    throw new Error(
      `unknown recipe id: ${id}. Available: ${RECIPES.map((r) => r.id).join(", ")}`,
    );
  }

  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  ctx.notify(
    `[protocol] starting "${recipe.label}" \u2014 ${recipe.steps.length} steps`,
  );

  const stepResults: Array<{ def: StepDef; result: StepResult }> = [];
  let aborted = false;
  for (let i = 0; i < recipe.steps.length; i++) {
    const def = recipe.steps[i];
    if (aborted) {
      stepResults.push({ def, result: skippedResult() });
      continue;
    }
    ctx.notify(
      `[protocol] step ${i + 1}/${recipe.steps.length} \u2014 ${def.label}`,
    );
    let result: StepResult;
    try {
      if (def.kind === "slash") {
        result = await runSlashStep(def, ctx);
      } else {
        result = await runShellStep(def, ctx);
      }
    } catch (err) {
      result = {
        state: "failed",
        durationMs: 0,
        output: "",
        errorOutput: "",
        exitCode: null,
        error: String(err),
      };
    }
    stepResults.push({ def, result });

    if (result.state === "failed") {
      const onFailure = def.onFailure ?? "continue";
      // Include the error string and exit code in the notice so the user
      // (and any future code review) sees the actual cause inline rather
      // than having to open the on-disk report. The full report still
      // captures stderr / stdout for postmortem.
      const errParts: string[] = [];
      if (result.error) errParts.push(result.error);
      if (result.exitCode !== null && result.exitCode !== undefined) {
        errParts.push(`exit ${result.exitCode}`);
      }
      const errSuffix = errParts.length > 0 ? ` \u2014 ${errParts.join("; ")}` : "";
      ctx.notifyError(
        `[protocol] step ${i + 1} failed${errSuffix} \u2014 ${onFailure === "abort" ? "aborting" : "continuing"}`,
      );
      // Surface a short tail of stderr (or stdout if stderr is empty)
      // so spawn-time AND program-level errors are visible inline. pnpm,
      // for example, prints `ERR_PNPM_NO_SCRIPT  Missing script: "X"`
      // to stdout for missing scripts \u2014 stderr-only would miss that.
      const errText = (result.errorOutput || "").trim();
      const outText = (result.output || "").trim();
      const tailSource =
        errText.length > 0
          ? { label: "stderr", text: result.errorOutput }
          : outText.length > 0
            ? { label: "stdout", text: result.output }
            : null;
      if (tailSource) {
        const tail = lastLines(tailSource.text, 6);
        ctx.notify(`[protocol] ${tailSource.label} (last 6 lines):\n${tail}`);
      }
      if (onFailure === "abort") aborted = true;
    } else {
      ctx.notify(
        `[protocol] step ${i + 1} ok (${formatDuration(result.durationMs)})`,
      );
    }
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const allOk = stepResults.every((s) => s.result.state === "ok");

  const markdown = renderRecipeReportMarkdown({
    recipe,
    startedAtIso,
    finishedAtIso: finishedAt.toISOString(),
    durationMs,
    steps: stepResults,
    allOk,
  });
  const filename = recipeReportFilename(recipe.id, startedAt);

  let reportPath = "";
  try {
    const writeResult = await invoke<ReportWriteResult>(
      "write_recipe_report",
      { filename, content: markdown },
    );
    reportPath = writeResult.path;
  } catch (err) {
    ctx.notifyError(`[protocol] could not save report: ${String(err)}`);
  }

  const report: RecipeReport = {
    recipeId: recipe.id,
    recipeLabel: recipe.label,
    category: recipe.category,
    startedAt: startedAtIso,
    finishedAt: finishedAt.toISOString(),
    durationMs,
    steps: stepResults,
    allOk,
    reportPath,
  };

  // Top-line summary in AgentView. The full report is on disk; this
  // gives the user enough to decide whether to open it.
  const okCount = stepResults.filter((s) => s.result.state === "ok").length;
  const summary =
    `[protocol] "${recipe.label}" finished \u2014 ` +
    `${okCount}/${stepResults.length} steps ok ` +
    `\u00b7 ${formatDuration(durationMs)} ` +
    `\u00b7 report: ${reportPath || "(not saved)"}`;
  ctx.notify(summary);

  return report;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

async function runSlashStep(
  def: Extract<StepDef, { kind: "slash" }>,
  ctx: RecipeRunnerCtx,
): Promise<StepResult> {
  const started = Date.now();
  let outcome: { assistantText: string; cancelled: boolean };
  try {
    outcome = await ctx.runSlashCommand(def.command);
  } catch (err) {
    return {
      state: "failed",
      durationMs: Date.now() - started,
      output: "",
      errorOutput: "",
      exitCode: null,
      error: String(err),
    };
  }
  return {
    state: outcome.cancelled ? "failed" : "ok",
    durationMs: Date.now() - started,
    output: outcome.assistantText,
    errorOutput: "",
    exitCode: null,
    error: outcome.cancelled ? "cancelled" : undefined,
  };
}

async function runShellStep(
  def: Extract<StepDef, { kind: "shell" }>,
  ctx: RecipeRunnerCtx,
): Promise<StepResult> {
  const cwd = ctx.getCwd();
  if (!cwd) {
    return {
      state: "failed",
      durationMs: 0,
      output: "",
      errorOutput: "",
      exitCode: null,
      error: "cwd unknown; cannot run shell step",
    };
  }
  let result: ShellStepOutput;
  try {
    result = await invoke<ShellStepOutput>("run_pnpm_script", {
      cwd,
      scriptName: def.script,
      timeoutSecs: def.timeoutSecs ?? null,
    });
  } catch (err) {
    return {
      state: "failed",
      durationMs: 0,
      output: "",
      errorOutput: "",
      exitCode: null,
      error: String(err),
    };
  }
  const ok = !result.timed_out && (result.exit_code ?? -1) === 0;
  // Only set `error` for substrate-level problems (timeouts) so the
  // runner notice doesn't end up with both an `exit N` from `error`
  // AND from the exitCode field. A plain non-zero exit is conveyed
  // through `exitCode` alone; the failure line composes both.
  return {
    state: ok ? "ok" : "failed",
    durationMs: result.duration_ms,
    output: result.stdout,
    errorOutput: result.stderr,
    exitCode: result.exit_code,
    timedOut: result.timed_out,
    error: result.timed_out
      ? `timed out after ${def.timeoutSecs ?? 300}s`
      : undefined,
  };
}

function skippedResult(): StepResult {
  return {
    state: "skipped",
    durationMs: 0,
    output: "",
    errorOutput: "",
    exitCode: null,
    error: "skipped (prior step aborted the recipe)",
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

interface ReportRenderInput {
  recipe: Recipe;
  startedAtIso: string;
  finishedAtIso: string;
  durationMs: number;
  steps: Array<{ def: StepDef; result: StepResult }>;
  allOk: boolean;
}

function renderRecipeReportMarkdown(input: ReportRenderInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.recipe.label}`);
  lines.push("");
  lines.push(`- **Recipe id:** \`${input.recipe.id}\``);
  lines.push(`- **Category:** ${input.recipe.category}`);
  lines.push(`- **Started:** ${input.startedAtIso}`);
  lines.push(`- **Finished:** ${input.finishedAtIso}`);
  lines.push(`- **Duration:** ${formatDuration(input.durationMs)}`);
  const okCount = input.steps.filter((s) => s.result.state === "ok").length;
  lines.push(`- **Steps ok:** ${okCount} / ${input.steps.length}`);
  lines.push(`- **All ok:** ${input.allOk ? "yes" : "no"}`);
  lines.push("");
  lines.push(`> ${input.recipe.blurb}`);
  lines.push("");
  lines.push(`## Steps`);
  lines.push("");
  for (let i = 0; i < input.steps.length; i++) {
    const { def, result } = input.steps[i];
    const num = i + 1;
    const stateGlyph = stateGlyphFor(result.state);
    lines.push(`### ${num}. ${stateGlyph} ${def.label}`);
    lines.push("");
    lines.push(`- **Kind:** \`${def.kind}\``);
    if (def.kind === "slash") {
      lines.push(`- **Command:** \`${def.command}\``);
    } else {
      lines.push(`- **Script:** \`pnpm ${def.script}\``);
      if (def.timeoutSecs) {
        lines.push(`- **Timeout:** ${def.timeoutSecs}s`);
      }
    }
    lines.push(`- **State:** ${result.state}`);
    lines.push(`- **Duration:** ${formatDuration(result.durationMs)}`);
    if (result.exitCode !== null && result.exitCode !== undefined) {
      lines.push(`- **Exit code:** ${result.exitCode}`);
    }
    if (result.timedOut) {
      lines.push(`- **Timed out:** yes`);
    }
    if (result.error) {
      lines.push(`- **Error:** ${result.error}`);
    }
    lines.push("");
    if (result.output && result.output.trim().length > 0) {
      lines.push(def.kind === "slash" ? "**Assistant response:**" : "**stdout:**");
      lines.push("");
      lines.push("```");
      lines.push(truncateForReport(result.output));
      lines.push("```");
      lines.push("");
    }
    if (result.errorOutput && result.errorOutput.trim().length > 0) {
      lines.push("**stderr:**");
      lines.push("");
      lines.push("```");
      lines.push(truncateForReport(result.errorOutput));
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

function stateGlyphFor(state: StepState): string {
  switch (state) {
    case "ok":
      return "\u2713";
    case "failed":
      return "\u2717";
    case "skipped":
      return "\u2014";
    default:
      return "\u00b7";
  }
}

/**
 * Cap captured stdout/stderr at a reasonable size so the on-disk
 * report stays readable. The full output is still available in the
 * shell tool's transcript if the user needs it.
 */
function truncateForReport(text: string): string {
  const MAX = 16 * 1024; // 16 KB per stream per step
  if (text.length <= MAX) return text;
  return text.slice(0, MAX) + `\n\n[\u2026 truncated, ${text.length - MAX} more bytes]`;
}

/**
 * Take the last N non-empty lines of a multi-line string. Used to
 * surface a short stderr tail in the failure notice without dumping
 * thousands of bytes into AgentView.
 */
function lastLines(text: string, n: number): string {
  const all = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return all.slice(-n).join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

function recipeReportFilename(recipeId: string, started: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp =
    `${started.getFullYear()}${pad(started.getMonth() + 1)}${pad(started.getDate())}` +
    `-${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}`;
  // Filename validation is enforced on the Rust side, so even if a
  // future recipe id contains slashes the write would reject. Sanitize
  // here too as belt-and-braces.
  const safe = recipeId.replace(/[^a-z0-9-]/gi, "-");
  return `${safe}-${stamp}.md`;
}
