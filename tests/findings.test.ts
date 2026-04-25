// Regression tests for the Second Pass findings parser.
//
// Run with `pnpm test` (Node v22 built-in test runner; --experimental-
// strip-types takes care of the TypeScript). No new dev-deps required.

import test from "node:test";
import assert from "node:assert/strict";

import { gradeFinding, parseAuditTranscript } from "../src/findings.ts";

// ---------------------------------------------------------------------------
// Bug fixed: trailing `FINDINGS (0)` summary used to silently overwrite the
// real findings. This is the exact transcript captured in
// `<repo>/.prism/second-pass/audit-2026-04-24T21-32-01.md` against
// StellarumAtlas, where `prism-second-pass` reported 0 findings even though
// the model emitted one.
// ---------------------------------------------------------------------------
test("preserves findings when a stray FINDINGS (0) summary follows", () => {
  // The model emits a real finding with a typecheck-backed evidence
  // stanza, then a trailing summary block. The block-based parser must
  // pick the first (non-empty) block; the grader must respect the
  // typecheck evidence and keep the finding at confirmed/error.
  const transcript = [
    "FINDINGS (1)",
    'error src/services/essays.ts:6 \u2014 Import for describeStrategy specifies wrong file extension (.js instead of .ts) \u2014 update to "../utils/strategy-description.ts" to match actual file name and avoid TypeScript compile error',
    'evidence: source=typecheck; detail="src/services/essays.ts(6,1): error TS2305: Cannot find module \'../utils/strategy-description.js\'"',
    "",
    "FINDINGS (0) \u2014 0 error, 0 warning, 0 info",
    "No wiring gaps surfaced. See raw transcript in the markdown report for details.",
  ].join("\n");

  const r = parseAuditTranscript(transcript, {
    model: "x-ai/grok-4-fast",
    scope: "HEAD~10..HEAD",
  });

  assert.equal(r.summary.total, 1, "expected 1 finding to survive");
  assert.equal(r.summary.errors, 1);
  assert.equal(r.findings[0].severity, "error");
  assert.equal(r.findings[0].confidence, "confirmed");
  assert.equal(r.findings[0].source, "typecheck");
  assert.equal(r.findings[0].file, "src/services/essays.ts");
  assert.equal(r.findings[0].line, 6);
  assert.match(r.findings[0].description, /describeStrategy/);
  assert.match(r.findings[0].suggested_fix, /strategy-description/);
});

test("zero-finding audit stays at zero", () => {
  const r = parseAuditTranscript(
    "FINDINGS (0)\nNo issues detected for HEAD~3..HEAD.",
    { model: "x-ai/grok-4-fast", scope: null },
  );
  assert.equal(r.summary.total, 0);
  assert.equal(r.findings.length, 0);
});

test("bracketed severity (canonical format) still parses", () => {
  // Each finding includes an evidence stanza so the grader can keep the
  // claimed severity (error needs a confirmed-tier source).
  const transcript = [
    "FINDINGS (2)",
    "[error] src/foo.ts:42 \u2014 stale import \u2014 remove it",
    'evidence: source=typecheck; detail="src/foo.ts(42,1): error TS2304"',
    "[warning] src/bar.ts:10 \u2014 unused export \u2014 delete or use",
    'evidence: source=ast; detail="no callers"',
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.errors, 1);
  assert.equal(r.summary.warnings, 1);
  assert.deepEqual(
    r.findings.map((f) => f.severity),
    ["error", "warning"],
  );
  assert.deepEqual(
    r.findings.map((f) => f.confidence),
    ["confirmed", "probable"],
  );
});

test("loose severity requires a path:line token (no prose false positives)", () => {
  // Lines that start with severity words but lack a path:line shape
  // should NOT be treated as findings.
  const transcript = [
    "error: I think the diff looks fine.",
    "warning, this approach is risky in production.",
    "info on the next steps to take.",
    "FINDINGS (0)",
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.equal(r.summary.total, 0);
});

test("findings without any header are still captured", () => {
  // Some models skip the FINDINGS (N) header line entirely.
  const transcript =
    "[error] src/index.ts:1 \u2014 leftover console.log \u2014 remove";
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.equal(r.summary.total, 1);
});

test("multiple non-empty blocks: most recent wins", () => {
  // If the model re-emits findings (e.g. revised list after a tool call),
  // the trailing block is canonical.
  const transcript = [
    "FINDINGS (1)",
    "[error] src/old.ts:5 \u2014 obsolete \u2014 delete",
    "FINDINGS (2)",
    "[error] src/new.ts:1 \u2014 a \u2014 fix a",
    "[warning] src/new.ts:2 \u2014 b \u2014 fix b",
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.equal(r.summary.total, 2);
  assert.equal(r.findings[0].file, "src/new.ts");
  assert.equal(r.findings[1].file, "src/new.ts");
});

test("findings carry sequential ids 1..N within the chosen block", () => {
  const transcript = [
    "FINDINGS (3)",
    "[error] a.ts:1 \u2014 d \u2014 f",
    "evidence: source=typecheck; detail=\"a.ts(1,1): error TS1: d\"",
    "[warning] b.ts:2 \u2014 d \u2014 f",
    "evidence: source=ast; detail=\"unresolved import\"",
    "[info] c.ts:3 \u2014 d \u2014 f",
    "evidence: source=grep; detail=\"grep foo: 0 hits\"",
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.deepEqual(
    r.findings.map((f) => f.id),
    ["F1", "F2", "F3"],
  );
});

// ---------------------------------------------------------------------------
// gradeFinding \u2014 the deterministic confidence grader
// ---------------------------------------------------------------------------

function rawFinding(overrides: {
  severity?: "error" | "warning" | "info";
  evidence?: { source: string; detail: string }[];
}): any {
  return {
    id: "F1",
    severity: overrides.severity ?? "warning",
    claimed_severity: overrides.severity ?? "warning",
    file: "src/x.ts",
    line: 1,
    description: "d",
    suggested_fix: "f",
    evidence: overrides.evidence ?? [],
  };
}

test("grader: typecheck evidence \u2192 confirmed", () => {
  const f = gradeFinding(
    rawFinding({
      severity: "error",
      evidence: [{ source: "typecheck", detail: "x.ts(1,1): error TS1" }],
    }),
  );
  assert.equal(f.confidence, "confirmed");
  assert.equal(f.source, "typecheck");
  assert.equal(f.severity, "error");
});

test("grader: lsp/runtime/test evidence \u2192 confirmed", () => {
  for (const src of ["lsp", "runtime", "test"] as const) {
    const f = gradeFinding(
      rawFinding({
        severity: "error",
        evidence: [{ source: src, detail: "signal" }],
      }),
    );
    assert.equal(f.confidence, "confirmed", `${src} should be confirmed`);
    assert.equal(f.source, src);
  }
});

test("grader: ast-only evidence \u2192 probable", () => {
  const f = gradeFinding(
    rawFinding({
      severity: "warning",
      evidence: [{ source: "ast", detail: "unresolved binding" }],
    }),
  );
  assert.equal(f.confidence, "probable");
  assert.equal(f.source, "ast");
  assert.equal(f.severity, "warning");
});

test("grader: grep-only evidence \u2192 candidate", () => {
  const f = gradeFinding(
    rawFinding({
      severity: "warning",
      evidence: [{ source: "grep", detail: "grep foo: 0 hits" }],
    }),
  );
  assert.equal(f.confidence, "candidate");
  assert.equal(f.source, "grep");
  assert.equal(f.severity, "warning");
});

test("grader: candidate caps severity at warning (error \u2192 warning)", () => {
  const f = gradeFinding(
    rawFinding({
      severity: "error",
      evidence: [{ source: "grep", detail: "grep foo: 0 hits" }],
    }),
  );
  assert.equal(f.confidence, "candidate");
  assert.equal(f.severity, "warning", "error should be capped to warning for candidate");
  // Original severity is preserved in the evidence trail for transparency.
  const trailDetail = f.evidence.map((e) => e.detail).join(" || ");
  assert.match(trailDetail, /downgraded from "error" to "warning"/);
});

test("grader: no evidence at all \u2192 candidate, severity capped", () => {
  const f = gradeFinding(
    rawFinding({
      severity: "error",
      evidence: [],
    }),
  );
  assert.equal(f.confidence, "candidate");
  assert.equal(f.severity, "warning");
  assert.equal(f.source, "llm");
});

test("grader: confirmed source wins over weaker peers", () => {
  // Multiple receipts: a typecheck line plus a grep hit for context. The
  // confirmed tier should win regardless of order.
  const f = gradeFinding(
    rawFinding({
      severity: "error",
      evidence: [
        { source: "grep", detail: "grep foo: 1 hit @ x.ts:1" },
        { source: "typecheck", detail: "x.ts(1,1): error TS1" },
      ],
    }),
  );
  assert.equal(f.confidence, "confirmed");
  assert.equal(f.source, "typecheck");
});

test("parser: evidence line attaches to preceding finding", () => {
  const transcript = [
    "FINDINGS (1)",
    "[error] x.ts:1 \u2014 d \u2014 f",
    'evidence: source=typecheck; detail="x.ts(1,1): error TS1"',
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].confidence, "confirmed");
  assert.equal(r.findings[0].source, "typecheck");
  assert.equal(r.findings[0].evidence.length, 1);
  assert.equal(r.findings[0].evidence[0].source, "typecheck");
});

test("parser: missing evidence \u2192 graded as candidate, severity capped", () => {
  const transcript = [
    "FINDINGS (1)",
    "[error] x.ts:1 \u2014 wired to undefined handler \u2014 fix",
    // No evidence line. Mirrors the OM false-positive class.
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].confidence, "candidate");
  assert.equal(r.findings[0].severity, "warning");
});

test("parser: multiple evidence receipts split by '|'", () => {
  const transcript = [
    "FINDINGS (1)",
    "[error] x.ts:1 \u2014 d \u2014 f",
    'evidence: source=typecheck; detail="x.ts(1,1): error TS1" | source=grep; detail="grep foo: 3 hits"',
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].confidence, "confirmed");
  assert.equal(r.findings[0].evidence.length, 2);
  assert.deepEqual(
    r.findings[0].evidence.map((e) => e.source),
    ["typecheck", "grep"],
  );
});
