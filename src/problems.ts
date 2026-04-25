// Pure helpers for the Problems panel.
//
// Lives in its own file so:
//   1. The renderer is unit-testable without spinning up a Tauri runtime.
//   2. The UI surface in `workspace.ts` stays focused on DOM wiring.
//
// The panel is the first user-visible IDE-shaped surface in Prism: it
// renders the same `Finding[]` array the audit JSON sidecar carries,
// grouped by file, with severity/confidence filter chips. Click-to-copy
// is wired by the workspace; this module emits HTML the workspace can
// drop straight into the panel container.

import type {
  AuditReport,
  Confidence,
  Finding,
  Severity,
} from "./findings";

/** Filter state for the panel. Each set is "show me these tiers". */
export interface ProblemsFilter {
  severities: Set<Severity>;
  confidences: Set<Confidence>;
}

/** Default filter: everything visible. */
export function defaultFilter(): ProblemsFilter {
  return {
    severities: new Set<Severity>(["error", "warning", "info"]),
    confidences: new Set<Confidence>([
      "confirmed",
      "probable",
      "candidate",
    ]),
  };
}

/** Apply a filter to the report's findings. Pure; safe to call on every render. */
export function filterFindings(
  findings: Finding[],
  filter: ProblemsFilter,
): Finding[] {
  return findings.filter(
    (f) =>
      filter.severities.has(f.severity) &&
      filter.confidences.has(f.confidence),
  );
}

/**
 * Group findings by file path. Order of files preserved by first
 * appearance in the input list so the panel reflects the audit order.
 */
export function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.file || "(unknown)";
    const arr = out.get(key);
    if (arr) {
      arr.push(f);
    } else {
      out.set(key, [f]);
    }
  }
  // Stable sort within each file by line number, then severity.
  for (const arr of out.values()) {
    arr.sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return severityRank(a.severity) - severityRank(b.severity);
    });
  }
  return out;
}

/** error < warning < info — used for tie-breaking sorts. */
function severityRank(s: Severity): number {
  switch (s) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}

/** Counts shown in the panel header / filter chips. */
export interface ProblemsCounts {
  errors: number;
  warnings: number;
  info: number;
  total: number;
  confirmed: number;
  probable: number;
  candidate: number;
}

export function countFindings(findings: Finding[]): ProblemsCounts {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  let confirmed = 0;
  let probable = 0;
  let candidate = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
    else info++;
    if (f.confidence === "confirmed") confirmed++;
    else if (f.confidence === "probable") probable++;
    else candidate++;
  }
  return {
    errors,
    warnings,
    info,
    total: findings.length,
    confirmed,
    probable,
    candidate,
  };
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

/**
 * Render the panel body as an HTML string. Stable, deterministic, and
 * easy to snapshot. The workspace appends this into the panel
 * container and wires click handlers via event delegation on the
 * `data-finding-id` attribute.
 *
 * Empty states (no report, all filtered out, audit found nothing) each
 * produce a distinct message so the user knows whether to open a
 * different filter or run `/audit` first.
 */
export function renderProblemsPanel(
  report: AuditReport | null,
  filter: ProblemsFilter,
): string {
  if (!report) {
    return renderEmptyState(
      "No audit results yet.",
      "Run <code>/audit</code> to surface findings here.",
    );
  }
  if (report.findings.length === 0) {
    return (
      renderHeader(report, countFindings([]), filter) +
      renderEmptyState(
        "Audit completed cleanly.",
        "No wiring gaps surfaced for this scope.",
      )
    );
  }
  const visible = filterFindings(report.findings, filter);
  const counts = countFindings(report.findings);
  const headerHtml = renderHeader(report, counts, filter);
  if (visible.length === 0) {
    return (
      headerHtml +
      renderEmptyState(
        "All findings filtered out.",
        "Adjust the filter chips above to see them.",
      )
    );
  }
  const groups = groupByFile(visible);
  const groupsHtml: string[] = [];
  for (const [file, arr] of groups) {
    groupsHtml.push(renderFileGroup(file, arr));
  }
  return (
    headerHtml +
    `<div class="problems-list">${groupsHtml.join("")}</div>` +
    renderRuntimeProbeFooter(report)
  );
}

function renderHeader(
  report: AuditReport,
  counts: ProblemsCounts,
  filter: ProblemsFilter,
): string {
  const scope = report.scope ? ` <span class="problems-scope">${escapeHtml(
    report.scope,
  )}</span>` : "";
  // Severity chips. Each one has a `data-severity` attribute the panel
  // listener uses to toggle the filter set.
  const sevChips = (
    [
      { sev: "error" as const, label: "errors", n: counts.errors },
      { sev: "warning" as const, label: "warnings", n: counts.warnings },
      { sev: "info" as const, label: "info", n: counts.info },
    ]
  )
    .map((c) => {
      const active = filter.severities.has(c.sev);
      return (
        `<button class="problems-chip ${active ? "active" : ""} sev-${c.sev}" ` +
        `data-filter-kind="severity" data-filter-value="${c.sev}" ` +
        `title="Toggle ${c.label}">` +
        `<span class="chip-dot"></span>` +
        `<span class="chip-count">${c.n}</span>` +
        `<span class="chip-label">${c.label}</span>` +
        `</button>`
      );
    })
    .join("");
  const confChips = (
    [
      { conf: "confirmed" as const, label: "confirmed", n: counts.confirmed },
      { conf: "probable" as const, label: "probable", n: counts.probable },
      { conf: "candidate" as const, label: "candidate", n: counts.candidate },
    ]
  )
    .map((c) => {
      const active = filter.confidences.has(c.conf);
      return (
        `<button class="problems-chip ${active ? "active" : ""} conf-${c.conf}" ` +
        `data-filter-kind="confidence" data-filter-value="${c.conf}" ` +
        `title="Toggle ${c.label}">` +
        `<span class="chip-dot"></span>` +
        `<span class="chip-count">${c.n}</span>` +
        `<span class="chip-label">${c.label}</span>` +
        `</button>`
      );
    })
    .join("");
  // Relative-time subline so the user can tell at a glance whether the
  // findings reflect their current code or a stale audit. Format mirrors
  // the conventional "3m ago" shorthand used elsewhere.
  const subline =
    `<div class="problems-subline">` +
    `<span class="problems-when" title="${escapeAttr(report.generated_at)}">audit \u00b7 ${escapeHtml(formatRelativeTime(report.generated_at))}</span>` +
    (report.scope
      ? ` <span class="problems-when-scope">scope ${escapeHtml(report.scope)}</span>`
      : "") +
    `</div>`;
  return (
    `<div class="problems-header">` +
    `<div class="problems-title">` +
    `<span class="problems-title-text">Problems</span>` +
    `<span class="problems-total">${counts.total}</span>` +
    scope +
    `<button class="problems-close" data-problems-action="close" title="Close panel (Esc)">×</button>` +
    `</div>` +
    subline +
    `<div class="problems-chips">${sevChips}</div>` +
    `<div class="problems-chips">${confChips}</div>` +
    `</div>`
  );
}

/**
 * Render an ISO-8601 timestamp as a coarse-grained "how long ago?"
 * label. Pure; no wall-clock dependency on the caller. Returns the
 * input verbatim if it isn't parseable so we never display garbage.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaMs = now.getTime() - t;
  if (deltaMs < 0) return "just now";
  const secs = Math.floor(deltaMs / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function renderFileGroup(file: string, findings: Finding[]): string {
  const counts = countFindings(findings);
  const rows = findings.map((f) => renderFindingRow(f)).join("");
  return (
    `<div class="problems-group">` +
    `<div class="problems-group-header">` +
    `<span class="problems-file" title="${escapeAttr(file)}">${escapeHtml(file)}</span>` +
    `<span class="problems-group-count">${counts.total}</span>` +
    `</div>` +
    `<ul class="problems-rows">${rows}</ul>` +
    `</div>`
  );
}

function renderFindingRow(f: Finding): string {
  const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
  const sources =
    f.evidence.length > 0
      ? Array.from(new Set(f.evidence.map((e) => e.source))).join(", ")
      : f.source;
  const fixHtml = f.suggested_fix
    ? `<div class="problems-fix"><span class="fix-label">fix:</span> ${escapeHtml(
        f.suggested_fix,
      )}</div>`
    : "";
  // The row expands to show a code snippet around f.line when clicked.
  // The snippet container is rendered empty up front; the workspace's
  // click handler invokes `read_file_snippet` and fills it on demand.
  // A small copy button preserves the previous click-to-clipboard
  // affordance without making the whole row a copy target.
  return (
    `<li class="problems-row sev-${f.severity} conf-${f.confidence}" ` +
    `data-finding-id="${escapeAttr(f.id)}" ` +
    `data-loc="${escapeAttr(loc)}" ` +
    `data-file="${escapeAttr(f.file)}" ` +
    `data-line="${f.line}" ` +
    `data-expanded="false" ` +
    `data-snippet-loaded="false" ` +
    `tabindex="0" title="Click to expand snippet">` +
    `<span class="problems-dot sev-${f.severity}" aria-label="severity ${f.severity}"></span>` +
    `<span class="problems-line">${f.line > 0 ? f.line : "\u2014"}</span>` +
    `<span class="problems-desc">${escapeHtml(f.description || "(no description)")}</span>` +
    `<button class="problems-copy" data-row-action="copy" title="Copy ${escapeAttr(loc)}" tabindex="-1" aria-label="copy path:line">\u29c9</button>` +
    `<span class="problems-meta">[${f.confidence}] (${escapeHtml(sources)})</span>` +
    fixHtml +
    `<div class="problems-snippet" data-snippet-host=""></div>` +
    `</li>`
  );
}

function renderRuntimeProbeFooter(report: AuditReport): string {
  if (report.runtime_probes.length === 0) return "";
  const ok = report.runtime_probes.filter((p) => p.ok).length;
  const fail = report.runtime_probes.length - ok;
  const items = report.runtime_probes
    .map((p) => {
      const cls = p.ok ? "ok" : "fail";
      return (
        `<li class="probe-row ${cls}">` +
        `<span class="probe-status">${p.ok ? "\u2713" : "\u2717"}</span>` +
        `<span class="probe-method">${escapeHtml(p.method)}</span>` +
        `<span class="probe-url">${escapeHtml(p.url)}</span>` +
        `<span class="probe-summary">${escapeHtml(p.summary)}</span>` +
        `</li>`
      );
    })
    .join("");
  return (
    `<div class="problems-probes">` +
    `<div class="problems-probes-header">` +
    `<span class="problems-probes-title">Runtime probes</span>` +
    `<span class="problems-probes-counts">${ok} ok, ${fail} fail</span>` +
    `</div>` +
    `<ul class="problems-probes-list">${items}</ul>` +
    `</div>`
  );
}

function renderEmptyState(title: string, body: string): string {
  return (
    `<div class="problems-empty">` +
    `<div class="problems-empty-title">${escapeHtml(title)}</div>` +
    `<div class="problems-empty-body">${body}</div>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// /problems argument parser
// ---------------------------------------------------------------------------

/**
 * Parsed shape of `/problems [show|hide|toggle|clear]`. `toggle` is
 * the default when no argument is given.
 */
export type ProblemsAction = "show" | "hide" | "toggle" | "clear";

export interface ParsedProblemsArgs {
  action: ProblemsAction;
  error?: string;
}

export function parseProblemsArgs(raw: string): ParsedProblemsArgs {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { action: "toggle" };
  switch (trimmed) {
    case "show":
    case "open":
      return { action: "show" };
    case "hide":
    case "close":
      return { action: "hide" };
    case "toggle":
      return { action: "toggle" };
    case "clear":
    case "reset":
      return { action: "clear" };
    default:
      return {
        action: "toggle",
        error: `unknown /problems arg "${trimmed}"; expected: show, hide, toggle, clear`,
      };
  }
}

// ---------------------------------------------------------------------------
// Filter mutators (kept pure so they're easy to test)
// ---------------------------------------------------------------------------

export function toggleSeverity(
  filter: ProblemsFilter,
  s: Severity,
): ProblemsFilter {
  const next = new Set(filter.severities);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  return { ...filter, severities: next };
}

export function toggleConfidence(
  filter: ProblemsFilter,
  c: Confidence,
): ProblemsFilter {
  const next = new Set(filter.confidences);
  if (next.has(c)) next.delete(c);
  else next.add(c);
  return { ...filter, confidences: next };
}

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, " ");
}
