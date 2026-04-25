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

/**
 * Where a finding (or a piece of its evidence) came from. The substrate
 * cells (`typecheck`, `lsp`, `runtime`, `test`, `schema`) are
 * deterministic checks the LLM cannot influence. `ast` is structural
 * symbol/scope analysis. `grep` is textual pattern matching \u2014 a
 * lead generator, not proof. `llm` is pure model inference with no
 * other backing.
 */
export type Source =
  | "typecheck"
  | "lsp"
  | "runtime"
  | "test"
  | "schema"
  | "ast"
  | "grep"
  | "llm";

/**
 * How sure we are a finding is real. Determined deterministically from
 * `Finding.evidence` by `gradeFinding` \u2014 the LLM does NOT pick this.
 *   - `confirmed`: backed by typecheck / lsp / runtime / test / schema.
 *   - `probable`: backed by AST / structural analysis.
 *   - `candidate`: grep-only, llm-only, or no evidence at all.
 */
export type Confidence = "confirmed" | "probable" | "candidate";

/** One receipt that backs a finding. Multiple receipts per finding are normal. */
export interface Evidence {
  source: Source;
  /** Free-form detail \u2014 e.g. a verbatim compiler line, a grep result. */
  detail: string;
}

/** A single parsed finding from an audit run. */
export interface Finding {
  /** Stable-ish local id, assigned as the list is built. */
  id: string;
  severity: Severity;
  /**
   * How sure we are this finding is real. Defaults to `"candidate"` for
   * legacy reports that pre-date the confidence axis; the grader sets it
   * authoritatively for fresh runs.
   */
  confidence: Confidence;
  /**
   * The primary source of the finding (which substrate cell or LLM
   * produced it). The full evidence trail lives in `evidence`; this
   * field is a quick label for renderers that don't want to walk the
   * array.
   */
  source: Source;
  /** File path as emitted by the model (relative or absolute). */
  file: string;
  /** 1-based line number. 0 means the model didn't provide one. */
  line: number;
  /** The human-readable finding. */
  description: string;
  /** Model's suggested fix. May be empty. */
  suggested_fix: string;
  /**
   * The receipts that back this finding. Order is significant: the
   * authoritative source comes first. Empty for legacy reports.
   */
  evidence: Evidence[];
}

/**
 * One substrate cell invocation captured during the audit. Used to
 * surface what the agent ACTUALLY ran \u2014 typecheck command, exit code,
 * diagnostic count \u2014 in the audit report so users can see whether
 * their typecheck command is doing what they think.
 *
 * The field that motivates this exists: detection that silently picks
 * the wrong typecheck command (e.g. bare `tsc --noEmit` on a Vite
 * project-references layout) used to produce "clean" audits on broken
 * codebases. Showing the trace makes that misdetection visible.
 */
export interface SubstrateRun {
  /** Tool name: "typecheck" | "run_tests" | "lsp_diagnostics". */
  tool: string;
  /**
   * Pre-formatted single-line summary from the tool result, e.g.
   * `"typecheck \u2192 npm \u2014 0 diags (0 error, 0 warning) [exit 0]"`.
   */
  summary: string;
  /** True iff the tool call returned a structured response. */
  ok: boolean;
  /** 1-based round in which the call was issued. */
  round: number;
}

/**
 * One HTTP probe captured during the audit. Each entry corresponds to a
 * single `http_fetch` tool call the auditor issued. Surfacing these in
 * the report (alongside `findings`) preserves runtime evidence even when
 * the model forgets to paste an `evidence:` stanza into a finding line.
 *
 * Consumers (`/fix`, future IDE problems panel, future CI gates) read
 * this list to reason about live endpoint state without re-running the
 * probe. The grader still requires the model to cite `source=runtime`
 * for a *finding* to graduate; the probe list is a sibling record, not
 * a backdoor for confidence promotion.
 */
export interface RuntimeProbe {
  /** URL exactly as passed to http_fetch. */
  url: string;
  /** HTTP method (GET, POST, ...). */
  method: string;
  /** Pre-formatted single-line summary from the tool result. */
  summary: string;
  /** True iff the tool call itself succeeded (got a response). False
   * for transport errors (timeouts, connection refused). */
  ok: boolean;
  /** 1-based round in which the call was issued. Helpful when
   * correlating with the surrounding tool log. */
  round: number;
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
  /**
   * Every http_fetch call the auditor issued during this run. Empty
   * when the audit didn't touch HTTP code paths, when the dev server
   * wasn't running, or when the run pre-dates substrate v4. Always an
   * array (never undefined) so consumers don't need null-guards.
   */
  runtime_probes: RuntimeProbe[];
  /**
   * Substrate cell invocations (typecheck, run_tests, lsp_diagnostics)
   * the agent issued during this run. Surfaces the actual commands
   * the substrate ran so users can see whether their auto-detection
   * picked up what they expected. Always an array; empty for runs
   * that didn't call any of those tools.
   */
  substrate_runs: SubstrateRun[];
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
 * Match an `evidence:` continuation line that follows a finding line.
 * The audit prompt instructs the model to emit, e.g.
 *   `evidence: source=typecheck; detail="src/foo.ts(42,7): error TS2304"`
 * with multiple sources separated by ` | `. We capture the rest and parse
 * it permissively.
 */
const EVIDENCE_LINE = /^\s*evidence\s*:\s*(.+)$/i;

/** Set of every Source value, for runtime validation of model output. */
const KNOWN_SOURCES: ReadonlySet<Source> = new Set<Source>([
  "typecheck",
  "lsp",
  "schema",
  "runtime",
  "test",
  "ast",
  "grep",
  "llm",
]);

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
 * Raw finding shape \u2014 what the parser extracts before the grader runs.
 * Source defaults to `"llm"` because anything emitted directly by the
 * audit model with no evidence stanza is LLM inference. Confidence is
 * deliberately omitted; only the grader is allowed to set it.
 */
interface RawFinding {
  id: string;
  severity: Severity;
  file: string;
  line: number;
  description: string;
  suggested_fix: string;
  evidence: Evidence[];
  /** What the model claimed before grading. Preserved for the audit trail. */
  claimed_severity: Severity;
}

/**
 * One slice of parsed output between (or before) `FINDINGS (N)` headers.
 * Block-based parsing exists so a stray trailing `FINDINGS (0)` summary
 * line can't silently overwrite the real findings the model just emitted.
 */
interface ParsedBlock {
  /** The header's claimed count, or null for the implicit pre-header block. */
  claimed: number | null;
  findings: RawFinding[];
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
  meta: {
    model: string;
    scope: string | null;
    /**
     * Every `http_fetch` tool call captured during the audit turn,
     * if any. Forwarded verbatim into `AuditReport.runtime_probes`.
     * Optional so older callers (and tests) keep working without
     * passing it; treat omission as 'no probes'.
     */
    runtime_probes?: RuntimeProbe[];
    /**
     * Every typecheck / run_tests / lsp_diagnostics tool call captured
     * during the audit turn. Forwarded verbatim into
     * `AuditReport.substrate_runs` so the audit report can show what
     * commands the substrate actually executed.
     */
    substrate_runs?: SubstrateRun[];
  },
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
    // Evidence lines attach to the most recent finding in the most
    // recent block. They are the model's machine-readable receipts.
    const evidenceMatch = EVIDENCE_LINE.exec(raw);
    if (evidenceMatch) {
      const lastBlock = blocks[blocks.length - 1];
      const lastFinding = lastBlock.findings[lastBlock.findings.length - 1];
      if (lastFinding) {
        lastFinding.evidence.push(...parseEvidenceStanza(evidenceMatch[1]));
      }
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

  // Renumber ids and run every finding through the deterministic grader.
  // The grader (not the LLM) sets the canonical confidence + source +
  // possibly downgrades severity. Result: the LLM cannot raise a finding
  // above `candidate` confidence on its own.
  const findings: Finding[] = chosen.findings.map((raw, i) =>
    gradeFinding({ ...raw, id: `F${i + 1}` }),
  );

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
    runtime_probes: meta.runtime_probes ?? [],
    substrate_runs: meta.substrate_runs ?? [],
    raw_transcript: text,
  };
}

function parseFindingLine(raw: string, indexHint: number): RawFinding | null {
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
    claimed_severity: severity,
    file,
    line,
    description,
    suggested_fix,
    evidence: [],
  };
}

/**
 * Parse the right-hand side of an `evidence:` line into a list of
 * `Evidence` receipts. The expected format is
 *   `source=<src>; detail=<...>; [ | source=<src>; detail=<...> ]`
 * but we parse permissively \u2014 quoted detail strings are unquoted, and any
 * receipt missing a recognized source is dropped silently. Unknown
 * sources are mapped to `"llm"` so we never lose the detail entirely.
 */
function parseEvidenceStanza(stanza: string): Evidence[] {
  const out: Evidence[] = [];
  // Split on `|` first (multi-receipt separator). Tolerate semicolons in
  // the detail by only treating `;` as a key/value separator inside a
  // single receipt.
  const receipts = stanza.split("|").map((s) => s.trim()).filter(Boolean);
  for (const r of receipts) {
    let source: Source | null = null;
    let detail = "";
    // Each receipt is `key=value; key=value`. We don't use a strict regex
    // because models will occasionally drop quotes or use spaces.
    const kvPairs = r.split(/;(?=\s*[a-z_]+\s*=)/i);
    for (const pair of kvPairs) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const key = pair.slice(0, eq).trim().toLowerCase();
      const valueRaw = pair.slice(eq + 1).trim();
      const value = unquote(valueRaw);
      if (key === "source") {
        const candidate = value.toLowerCase() as Source;
        source = KNOWN_SOURCES.has(candidate) ? candidate : "llm";
      } else if (key === "detail" || key === "details") {
        detail = value;
      }
    }
    if (source !== null) {
      out.push({ source, detail });
    } else if (detail) {
      // Detail without an explicit source falls back to "llm" so the
      // text is preserved but the grader won't promote it.
      out.push({ source: "llm", detail });
    }
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Deterministic grader. The LLM does NOT pick confidence; this function
 * does, based on the evidence list. The architectural rule baked in here
 * is: "the LLM cannot raise a finding above `candidate` confidence on
 * its own." Severity is capped by confidence \u2014 candidate findings may not
 * exceed `warning`, so a model claiming `error` on grep-only or no
 * evidence has its severity downgraded to `warning` and the original
 * claim preserved in the evidence trail for transparency.
 */
export function gradeFinding(raw: RawFinding): Finding {
  const sources = raw.evidence.map((e) => e.source);

  // Tier 1: confirmed \u2014 backed by a deterministic substrate cell.
  if (
    sources.some((s) =>
      s === "typecheck" ||
      s === "lsp" ||
      s === "runtime" ||
      s === "test" ||
      s === "schema",
    )
  ) {
    const primary = pickPrimarySource(sources, [
      "typecheck",
      "lsp",
      "runtime",
      "test",
      "schema",
    ]);
    return finalize(raw, "confirmed", primary, raw.severity);
  }

  // Tier 2: probable \u2014 backed by structural AST analysis.
  if (sources.includes("ast")) {
    return finalize(raw, "probable", "ast", raw.severity);
  }

  // Tier 3: candidate \u2014 grep-only, llm-only, or no evidence at all.
  // Severity is capped at warning. Errors get downgraded; the original
  // severity is preserved in the evidence trail so the transparency
  // doesn't disappear.
  const cappedSeverity: Severity = raw.severity === "error" ? "warning" : raw.severity;
  const evidence: Evidence[] =
    cappedSeverity !== raw.severity
      ? [
          ...raw.evidence,
          {
            source: "llm",
            detail: `severity downgraded from "${raw.severity}" to "${cappedSeverity}" by grader (candidate findings cannot claim error)`,
          },
        ]
      : raw.evidence;
  // Primary source: prefer the strongest source the model named, falling
  // back to "llm" when nothing was provided.
  const primary: Source = sources.includes("grep")
    ? "grep"
    : sources[0] ?? "llm";
  return finalize({ ...raw, evidence }, "candidate", primary, cappedSeverity);
}

function pickPrimarySource(
  sources: Source[],
  preferred: Source[],
): Source {
  for (const p of preferred) {
    if (sources.includes(p)) return p;
  }
  return sources[0] ?? "llm";
}

function finalize(
  raw: RawFinding,
  confidence: Confidence,
  source: Source,
  severity: Severity,
): Finding {
  return {
    id: raw.id,
    severity,
    confidence,
    source,
    file: raw.file,
    line: raw.line,
    description: raw.description,
    suggested_fix: raw.suggested_fix,
    evidence: raw.evidence,
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
 * they don't open the markdown report. Each line shows both axes:
 * `[<confidence> <severity>]` plus the sources backing the finding.
 */
export function renderAnsiFindings(report: AuditReport): string {
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RED = "\x1b[31m";
  const YELLOW = "\x1b[33m";
  const CYAN = "\x1b[36m";
  const GREEN = "\x1b[32m";

  const out: string[] = [];
  const cs = countByConfidence(report.findings);
  out.push(
    `\r\n${BOLD}FINDINGS (${report.summary.total})${RESET} ${DIM}\u2014 ${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info | ${cs.confirmed} confirmed, ${cs.probable} probable, ${cs.candidate} candidate${RESET}\r\n`,
  );
  // One-line substrate trace so the user can see EXACTLY which
  // command the typecheck/run_tests/lsp cells executed. Catches the
  // 'silent misdetection' case where a Vite project-references
  // layout had bare `tsc --noEmit` running against an empty root.
  if (report.substrate_runs.length > 0) {
    for (const r of report.substrate_runs) {
      out.push(`${DIM}substrate → ${r.tool}: ${r.summary}${RESET}\r\n`);
    }
  }
  // One-line probe summary so the user sees runtime activity even when
  // the model didn't surface it in a finding's evidence trail.
  if (report.runtime_probes.length > 0) {
    const okCount = report.runtime_probes.filter((p) => p.ok).length;
    const failCount = report.runtime_probes.length - okCount;
    out.push(
      `${DIM}runtime probes: ${report.runtime_probes.length}${RESET} ${DIM}\u2014 ${GREEN}${okCount} ok${RESET}${DIM}${failCount > 0 ? `, ${RED}${failCount} transport failure${failCount === 1 ? "" : "s"}${RESET}` : ""}${RESET}\r\n`,
    );
  }
  if (report.findings.length === 0) {
    out.push(
      `${DIM}No wiring gaps surfaced. See raw transcript in the markdown report for details.${RESET}\r\n`,
    );
    return out.join("");
  }
  for (const f of report.findings) {
    const sevColor =
      f.severity === "error"
        ? RED
        : f.severity === "warning"
          ? YELLOW
          : CYAN;
    const confColor =
      f.confidence === "confirmed"
        ? GREEN
        : f.confidence === "probable"
          ? YELLOW
          : DIM;
    const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    const sources =
      f.evidence.length > 0
        ? Array.from(new Set(f.evidence.map((e) => e.source))).join(", ")
        : f.source;
    out.push(
      `${confColor}[${f.confidence}]${RESET} ${sevColor}[${f.severity}]${RESET} ${CYAN}${loc}${RESET} ${DIM}\u2014${RESET} ${f.description}` +
        (f.suggested_fix
          ? ` ${DIM}\u2014 fix: ${f.suggested_fix}${RESET}`
          : "") +
        ` ${DIM}(sources: ${sources})${RESET}\r\n`,
    );
  }
  return out.join("");
}

function countByConfidence(
  findings: Finding[],
): { confirmed: number; probable: number; candidate: number } {
  let confirmed = 0;
  let probable = 0;
  let candidate = 0;
  for (const f of findings) {
    if (f.confidence === "confirmed") confirmed++;
    else if (f.confidence === "probable") probable++;
    else candidate++;
  }
  return { confirmed, probable, candidate };
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
  const cs = countByConfidence(report.findings);
  fm.push(
    `${report.summary.total} finding${report.summary.total === 1 ? "" : "s"}${report.scope ? ` for scope \`${report.scope}\`` : ""}. ${report.summary.errors} error${report.summary.errors === 1 ? "" : "s"}, ${report.summary.warnings} warning${report.summary.warnings === 1 ? "" : "s"}, ${report.summary.info} info.`,
  );
  fm.push("");
  fm.push(
    `Confidence: ${cs.confirmed} confirmed, ${cs.probable} probable, ${cs.candidate} candidate.`,
  );
  fm.push("");
  fm.push(
    "> **Confidence legend.** _confirmed_ = backed by typecheck/LSP/runtime/test/schema. _probable_ = backed by AST/structural analysis. _candidate_ = grep, regex, or LLM inference only \u2014 needs verification.",
  );
  fm.push("");

  // Substrate runs section. Surfaces the actual typecheck / run_tests /
  // lsp_diagnostics commands the agent executed so a reader can verify
  // their auto-detection didn't silently fall through to a no-op (e.g.
  // bare `tsc --noEmit` on a Vite project-references layout).
  if (report.substrate_runs.length > 0) {
    fm.push("## Substrate runs");
    fm.push("");
    for (const r of report.substrate_runs) {
      const status = r.ok ? "\u2713" : "\u2717";
      fm.push(`- ${status} \`${r.tool}\` \u2014 ${r.summary}`);
    }
    fm.push("");
  }

  // Runtime probes section. Rendered before the findings list so a reader
  // skimming the report sees the live-endpoint evidence the auditor
  // captured, even when no finding directly cites it.
  if (report.runtime_probes.length > 0) {
    fm.push("## Runtime probes");
    fm.push("");
    const okCount = report.runtime_probes.filter((p) => p.ok).length;
    const failCount = report.runtime_probes.length - okCount;
    fm.push(
      `${report.runtime_probes.length} probe${report.runtime_probes.length === 1 ? "" : "s"} captured \u2014 ${okCount} ok, ${failCount} transport failure${failCount === 1 ? "" : "s"}.`,
    );
    fm.push("");
    for (const p of report.runtime_probes) {
      const status = p.ok ? "\u2713" : "\u2717";
      fm.push(`- ${status} \`${p.method} ${p.url}\` \u2014 ${p.summary}`);
    }
    fm.push("");
  }

  if (report.findings.length > 0) {
    fm.push("## Findings");
    fm.push("");
    for (let i = 0; i < report.findings.length; i++) {
      const f = report.findings[i];
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      fm.push(
        `### ${i + 1}. [${f.confidence} ${f.severity}] \`${loc}\``,
      );
      fm.push("");
      fm.push(f.description);
      fm.push("");
      if (f.suggested_fix) {
        fm.push(`**Suggested fix:** ${f.suggested_fix}`);
        fm.push("");
      }
      const sources = Array.from(new Set(f.evidence.map((e) => e.source)));
      if (sources.length > 0) {
        fm.push(`**Sources:** ${sources.join(", ")}`);
        fm.push("");
      }
      if (f.evidence.length > 0) {
        fm.push("<details>");
        fm.push("<summary>Evidence trail</summary>");
        fm.push("");
        for (const e of f.evidence) {
          fm.push(`- \`${e.source}\` \u2014 ${e.detail}`);
        }
        fm.push("");
        fm.push("</details>");
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
