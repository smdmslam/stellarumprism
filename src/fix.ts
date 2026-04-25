// Pure helpers for the `/fix` slash command.
//
// Lives in its own file so the test runner can import this module
// without dragging in the UI surface (xterm, CodeMirror, Tauri APIs)
// from `workspace.ts`. The slash-command handler in `workspace.ts`
// imports from here.

import type { AuditReport, Confidence, Finding } from "./findings";

/**
 * Selector for `/fix`. The grammar is intentionally narrow:
 *   - 'all' (or empty)            \u2192 every finding in the report.
 *   - 'N'                          \u2192 1-based index into the findings list.
 *   - 'A,B,C'                      \u2192 comma-separated indices.
 *   - 'A-B'                        \u2192 inclusive range of indices.
 *   - '#F2'                        \u2192 explicit Finding id.
 *   - '#F1,#F4'                    \u2192 list of ids.
 * Mixing index tokens and id tokens in one selector is rejected.
 */
export type FixSelector =
  | { kind: "all" }
  | { kind: "indices"; indices: number[] }
  | { kind: "ids"; ids: string[] };

/**
 * Confidence policy for `/fix`. Default is `confirmed`-only \u2014 the safest
 * floor. `probable` widens to AST-backed findings. `all` (alias `candidate`)
 * lets through grep / LLM speculation.
 */
export type IncludePolicy = "confirmed" | "probable" | "candidate";

export interface ParsedFixArgs {
  selector: FixSelector;
  /**
   * Confidence floor for findings. Defaults to `"confirmed"`. The user
   * widens via `--include=probable` or `--include=all`.
   */
  include: IncludePolicy;
  maxToolRounds?: number;
  reportPath?: string;
  error?: string;
}

/**
 * Parse the argument tail of `/fix ...`. Returns a structured selector
 * plus optional flags. Errors are surfaced as `error` on the result so
 * the caller can render them without throwing.
 */
export function parseFixArgs(raw: string): ParsedFixArgs {
  if (!raw) return { selector: { kind: "all" }, include: "confirmed" };
  const tokens = raw.split(/\s+/).filter(Boolean);
  let maxToolRounds: number | undefined;
  let reportPath: string | undefined;
  let include: IncludePolicy = "confirmed";
  const selectorTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eqRounds = /^--max-rounds=(.+)$/.exec(t);
    if (eqRounds) {
      const n = Number(eqRounds[1]);
      if (!Number.isFinite(n) || n < 1) {
        return {
          selector: { kind: "all" },
          include,
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
          selector: { kind: "all" },
          include,
          error: "--max-rounds expects a value (e.g. --max-rounds=80)",
        };
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        return {
          selector: { kind: "all" },
          include,
          error: `--max-rounds expects a positive integer, got "${next}"`,
        };
      }
      maxToolRounds = Math.floor(n);
      i++;
      continue;
    }
    const eqReport = /^--report=(.+)$/.exec(t);
    if (eqReport) {
      reportPath = eqReport[1];
      continue;
    }
    if (t === "--report") {
      const next = tokens[i + 1];
      if (next === undefined) {
        return {
          selector: { kind: "all" },
          include: "confirmed",
          error:
            "--report expects a path (e.g. --report=.prism/second-pass/audit-2026-01-01T00-00-00.json)",
        };
      }
      reportPath = next;
      i++;
      continue;
    }
    const eqInclude = /^--include=(.+)$/.exec(t);
    if (eqInclude || t === "--include") {
      const valueRaw = eqInclude
        ? eqInclude[1]
        : tokens[i + 1];
      if (valueRaw === undefined) {
        return {
          selector: { kind: "all" },
          include: "confirmed",
          error:
            "--include expects one of: confirmed, probable, all (or candidate)",
        };
      }
      const policy = parseIncludePolicy(valueRaw);
      if (!policy) {
        return {
          selector: { kind: "all" },
          include: "confirmed",
          error: `--include expects one of: confirmed, probable, all (or candidate); got "${valueRaw}"`,
        };
      }
      include = policy;
      if (!eqInclude) i++;
      continue;
    }
    selectorTokens.push(t);
  }

  if (selectorTokens.length === 0) {
    return { selector: { kind: "all" }, include, maxToolRounds, reportPath };
  }
  if (selectorTokens.length === 1 && selectorTokens[0].toLowerCase() === "all") {
    return { selector: { kind: "all" }, include, maxToolRounds, reportPath };
  }

  // Tokenize into comma-separated parts (joining all selector tokens first).
  const parts = selectorTokens
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { selector: { kind: "all" }, include, maxToolRounds, reportPath };
  }

  // If any part begins with `#`, treat the whole selector as an id list.
  // (Mixing ids and indices is rejected to keep semantics obvious.)
  const looksLikeIds = parts.some((p) => p.startsWith("#"));
  if (looksLikeIds) {
    if (parts.some((p) => !p.startsWith("#"))) {
      return {
        selector: { kind: "all" },
        include,
        error: `mixed id and index tokens in selector "${selectorTokens.join(" ")}"; pick one form`,
      };
    }
    const ids = parts.map((p) => p.slice(1).trim()).filter(Boolean);
    if (ids.length === 0) {
      return {
        selector: { kind: "all" },
        include,
        error: `no ids parsed from selector "${selectorTokens.join(" ")}"`,
      };
    }
    return { selector: { kind: "ids", ids }, include, maxToolRounds, reportPath };
  }

  // Otherwise indices + ranges.
  const indices: number[] = [];
  for (const p of parts) {
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (a < 1 || b < 1 || a > b) {
        return {
          selector: { kind: "all" },
          include,
          error: `bad range "${p}"; use 1-based ascending (e.g. 1-5)`,
        };
      }
      for (let n = a; n <= b; n++) indices.push(n);
      continue;
    }
    const single = /^\d+$/.exec(p);
    if (!single) {
      return {
        selector: { kind: "all" },
        include,
        error: `unrecognized selector token "${p}"; expected number, range, #id, or 'all'`,
      };
    }
    const n = parseInt(p, 10);
    if (n < 1) {
      return {
        selector: { kind: "all" },
        include,
        error: `index must be >= 1, got "${p}"`,
      };
    }
    indices.push(n);
  }
  return {
    selector: { kind: "indices", indices },
    include,
    maxToolRounds,
    reportPath,
  };
}

/**
 * Map a user-supplied --include value to a canonical policy. Returns null
 * for unrecognized values so the caller can surface a precise error.
 */
function parseIncludePolicy(raw: string): IncludePolicy | null {
  switch (raw.trim().toLowerCase()) {
    case "confirmed":
      return "confirmed";
    case "probable":
      return "probable";
    case "all":
    case "candidate":
      return "candidate";
    default:
      return null;
  }
}

/** Confidence tiers eligible under each policy. */
const CONFIDENCE_FLOOR: Record<IncludePolicy, ReadonlySet<Confidence>> = {
  confirmed: new Set(["confirmed"]),
  probable: new Set(["confirmed", "probable"]),
  candidate: new Set(["confirmed", "probable", "candidate"]),
};

/** True iff the finding's confidence is in scope for the given policy. */
function passesIncludePolicy(
  finding: Finding,
  include: IncludePolicy,
): boolean {
  // Findings from older sidecars without a confidence field default to
  // `"candidate"` at parse time. The default policy ("confirmed") will
  // therefore correctly filter them out, which is what we want.
  return CONFIDENCE_FLOOR[include].has(finding.confidence);
}

/**
 * Apply a parsed selector AND the confidence policy to a flat findings
 * list. Returns the filtered subset, an error when the selector references
 * missing items, or a precise error when the selector matched but every
 * match was filtered out by the confidence floor.
 *
 * Default policy is `"confirmed"`. Callers that want broader scope must
 * opt in via `--include=probable` or `--include=all`.
 */
export function filterFindings(
  findings: Finding[],
  selector: FixSelector,
  include: IncludePolicy = "confirmed",
): { findings: Finding[]; error?: string } {
  // Step 1: select.
  const selected = selectBySelector(findings, selector);
  if ("error" in selected) {
    return { findings: [], error: selected.error };
  }
  // Step 2: filter by confidence.
  const passed: Finding[] = [];
  const filteredOut: Finding[] = [];
  for (const f of selected.findings) {
    if (passesIncludePolicy(f, include)) {
      passed.push(f);
    } else {
      filteredOut.push(f);
    }
  }
  if (passed.length === 0 && filteredOut.length > 0) {
    const tiers = Array.from(
      new Set(filteredOut.map((f) => f.confidence)),
    ).join(", ");
    return {
      findings: [],
      error: `selector matched ${filteredOut.length} finding${filteredOut.length === 1 ? "" : "s"}; all were filtered out by confidence policy --include=${include} (matched tiers: ${tiers}). Use --include=${include === "confirmed" ? "probable" : "all"} to widen the scope.`,
    };
  }
  return { findings: passed };
}

function selectBySelector(
  findings: Finding[],
  selector: FixSelector,
): { findings: Finding[] } | { error: string } {
  if (selector.kind === "all") {
    return { findings: findings.slice() };
  }
  if (selector.kind === "indices") {
    const missing: number[] = [];
    const out: Finding[] = [];
    const seen = new Set<number>();
    for (const idx of selector.indices) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      if (idx < 1 || idx > findings.length) {
        missing.push(idx);
        continue;
      }
      out.push(findings[idx - 1]);
    }
    if (missing.length > 0) {
      return {
        error: `no findings at index ${missing.join(",")}; report has ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      };
    }
    return { findings: out };
  }
  // ids
  const byId = new Map<string, Finding>();
  for (const f of findings) byId.set(f.id, f);
  const missing: string[] = [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const id of selector.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const f = byId.get(id);
    if (!f) {
      missing.push(id);
      continue;
    }
    out.push(f);
  }
  if (missing.length > 0) {
    return {
      error: `no findings with id ${missing.map((s) => `#${s}`).join(",")}; ids in report: ${findings.map((f) => `#${f.id}`).join(", ") || "(none)"}`,
    };
  }
  return { findings: out };
}

/**
 * Build the user-message string sent to the fix-mode agent. The shape
 * matches the OUTPUT CONTRACT block in `FIX_SYSTEM_PROMPT` so the agent
 * has unambiguous input. We deliberately repeat each finding's id and
 * its 1-based index so the agent's APPLIED/SKIPPED report can use
 * either form.
 */
export function buildFixPrompt(
  report: AuditReport,
  findings: Finding[],
  reportPath: string,
): string {
  const lines: string[] = [];
  lines.push(
    `Apply ${findings.length} finding${findings.length === 1 ? "" : "s"} from the audit report at ${reportPath}.`,
  );
  if (report.scope) {
    lines.push(`Audit scope: ${report.scope}`);
  }
  lines.push("");
  lines.push("Findings to apply (authoritative; do not re-investigate):");
  lines.push("");
  findings.forEach((f, i) => {
    const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    lines.push(`${i + 1}. #${f.id} [${f.severity}] ${loc}`);
    if (f.description) lines.push(`   description: ${f.description}`);
    if (f.suggested_fix) lines.push(`   suggested fix: ${f.suggested_fix}`);
    lines.push("");
  });
  lines.push(
    "Apply each finding using read_file + edit_file. Skip and report any that cannot be safely applied. After all edits are issued, optionally run typecheck to verify, then produce the APPLIED/SKIPPED/VERIFIED block per your system prompt.",
  );
  return lines.join("\n");
}
