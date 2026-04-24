// Regression tests for the Second Pass findings parser.
//
// Run with `pnpm test` (Node v22 built-in test runner; --experimental-
// strip-types takes care of the TypeScript). No new dev-deps required.

import test from "node:test";
import assert from "node:assert/strict";

import { parseAuditTranscript } from "../src/findings.ts";

// ---------------------------------------------------------------------------
// Bug fixed: trailing `FINDINGS (0)` summary used to silently overwrite the
// real findings. This is the exact transcript captured in
// `<repo>/.prism/second-pass/audit-2026-04-24T21-32-01.md` against
// StellarumAtlas, where `prism-second-pass` reported 0 findings even though
// the model emitted one.
// ---------------------------------------------------------------------------
test("preserves findings when a stray FINDINGS (0) summary follows", () => {
  const transcript = [
    "FINDINGS (1)",
    'error src/services/essays.ts:6 \u2014 Import for describeStrategy specifies wrong file extension (.js instead of .ts) \u2014 update to "../utils/strategy-description.ts" to match actual file name and avoid TypeScript compile error',
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
  const transcript = [
    "FINDINGS (2)",
    "[error] src/foo.ts:42 \u2014 stale import \u2014 remove it",
    "[warning] src/bar.ts:10 \u2014 unused export \u2014 delete or use",
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.errors, 1);
  assert.equal(r.summary.warnings, 1);
  assert.deepEqual(
    r.findings.map((f) => f.severity),
    ["error", "warning"],
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
    "[warning] b.ts:2 \u2014 d \u2014 f",
    "[info] c.ts:3 \u2014 d \u2014 f",
  ].join("\n");
  const r = parseAuditTranscript(transcript, { model: "m", scope: null });
  assert.deepEqual(
    r.findings.map((f) => f.id),
    ["F1", "F2", "F3"],
  );
});
