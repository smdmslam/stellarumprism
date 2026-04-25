// Regression tests for the /build slash command's argument parser.
// Same Node v22 built-in test runner as the rest of the suite; no
// new dev-deps.

import test from "node:test";
import assert from "node:assert/strict";

import { buildBuildPrompt, parseBuildArgs } from "../src/build.ts";

// ---------------------------------------------------------------------------
// parseBuildArgs
// ---------------------------------------------------------------------------

test("empty input errors with a precise message", () => {
  const r = parseBuildArgs("");
  assert.equal(r.feature, "");
  assert.match(r.error ?? "", /expects a feature description/);
});

test("whitespace-only input errors", () => {
  const r = parseBuildArgs("   ");
  assert.equal(r.feature, "");
  assert.match(r.error ?? "", /expects a feature description/);
});

test("single-word feature parses", () => {
  const r = parseBuildArgs("checkout");
  assert.equal(r.feature, "checkout");
  assert.equal(r.error, undefined);
  assert.equal(r.maxToolRounds, undefined);
});

test("multi-word feature preserves spacing", () => {
  const r = parseBuildArgs("add Google auth to the landing page");
  assert.equal(r.feature, "add Google auth to the landing page");
});

test("--max-rounds=N flag is parsed and stripped from feature", () => {
  const r = parseBuildArgs("--max-rounds=120 add Stripe checkout");
  assert.equal(r.feature, "add Stripe checkout");
  assert.equal(r.maxToolRounds, 120);
});

test("--max-rounds=N can come after the feature", () => {
  const r = parseBuildArgs("add settings page --max-rounds=80");
  assert.equal(r.feature, "add settings page");
  assert.equal(r.maxToolRounds, 80);
});

test("--max-rounds N (space form)", () => {
  const r = parseBuildArgs("--max-rounds 200 build the dashboard");
  assert.equal(r.feature, "build the dashboard");
  assert.equal(r.maxToolRounds, 200);
});

test("--max-rounds rejects non-positive values", () => {
  const r = parseBuildArgs("--max-rounds=0 add auth");
  assert.match(r.error ?? "", /positive integer/);
});

test("--max-rounds rejects non-numeric values", () => {
  const r = parseBuildArgs("--max-rounds=lots add auth");
  assert.match(r.error ?? "", /positive integer/);
});

test("--max-rounds without value errors", () => {
  const r = parseBuildArgs("--max-rounds");
  assert.match(r.error ?? "", /expects a value/);
});

test("only flags, no feature, errors", () => {
  const r = parseBuildArgs("--max-rounds=120");
  assert.match(r.error ?? "", /expects a feature description/);
});

test("feature with hyphens and slashes survives intact", () => {
  const r = parseBuildArgs(
    "add @auth/google middleware to /api/login route",
  );
  assert.equal(
    r.feature,
    "add @auth/google middleware to /api/login route",
  );
});

// ---------------------------------------------------------------------------
// buildBuildPrompt
// ---------------------------------------------------------------------------

test("buildBuildPrompt embeds the feature description verbatim", () => {
  const out = buildBuildPrompt("add a dark-mode toggle to the navbar");
  assert.match(out, /Feature: add a dark-mode toggle to the navbar/);
  assert.match(out, /substrate-gated flow/);
  assert.match(out, /Start with PLAN/);
});

test("buildBuildPrompt mentions the verification stages", () => {
  const out = buildBuildPrompt("anything");
  assert.match(out, /BASELINE typecheck/);
  assert.match(out, /BUILD REPORT/);
});
