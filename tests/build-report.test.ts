// Tests for the build-report parser + renderers.
// Same Node v22 built-in test runner as the rest of the suite.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLastBuildIndex,
  buildReportFilename,
  buildReportJsonFilename,
  parseBuildReportTranscript,
  renderAnsiBuildReport,
  renderBuildReportJson,
  renderBuildReportMarkdown,
} from "../src/build-report.ts";

const BUILD_COMPLETED_TRANSCRIPT = `
BUILD COMPLETED

## Plan
1. add /api/auth route
2. wire middleware

## Steps executed
\u2713 add /api/auth \u2014 created handler [verified: typecheck]
\u2713 wire middleware \u2014 registered before authenticated routes [verified: typecheck, ast_query]
\u2298 lint pass \u2014 SKIPPED: not configured

## Final verification
typecheck: pass
ast_query: 4 resolutions confirmed
run_tests: pass
http_fetch: 2 endpoints OK
`;

const BUILD_INCOMPLETE_TRANSCRIPT = `
BUILD INCOMPLETE

## Plan
1. add Stripe webhook
2. handle retries

## Steps executed
\u2713 add webhook \u2014 wrote /api/webhooks/stripe.ts [verified: typecheck]
\u2717 retry policy \u2014 FAILED: third attempt still failing tests

## Final verification
typecheck: 2 errors
run_tests: 5 failures
`;

const RENAME_TRANSCRIPT = `
RENAME REPORT COMPLETED

## Plan
1. resolve canonical declaration via ast_query
2. apply rename across 3 sites

## Steps executed
\u2713 src/foo.ts:12 oldFn \u2192 newFn
\u2713 src/bar.ts:88 oldFn \u2192 newFn
\u2298 README.md \u2014 SKIPPED: docs

## Final verification
typecheck: pass
sites renamed: 2   skipped: 1   failed: 0
`;

const NO_HEADER_BUT_VERIFIED = `
## Plan
1. do thing

## Final verification
typecheck: pass
`;

const FREEFORM_GARBAGE = `
hello

I had some trouble parsing this prompt. Sorry!
`;

// ---------------------------------------------------------------------------
// parseBuildReportTranscript
// ---------------------------------------------------------------------------

test("parses BUILD COMPLETED with full sections", () => {
  const r = parseBuildReportTranscript(BUILD_COMPLETED_TRANSCRIPT, {
    mode: "build",
    model: "anthropic/claude-haiku-4.5",
    feature: "add Google auth",
  });
  assert.equal(r.status, "completed");
  assert.equal(r.feature, "add Google auth");
  assert.equal(r.plan.length, 2);
  assert.equal(r.plan[0], "add /api/auth route");
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[0].outcome, "ok");
  assert.equal(r.steps[2].outcome, "skipped");
  assert.equal(r.verification.typecheck, "pass");
  assert.equal(r.verification.ast_query, "4 resolutions confirmed");
  assert.equal(r.verification.tests, "pass");
  assert.equal(r.verification.http, "2 endpoints OK");
});

test("parses BUILD INCOMPLETE and surfaces failure verifications", () => {
  const r = parseBuildReportTranscript(BUILD_INCOMPLETE_TRANSCRIPT, {
    mode: "build",
    model: "x",
    feature: "Stripe",
  });
  assert.equal(r.status, "incomplete");
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1].outcome, "failed");
  assert.equal(r.verification.typecheck, "2 errors");
  assert.equal(r.verification.tests, "5 failures");
});

test("parses RENAME REPORT and routes unknown verification keys to other[]", () => {
  const r = parseBuildReportTranscript(RENAME_TRANSCRIPT, {
    mode: "refactor",
    model: "x",
    feature: "oldFn -> newFn",
  });
  assert.equal(r.status, "completed");
  assert.equal(r.verification.typecheck, "pass");
  assert.ok(r.verification.other);
  const other = r.verification.other!;
  assert.equal(other.length, 1);
  assert.match(other[0].key, /sites renamed/i);
  assert.match(other[0].value, /skipped: 1/);
});

test("infers status=completed when only verification block is present", () => {
  const r = parseBuildReportTranscript(NO_HEADER_BUT_VERIFIED, {
    mode: "build",
    model: "x",
    feature: "f",
  });
  assert.equal(r.status, "completed");
  assert.equal(r.verification.typecheck, "pass");
});

test("returns status=unknown for freeform garbage", () => {
  const r = parseBuildReportTranscript(FREEFORM_GARBAGE, {
    mode: "build",
    model: "x",
    feature: "f",
  });
  assert.equal(r.status, "unknown");
  assert.equal(r.plan.length, 0);
  assert.equal(r.steps.length, 0);
  assert.equal(Object.keys(r.verification).length, 0);
});

test("preserves raw transcript verbatim", () => {
  const r = parseBuildReportTranscript(BUILD_COMPLETED_TRANSCRIPT, {
    mode: "build",
    model: "x",
    feature: "f",
  });
  assert.equal(r.raw_transcript, BUILD_COMPLETED_TRANSCRIPT);
});

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

test("renderBuildReportJson produces valid JSON round-trippable to the same object", () => {
  const r = parseBuildReportTranscript(BUILD_COMPLETED_TRANSCRIPT, {
    mode: "build",
    model: "x",
    feature: "f",
  });
  const json = renderBuildReportJson(r);
  const back = JSON.parse(json);
  assert.equal(back.status, "completed");
  assert.equal(back.feature, "f");
  assert.equal(back.plan[0], "add /api/auth route");
});

test("renderBuildReportMarkdown emits frontmatter + sections", () => {
  const r = parseBuildReportTranscript(BUILD_COMPLETED_TRANSCRIPT, {
    mode: "build",
    model: "x",
    feature: "f",
  });
  const md = renderBuildReportMarkdown(r);
  assert.match(md, /^---/);
  assert.match(md, /tool: prism-build/);
  assert.match(md, /## Plan/);
  assert.match(md, /## Steps executed/);
  assert.match(md, /## Final verification/);
  assert.match(md, /Raw transcript/);
});

test("renderAnsiBuildReport mentions status, mode, and step counts", () => {
  const r = parseBuildReportTranscript(BUILD_COMPLETED_TRANSCRIPT, {
    mode: "build",
    model: "x",
    feature: "checkout",
  });
  const ansi = renderAnsiBuildReport(r);
  assert.match(ansi, /BUILD COMPLETED/);
  assert.match(ansi, /build/);
  assert.match(ansi, /checkout/);
  assert.match(ansi, /typecheck: pass/);
  assert.match(ansi, /steps: /);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test("buildReportFilename produces colon-free, ISO-derived filename", () => {
  const ts = "2026-04-25T19:32:00.123Z";
  const f = buildReportFilename(ts);
  assert.equal(f, "build-2026-04-25T19-32-00.md");
});

test("buildReportJsonFilename mirrors the markdown name", () => {
  assert.equal(
    buildReportJsonFilename("2026-04-25T19:32:00Z"),
    "build-2026-04-25T19-32-00.json",
  );
});

test("buildLastBuildIndex strips raw transcript and keeps pointer fields", () => {
  const r = parseBuildReportTranscript(BUILD_COMPLETED_TRANSCRIPT, {
    mode: "build",
    model: "x",
    feature: "checkout",
  });
  const idx = buildLastBuildIndex(r, ".prism/builds/build-foo.json");
  assert.equal(idx.path, ".prism/builds/build-foo.json");
  assert.equal(idx.feature, "checkout");
  assert.equal(idx.status, "completed");
  assert.equal(idx.verification.typecheck, "pass");
  assert.equal(idx.verification.tests, "pass");
  // Confirm we did NOT smuggle the raw transcript into the index.
  assert.equal((idx as Record<string, unknown>).raw_transcript, undefined);
});
