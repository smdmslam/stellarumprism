// Regression tests for the Problems panel pure helpers.
// Covers filtering, grouping, counts, HTML rendering, and the /problems
// argument parser. Same Node v22 built-in test runner as the rest of the
// suite; no new dev-deps.

import test from "node:test";
import assert from "node:assert/strict";

import {
  countFindings,
  defaultFilter,
  filterFindings,
  groupByFile,
  parseProblemsArgs,
  renderProblemsPanel,
  toggleConfidence,
  toggleSeverity,
} from "../src/problems.ts";
import type {
  AuditReport,
  Finding,
  RuntimeProbe,
} from "../src/findings.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: over.id ?? "F1",
    severity: over.severity ?? "warning",
    confidence: over.confidence ?? "probable",
    source: over.source ?? "ast",
    file: over.file ?? "src/a.ts",
    line: over.line ?? 1,
    description: over.description ?? "d",
    suggested_fix: over.suggested_fix ?? "",
    evidence: over.evidence ?? [{ source: "ast", detail: "ast detail" }],
  };
}

function reportFor(
  findings: Finding[],
  probes: RuntimeProbe[] = [],
): AuditReport {
  return {
    schema_version: 1,
    tool: "prism-second-pass",
    generated_at: "2026-04-25T00:00:00.000Z",
    scope: "HEAD~1..HEAD",
    model: "m",
    summary: countSummary(findings),
    findings,
    runtime_probes: probes,
    substrate_runs: [],
    raw_transcript: "",
  };
}

function countSummary(findings: Finding[]) {
  let errors = 0,
    warnings = 0,
    info = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
    else info++;
  }
  return { errors, warnings, info, total: findings.length };
}

// ---------------------------------------------------------------------------
// filterFindings + counts + groupByFile
// ---------------------------------------------------------------------------

test("filterFindings respects severity set", () => {
  const findings = [
    finding({ id: "F1", severity: "error" }),
    finding({ id: "F2", severity: "warning" }),
    finding({ id: "F3", severity: "info" }),
  ];
  const filter = defaultFilter();
  filter.severities.delete("info");
  const out = filterFindings(findings, filter);
  assert.deepEqual(
    out.map((f) => f.id),
    ["F1", "F2"],
  );
});

test("filterFindings respects confidence set", () => {
  const findings = [
    finding({ id: "F1", confidence: "confirmed" }),
    finding({ id: "F2", confidence: "probable" }),
    finding({ id: "F3", confidence: "candidate" }),
  ];
  const filter = defaultFilter();
  filter.confidences.delete("candidate");
  const out = filterFindings(findings, filter);
  assert.deepEqual(
    out.map((f) => f.id),
    ["F1", "F2"],
  );
});

test("countFindings tallies severity and confidence", () => {
  const counts = countFindings([
    finding({ id: "F1", severity: "error", confidence: "confirmed" }),
    finding({ id: "F2", severity: "warning", confidence: "probable" }),
    finding({ id: "F3", severity: "info", confidence: "candidate" }),
    finding({ id: "F4", severity: "warning", confidence: "candidate" }),
  ]);
  assert.equal(counts.total, 4);
  assert.equal(counts.errors, 1);
  assert.equal(counts.warnings, 2);
  assert.equal(counts.info, 1);
  assert.equal(counts.confirmed, 1);
  assert.equal(counts.probable, 1);
  assert.equal(counts.candidate, 2);
});

test("groupByFile preserves first-appearance order and sorts within each file", () => {
  const findings = [
    finding({ id: "F1", file: "b.ts", line: 5 }),
    finding({ id: "F2", file: "a.ts", line: 10 }),
    finding({ id: "F3", file: "a.ts", line: 2 }),
    finding({ id: "F4", file: "b.ts", line: 3 }),
  ];
  const grouped = groupByFile(findings);
  // First-appearance order: b.ts comes before a.ts.
  assert.deepEqual(Array.from(grouped.keys()), ["b.ts", "a.ts"]);
  // Within each file, ascending by line.
  assert.deepEqual(
    grouped.get("b.ts")!.map((f) => f.id),
    ["F4", "F1"],
  );
  assert.deepEqual(
    grouped.get("a.ts")!.map((f) => f.id),
    ["F3", "F2"],
  );
});

// ---------------------------------------------------------------------------
// toggleSeverity / toggleConfidence
// ---------------------------------------------------------------------------

test("toggleSeverity flips membership without mutating input", () => {
  const f = defaultFilter();
  const next = toggleSeverity(f, "info");
  assert.ok(f.severities.has("info"), "input filter unchanged");
  assert.ok(!next.severities.has("info"));
  const back = toggleSeverity(next, "info");
  assert.ok(back.severities.has("info"));
});

test("toggleConfidence flips membership without mutating input", () => {
  const f = defaultFilter();
  const next = toggleConfidence(f, "candidate");
  assert.ok(f.confidences.has("candidate"));
  assert.ok(!next.confidences.has("candidate"));
});

// ---------------------------------------------------------------------------
// renderProblemsPanel
// ---------------------------------------------------------------------------

test("renderProblemsPanel shows initial empty state when report is null", () => {
  const html = renderProblemsPanel(null, defaultFilter());
  assert.match(html, /No audit results yet\./);
  assert.match(html, /\/audit/);
  // No filter chips when there's no report.
  assert.doesNotMatch(html, /problems-chip/);
});

test("renderProblemsPanel shows clean state when audit found nothing", () => {
  const r = reportFor([]);
  const html = renderProblemsPanel(r, defaultFilter());
  assert.match(html, /Audit completed cleanly/);
  // Header is still rendered so the user sees scope + close button.
  assert.match(html, /problems-header/);
});

test("renderProblemsPanel renders findings grouped by file with chip counts", () => {
  const r = reportFor([
    finding({
      id: "F1",
      file: "src/a.ts",
      line: 3,
      severity: "error",
      confidence: "confirmed",
      description: "stale import",
      suggested_fix: "remove it",
    }),
    finding({
      id: "F2",
      file: "src/a.ts",
      line: 10,
      severity: "warning",
      confidence: "probable",
    }),
    finding({
      id: "F3",
      file: "src/b.ts",
      line: 1,
      severity: "info",
      confidence: "candidate",
    }),
  ]);
  const html = renderProblemsPanel(r, defaultFilter());
  // Chips present and counted correctly.
  assert.match(html, /data-filter-kind="severity" data-filter-value="error"/);
  assert.match(html, /data-filter-kind="confidence" data-filter-value="confirmed"/);
  // Files appear in input order.
  const aIdx = html.indexOf("src/a.ts");
  const bIdx = html.indexOf("src/b.ts");
  assert.ok(aIdx >= 0 && bIdx >= 0 && aIdx < bIdx);
  // Suggested fix block surfaces.
  assert.match(html, /class="problems-fix"/);
  assert.match(html, /remove it/);
  // Each row has an id + loc for click-to-copy.
  assert.match(html, /data-finding-id="F1"/);
  assert.match(html, /data-loc="src\/a\.ts:3"/);
});

test("renderProblemsPanel surfaces 'all filtered out' when chips zero out the list", () => {
  const r = reportFor([
    finding({ severity: "info", confidence: "candidate" }),
  ]);
  const filter = defaultFilter();
  filter.severities.delete("info");
  const html = renderProblemsPanel(r, filter);
  assert.match(html, /All findings filtered out/);
});

test("renderProblemsPanel includes runtime probes section when present", () => {
  const probes: RuntimeProbe[] = [
    {
      url: "http://localhost:3000/api/login",
      method: "POST",
      summary: "http_fetch POST /api/login \u2192 401 Unauthorized",
      ok: true,
      round: 1,
    },
    {
      url: "http://localhost:3000/api/health",
      method: "GET",
      summary: "http_fetch GET /api/health \u2192 transport error",
      ok: false,
      round: 2,
    },
  ];
  const r = reportFor([finding()], probes);
  const html = renderProblemsPanel(r, defaultFilter());
  assert.match(html, /problems-probes/);
  assert.match(html, /1 ok, 1 fail/);
  assert.match(html, /\/api\/login/);
  assert.match(html, /probe-row fail/);
});

test("renderProblemsPanel escapes HTML in user-provided fields", () => {
  const r = reportFor([
    finding({
      file: "src/<bad>.ts",
      description: '"><script>alert(1)</script>',
    }),
  ]);
  const html = renderProblemsPanel(r, defaultFilter());
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /src\/&lt;bad&gt;\.ts/);
});

// ---------------------------------------------------------------------------
// parseProblemsArgs
// ---------------------------------------------------------------------------

test("parseProblemsArgs defaults to toggle on empty input", () => {
  assert.equal(parseProblemsArgs("").action, "toggle");
  assert.equal(parseProblemsArgs("   ").action, "toggle");
});

test("parseProblemsArgs accepts show/hide/toggle/clear and aliases", () => {
  assert.equal(parseProblemsArgs("show").action, "show");
  assert.equal(parseProblemsArgs("open").action, "show");
  assert.equal(parseProblemsArgs("hide").action, "hide");
  assert.equal(parseProblemsArgs("close").action, "hide");
  assert.equal(parseProblemsArgs("toggle").action, "toggle");
  assert.equal(parseProblemsArgs("clear").action, "clear");
  assert.equal(parseProblemsArgs("reset").action, "clear");
});

test("parseProblemsArgs reports unknown args without throwing", () => {
  const r = parseProblemsArgs("zoom");
  assert.equal(r.action, "toggle");
  assert.match(r.error ?? "", /unknown \/problems arg "zoom"/);
});
