// Build-report schema + parser + renderers.
//
// Several agent modes (`/build`, `/new`, `/refactor`, `/test-gen`) end
// their turn with a structured completion block: a status line, a Plan
// section, a Steps-executed section, and a Final-verification block.
// The headers vary by mode (BUILD REPORT vs RENAME REPORT vs SCAFFOLD
// REPORT vs TEST GEN REPORT) but the shape is consistent enough to
// share one tolerant parser.
//
// `/fix` deliberately uses a different format (APPLIED/SKIPPED/VERIFIED)
// and is NOT handled here. A future ticket can add a sibling parser if
// /fix completions need to land in `state.json`.
//
// As with `findings.ts`, this parser never throws on drift: whatever the
// model emitted is preserved verbatim in `raw_transcript` so a
// follow-up consumer can re-parse with looser rules.

/** What the parser concluded about the run's outcome. */
export type BuildStatus = "completed" | "incomplete" | "unknown";

/** One executed step from the report's Steps Executed list. */
export interface BuildStep {
  /** "ok" (✓), "skipped" (⊘), "failed" (✗), or "unknown" if no glyph. */
  outcome: "ok" | "skipped" | "failed" | "unknown";
  /** Trimmed line content, glyph stripped. */
  text: string;
}

/**
 * Pre-aggregated single-line summaries of the substrate verifications.
 * Mirrors the report's Final verification block. Optional fields stay
 * undefined when the corresponding tool was not run (or the model
 * dropped that line on the floor).
 */
export interface BuildVerification {
  typecheck?: string;
  ast_query?: string;
  tests?: string;
  http?: string;
  e2e?: string;
  schema?: string;
  /** Anything else that appeared as `key: value` but didn't match a known field. */
  other?: { key: string; value: string }[];
}

/** Fully parsed build report. */
export interface BuildReport {
  schema_version: 1;
  tool: "prism-build";
  generated_at: string;
  /** Mode that produced the report ("build" | "new" | "refactor" | "test-gen"). */
  mode: string;
  /** Model slug that produced the report. */
  model: string;
  /** Free-form description of what was being built (feature / rename pair / project name / symbol). */
  feature: string;
  status: BuildStatus;
  /** Numbered plan items in the order the model listed them. */
  plan: string[];
  /** Steps actually executed, with outcome glyphs. */
  steps: BuildStep[];
  verification: BuildVerification;
  /** The raw transcript the parser consumed. */
  raw_transcript: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Status header line. Accepts BUILD / RENAME / SCAFFOLD / TEST GEN
 * variants, with `COMPLETED|COMPLETE|INCOMPLETE` (case-insensitive).
 * "REPORT" is optional because the build prompt says BUILD COMPLETED
 * but other modes occasionally emit "BUILD REPORT" as the heading.
 */
const STATUS_HEADER_LINE =
  /^\s*(?:BUILD|RENAME|SCAFFOLD|TEST\s*GEN)\s*(?:REPORT\s*[:\u2014\u2013\-]?\s*)?(COMPLETED?|INCOMPLETE)\s*$/i;

/** Section heading inside the report, e.g. "## Plan", "### Final verification". */
const SECTION_HEADING_LINE = /^\s*#{1,6}\s+(.+?)\s*$/;

/** A plan or step row: optional numbering, optional glyph, some text. */
const STEP_ROW_LINE =
  /^\s*(?:\d+[.)\]]\s+)?([\u2713\u2717\u2298\u2715xX])?\s*[\u2014\u2013\-]?\s*(.+?)\s*$/;

/** A `key: value` row in the Final verification block. */
const KV_LINE = /^\s*([A-Za-z_][\w \-]*?)\s*:\s*(.+?)\s*$/;

export function parseBuildReportTranscript(
  text: string,
  meta: { mode: string; model: string; feature: string },
): BuildReport {
  const lines = text.split(/\r?\n/);
  const generated_at = new Date().toISOString();

  let status: BuildStatus = "unknown";
  let currentSection: "plan" | "steps" | "verification" | null = null;
  const plan: string[] = [];
  const steps: BuildStep[] = [];
  const verification: BuildVerification = {};
  const otherKv: { key: string; value: string }[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // 1. Status line. May appear at the top OR (for some models) at the
    //    bottom right before / right after the verification block.
    const statusMatch = STATUS_HEADER_LINE.exec(trimmed);
    if (statusMatch) {
      const word = statusMatch[1].toUpperCase();
      // "COMPLETE" and "COMPLETED" both map to completed.
      status = word.startsWith("COMPLETE") ? "completed" : "incomplete";
      continue;
    }

    // 2. Section heading.
    const sectionMatch = SECTION_HEADING_LINE.exec(trimmed);
    if (sectionMatch) {
      const lc = sectionMatch[1].toLowerCase();
      if (lc.startsWith("plan")) currentSection = "plan";
      else if (
        lc.includes("step") /* steps executed, steps */ ||
        lc.includes("execut")
      )
        currentSection = "steps";
      else if (lc.includes("verif") /* final verification, verification */)
        currentSection = "verification";
      else currentSection = null;
      continue;
    }

    // 3. Section bodies.
    if (currentSection === "verification") {
      const kv = KV_LINE.exec(trimmed);
      if (kv) {
        assignVerification(verification, kv[1], kv[2], otherKv);
      }
      continue;
    }
    if (currentSection === "plan") {
      const step = parseStepRow(trimmed);
      if (step.text) plan.push(step.text);
      continue;
    }
    if (currentSection === "steps") {
      const step = parseStepRow(trimmed);
      if (step.text) steps.push(step);
      continue;
    }
    // Lines outside any known section are intentionally ignored. The
    // caller can still see them in `raw_transcript`.
  }

  if (otherKv.length > 0) verification.other = otherKv;

  // If we never saw a status line but did see a verification block,
  // default to "completed" — matches the prompt convention that omitting
  // the keyword while still emitting a verification block means
  // "everything I planned ran".
  if (status === "unknown" && Object.keys(verification).length > 0) {
    status = "completed";
  }

  return {
    schema_version: 1,
    tool: "prism-build",
    generated_at,
    mode: meta.mode,
    model: meta.model,
    feature: meta.feature,
    status,
    plan,
    steps,
    verification,
    raw_transcript: text,
  };
}

function parseStepRow(line: string): BuildStep {
  // Strip leading numbering "1. ", "2) ", etc. before glyph detection
  // so a numbered list with no glyph still gets a clean text body.
  const dropNum = line.replace(/^\s*\d+[.)\]]\s+/, "");
  const m = STEP_ROW_LINE.exec(dropNum);
  const glyph = m?.[1] ?? "";
  const text = (m?.[2] ?? dropNum).trim();
  let outcome: BuildStep["outcome"] = "unknown";
  if (glyph === "\u2713") outcome = "ok";
  else if (glyph === "\u2298") outcome = "skipped";
  else if (
    glyph === "\u2717" ||
    glyph === "\u2715" ||
    glyph === "x" ||
    glyph === "X"
  )
    outcome = "failed";
  return { outcome, text };
}

function assignVerification(
  v: BuildVerification,
  rawKey: string,
  value: string,
  other: { key: string; value: string }[],
): void {
  const key = rawKey.toLowerCase().replace(/[\s_-]+/g, "_");
  // Recognized aliases — keep this list narrow so unrecognized rows
  // land in `other` rather than silently overwriting a known field.
  if (key === "typecheck") v.typecheck = value;
  else if (key === "ast_query" || key === "astquery") v.ast_query = value;
  else if (key === "run_tests" || key === "tests") v.tests = value;
  else if (key === "http_fetch" || key === "http") v.http = value;
  else if (key === "e2e_run" || key === "e2e") v.e2e = value;
  else if (key === "schema_inspect" || key === "schema") v.schema = value;
  else other.push({ key: rawKey.trim(), value });
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export function renderBuildReportJson(report: BuildReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Pretty markdown. Mirrors `renderMarkdownReport` in `findings.ts` so a
 * reader switching between audit and build reports gets the same shape.
 */
export function renderBuildReportMarkdown(report: BuildReport): string {
  const out: string[] = [];
  out.push("---");
  out.push(`tool: ${report.tool}`);
  out.push(`schema_version: ${report.schema_version}`);
  out.push(`generated_at: ${report.generated_at}`);
  out.push(`mode: ${yamlString(report.mode)}`);
  out.push(`model: ${yamlString(report.model)}`);
  out.push(`feature: ${yamlString(report.feature)}`);
  out.push(`status: ${report.status}`);
  out.push("---");
  out.push("");

  out.push(`# Build Report \u2014 ${report.feature || "(no description)"}`);
  out.push("");
  out.push(
    `Mode: \`${report.mode}\` \u00b7 Status: \`${report.status}\` \u00b7 Model: \`${report.model}\``,
  );
  out.push("");

  if (report.plan.length > 0) {
    out.push("## Plan");
    out.push("");
    report.plan.forEach((p, i) => out.push(`${i + 1}. ${p}`));
    out.push("");
  }

  if (report.steps.length > 0) {
    out.push("## Steps executed");
    out.push("");
    for (const s of report.steps) {
      const glyph =
        s.outcome === "ok"
          ? "\u2713"
          : s.outcome === "skipped"
            ? "\u2298"
            : s.outcome === "failed"
              ? "\u2717"
              : "\u2022";
      out.push(`- ${glyph} ${s.text}`);
    }
    out.push("");
  }

  const v = report.verification;
  const verifLines = formatVerificationLines(v);
  if (verifLines.length > 0) {
    out.push("## Final verification");
    out.push("");
    for (const l of verifLines) out.push(`- ${l}`);
    out.push("");
  }

  out.push("## Raw transcript");
  out.push("");
  out.push("<details>");
  out.push("<summary>Full model output</summary>");
  out.push("");
  out.push("```");
  out.push(report.raw_transcript);
  out.push("```");
  out.push("");
  out.push("</details>");
  out.push("");

  return out.join("\n");
}

/**
 * Compact ANSI summary for xterm. Same role as `renderAnsiFindings` for
 * audits: shows the user the structured outcome inline so they don't
 * have to open the markdown.
 */
export function renderAnsiBuildReport(report: BuildReport): string {
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const CYAN = "\x1b[36m";

  const out: string[] = [];
  const statusColor =
    report.status === "completed"
      ? GREEN
      : report.status === "incomplete"
        ? YELLOW
        : DIM;
  out.push(
    `\r\n${BOLD}BUILD ${report.status.toUpperCase()}${RESET} ${DIM}\u2014 ${report.mode}${report.feature ? ` \u00b7 ${report.feature}` : ""}${RESET}\r\n`,
  );
  void statusColor; // status color is for the optional pill; main label uses BOLD
  const verifLines = formatVerificationLines(report.verification);
  if (verifLines.length > 0) {
    for (const l of verifLines) {
      const color = l.startsWith("typecheck:")
        ? CYAN
        : l.startsWith("tests:") || l.startsWith("run_tests:")
          ? GREEN
          : l.startsWith("http:") || l.startsWith("http_fetch:")
            ? CYAN
            : DIM;
      out.push(`${color}${l}${RESET}\r\n`);
    }
  }
  if (report.steps.length > 0) {
    const ok = report.steps.filter((s) => s.outcome === "ok").length;
    const skipped = report.steps.filter((s) => s.outcome === "skipped").length;
    const failed = report.steps.filter((s) => s.outcome === "failed").length;
    out.push(
      `${DIM}steps: ${GREEN}${ok}\u2713${RESET}${DIM}, ${YELLOW}${skipped}\u2298${RESET}${DIM}, ${RED}${failed}\u2717${RESET}${DIM} of ${report.steps.length}${RESET}\r\n`,
    );
  }
  return out.join("");
}

function formatVerificationLines(v: BuildVerification): string[] {
  const out: string[] = [];
  if (v.typecheck !== undefined) out.push(`typecheck: ${v.typecheck}`);
  if (v.ast_query !== undefined) out.push(`ast_query: ${v.ast_query}`);
  if (v.tests !== undefined) out.push(`tests: ${v.tests}`);
  if (v.http !== undefined) out.push(`http: ${v.http}`);
  if (v.e2e !== undefined) out.push(`e2e: ${v.e2e}`);
  if (v.schema !== undefined) out.push(`schema: ${v.schema}`);
  if (v.other) for (const kv of v.other) out.push(`${kv.key}: ${kv.value}`);
  return out;
}

function yamlString(s: string): string {
  if (/[:#\[\]{}&*!|>'"%`\n]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/** Build the canonical filename for a build report. */
export function buildReportFilename(generated_at: string): string {
  const stamp = generated_at
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-")
    .replace(/Z$/, "");
  return `build-${stamp}.md`;
}

/** Build the JSON sidecar filename for the same generated_at timestamp. */
export function buildReportJsonFilename(generated_at: string): string {
  return buildReportFilename(generated_at).replace(/\.md$/, ".json");
}

// ---------------------------------------------------------------------------
// State.json projection
// ---------------------------------------------------------------------------

/**
 * Strip a `BuildReport` down to just the pointer-and-summary fields the
 * workspace state spine cares about. Used by `Workspace.handleBuildComplete`
 * to update `state.json.last_build` without leaking the full raw
 * transcript into the index file.
 */
export function buildLastBuildIndex(
  report: BuildReport,
  relativeJsonPath: string,
): {
  path: string;
  generated_at: string;
  feature: string;
  status: BuildStatus;
  verification: { typecheck?: string; tests?: string; http?: string };
} {
  return {
    path: relativeJsonPath,
    generated_at: report.generated_at,
    feature: report.feature,
    status: report.status,
    verification: {
      typecheck: report.verification.typecheck,
      tests: report.verification.tests,
      http: report.verification.http,
    },
  };
}
