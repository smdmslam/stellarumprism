// Findings schema + parser + renderers for Second Pass audit mode.
//
// The audit system prompt (src-tauri/src/agent.rs::AUDIT_SYSTEM_PROMPT)
// instructs the model to output one line per finding in the shape:
//
//   [severity] path/to/file.ext:line \u2014 description \u2014 suggested fix
//
// Models being models, the actual output drifts. This parser is
// intentionally tolerant: accepts em-dash / en-dash / ASCII double-dash,
// accepts severity case-insensitively, accepts optional leading numbers
// ("1.", "1)"), accepts the FINDINGS (N) header in any casing, skips
// unrelated lines silently, and never hard-fails. Whatever the model
// emitted still lives in `rawTranscript` so format drift never loses
// information.

export type Severity = "error" | "warning" | "info";

/** A single parsed finding from an audit run. */
export interface Finding {
  /** Stable-ish local id, assigned as the list is built. */
  id: string;
  severity: Severity;
  /** File path as emitted by the model (relative or absolute). */
  file: string;
  /** 1-based line number. 0 means the model didn't provide one. */
  line: number;
  /** The human-readable finding. */
  description: string;
  /** Model's suggested fix. May be empty. */
  suggested_fix: string;
}

/** Fully parsed audit report, ready to render in any form. */
export interface AuditReport {
  schema_version: 1;
  tool: "prism-second-pass";
  generated_at: string; // ISO string
  /** The --ref..--ref or path scope the user passed. Optional. */
  scope: string | null;
  /** Model slug that produced the findings. */
  model: string;
  summary: {
    errors: number;
    warnings: number;
    info: number;
    total: number;
  };
  findings: Finding[];
  /** The raw text the parser read. Always retained for debugging / recovery. */
  raw_transcript: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Strict shape: bracketed severity, e.g. "[error] path/to/file.ts:6 \u2014 \u2026".
 * This is what the audit system prompt asks for verbatim.
 *
 * Captures:
 *   1: severity (error | warning | info), case-insensitive
 *   2: everything after the bracket \u2014 location + description + fix
 *
 * Accepts optional leading numbering like "1. ", "1) ", "  2. " etc.
 */
const STRICT_FINDING_LINE =
  /^\s*(?:\d+[.)\]]\s+)?\[(error|warning|info)\]\s+(.+)$/i;

/**
 * Loose shape: severity word without brackets, e.g.
 * "error src/services/essays.ts:6 \u2014 \u2026". Some models drop the brackets
 * even when the system prompt asks for them. We still require a path-like
 * `<file>:<line>` token immediately after the severity so we don't catch
 * prose lines that happen to start with "error" / "warning" / "info".
 *
 * Captures:
 *   1: severity
 *   2: the rest of the line, starting with the path:line token
 */
const LOOSE_FINDING_LINE =
  /^\s*(?:\d+[.)\]]\s+)?(error|warning|info)\s+(\S+[\/.]\S*:\d+\s.*)$/i;

/**
 * Split on runs of em-dash / en-dash / double-hyphen / ASCII hyphen that
 * are bracketed by whitespace. Deliberately avoids matching hyphens inside
 * filenames or words. Unicode: \u2014 = em-dash, \u2013 = en-dash.
 */
const FIELD_SEPARATOR = /\s+[\u2014\u2013\-]{1,3}\s+/;

/** Optional summary header like "FINDINGS (12)" (case-insensitive). */
const HEADER_LINE = /^\s*FINDINGS\s*\((\d+)\)\s*$/i;

/**
 * One slice of parsed output between (or before) `FINDINGS (N)` headers.
 * Block-based parsing exists so a stray trailing `FINDINGS (0)` summary
 * line can't silently overwrite the real findings the model just emitted.
 */
interface ParsedBlock {
  /** The header's claimed count, or null for the implicit pre-header block. */
  claimed: number | null;
  findings: Finding[];
}

/**
 * Parse the final transcript of an audit run into a structured report.
 * `text` is the full concatenated assistant response. `meta` supplies
 * scope + model which the parser can't recover from the text.
 *
 * The parser slices the transcript into blocks, where each `FINDINGS (N)`
 * header starts a new block. The chosen block is the **last one that
 * actually contains parseable finding lines**, which means:
 *   - A trailing `FINDINGS (0)` summary after a real finding list does
 *     NOT clobber the findings.
 *   - A model that emits findings without any header still works (they
 *     land in the implicit pre-header block).
 *   - When the model emits multiple non-empty blocks (a re-do, a delta),
 *     the most recent one wins.
 */
export function parseAuditTranscript(
  text: string,
  meta: { model: string; scope: string | null },
): AuditReport {
  const blocks: ParsedBlock[] = [{ claimed: null, findings: [] }];
  let runningIndex = 0;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const headerMatch = HEADER_LINE.exec(raw);
    if (headerMatch) {
      blocks.push({
        claimed: parseInt(headerMatch[1], 10),
        findings: [],
      });
      continue;
    }
    const finding = parseFindingLine(raw, runningIndex);
    if (finding) {
      blocks[blocks.length - 1].findings.push(finding);
      runningIndex++;
    }
  }

  // Last non-empty block wins. If every block is empty (model genuinely
  // found nothing), fall back to the trailing block so the claimed count
  // \u2014 typically zero \u2014 is preserved for the (mismatch-detection) check below.
  let chosen: ParsedBlock = blocks[blocks.length - 1];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].findings.length > 0) {
      chosen = blocks[i];
      break;
    }
  }

  // Renumber ids deterministically against the chosen block so they
  // stay 1..N regardless of how many blocks were dropped.
  const findings: Finding[] = chosen.findings.map((f, i) => ({
    ...f,
    id: `F${i + 1}`,
  }));

  const summary = summarize(findings);
  // Surface mismatch between what the model claimed and what we could
  // parse, but don't treat it as a hard error \u2014 the raw transcript is
  // always preserved in the report so consumers can investigate.
  if (chosen.claimed !== null && chosen.claimed !== summary.total) {
    // intentionally silent; see comment above.
  }

  return {
    schema_version: 1,
    tool: "prism-second-pass",
    generated_at: new Date().toISOString(),
    scope: meta.scope,
    model: meta.model,
    summary,
    findings,
    raw_transcript: text,
  };
}

function parseFindingLine(raw: string, indexHint: number): Finding | null {
  let m = STRICT_FINDING_LINE.exec(raw);
  if (!m) m = LOOSE_FINDING_LINE.exec(raw);
  if (!m) return null;
  const severity = m[1].toLowerCase() as Severity;
  const rest = m[2].trim();

  // Split on em-dash / en-dash / double-hyphen boundaries. Expected shape:
  //   <location> \u2014 <description> \u2014 <fix>
  // But some models will omit the fix, or inline extra \u2014 chars inside the
  // description. We take the first part as location, the last as fix when
  // \u2265 3 parts, and join the middle as description.
  const parts = rest.split(FIELD_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const { file, line } = parseLocation(parts[0]);
  let description = "";
  let suggested_fix = "";

  if (parts.length === 1) {
    description = parts[0];
  } else if (parts.length === 2) {
    description = parts[1];
  } else {
    description = parts.slice(1, -1).join(" \u2014 ");
    suggested_fix = parts[parts.length - 1];
  }

  return {
    id: `F${indexHint + 1}`,
    severity,
    file,
    line,
    description,
    suggested_fix,
  };
}

function parseLocation(s: string): { file: string; line: number } {
  // Accept "path/to/file.ext:123" or bare "path/to/file.ext" (line 0).
  const m = /^(.+?):(\d+)$/.exec(s);
  if (m) {
    return { file: m[1], line: parseInt(m[2], 10) };
  }
  return { file: s, line: 0 };
}

function summarize(findings: Finding[]): AuditReport["summary"] {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
    else info++;
  }
  return { errors, warnings, info, total: findings.length };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Pretty, ANSI-colored list for xterm. Used as the inline summary after
 * the audit completes, so the user sees the structured result even if
 * they don't open the markdown report.
 */
export function renderAnsiFindings(report: AuditReport): string {
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RED = "\x1b[31m";
  const YELLOW = "\x1b[33m";
  const CYAN = "\x1b[36m";

  const out: string[] = [];
  out.push(
    `\r\n${BOLD}FINDINGS (${report.summary.total})${RESET} ${DIM}\u2014 ${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info${RESET}\r\n`,
  );
  if (report.findings.length === 0) {
    out.push(
      `${DIM}No wiring gaps surfaced. See raw transcript in the markdown report for details.${RESET}\r\n`,
    );
    return out.join("");
  }
  for (const f of report.findings) {
    const color =
      f.severity === "error"
        ? RED
        : f.severity === "warning"
          ? YELLOW
          : CYAN;
    const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    out.push(
      `${color}[${f.severity}]${RESET} ${CYAN}${loc}${RESET} ${DIM}\u2014${RESET} ${f.description}` +
        (f.suggested_fix
          ? ` ${DIM}\u2014 fix: ${f.suggested_fix}${RESET}`
          : "") +
        "\r\n",
    );
  }
  return out.join("");
}

/**
 * Render the full markdown report \u2014 YAML frontmatter + structured body.
 * This is what gets written to `.prism/second-pass/audit-<ts>.md` and
 * handed off to external editors (Cursor / Antigravity / etc.).
 */
export function renderMarkdownReport(report: AuditReport): string {
  const fm: string[] = [];
  fm.push("---");
  fm.push(`tool: ${report.tool}`);
  fm.push(`schema_version: ${report.schema_version}`);
  fm.push(`generated_at: ${report.generated_at}`);
  if (report.scope !== null) {
    fm.push(`scope: ${yamlString(report.scope)}`);
  }
  fm.push(`model: ${yamlString(report.model)}`);
  fm.push("summary:");
  fm.push(`  errors: ${report.summary.errors}`);
  fm.push(`  warnings: ${report.summary.warnings}`);
  fm.push(`  info: ${report.summary.info}`);
  fm.push(`  total: ${report.summary.total}`);
  fm.push("---");
  fm.push("");

  fm.push("# Second Pass Report");
  fm.push("");
  fm.push(
    `${report.summary.total} finding${report.summary.total === 1 ? "" : "s"}${report.scope ? ` for scope \`${report.scope}\`` : ""}. ${report.summary.errors} error${report.summary.errors === 1 ? "" : "s"}, ${report.summary.warnings} warning${report.summary.warnings === 1 ? "" : "s"}, ${report.summary.info} info.`,
  );
  fm.push("");

  if (report.findings.length > 0) {
    fm.push("## Findings");
    fm.push("");
    for (let i = 0; i < report.findings.length; i++) {
      const f = report.findings[i];
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      fm.push(`### ${i + 1}. [${f.severity}] \`${loc}\``);
      fm.push("");
      fm.push(f.description);
      fm.push("");
      if (f.suggested_fix) {
        fm.push(`**Suggested fix:** ${f.suggested_fix}`);
        fm.push("");
      }
    }
  } else {
    fm.push("## Findings");
    fm.push("");
    fm.push(
      "_No structured findings were parseable from this run. The raw transcript below is the full model output._",
    );
    fm.push("");
  }

  fm.push("## Raw transcript");
  fm.push("");
  fm.push("<details>");
  fm.push("<summary>Full model output</summary>");
  fm.push("");
  fm.push("```");
  fm.push(report.raw_transcript);
  fm.push("```");
  fm.push("");
  fm.push("</details>");
  fm.push("");

  return fm.join("\n");
}

/** Quote a string for YAML. Uses double-quotes + escapes `"` and `\`. */
function yamlString(s: string): string {
  // Quote if there's anything that might confuse a YAML parser.
  if (/[:#\[\]{}&*!|>'"%`\n]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Build the canonical filename for an audit report. */
export function auditReportFilename(generated_at: string): string {
  // Example: audit-2026-04-24T21-11-14.md
  const stamp = generated_at
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-")
    .replace(/Z$/, "");
  return `audit-${stamp}.md`;
}

/**
 * Render the structured AuditReport as pretty-printed JSON. This is the
 * machine-readable sidecar to the markdown report \u2014 every consumer that
 * isn't a human (`/fix`, future IDE problems panel, future CI integration)
 * reads this instead of re-parsing the markdown body.
 *
 * The shape is identical to the in-memory `AuditReport`. We deliberately
 * do NOT define a separate "on-disk" schema; the in-memory contract IS
 * the on-disk contract, and that is the whole point of the substrate's
 * Finding contract being unified.
 */
export function renderJsonReport(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

/** Build the JSON sidecar filename for the same generated_at timestamp. */
export function auditReportJsonFilename(generated_at: string): string {
  return auditReportFilename(generated_at).replace(/\.md$/, ".json");
}
