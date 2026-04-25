// Regression tests for the /test-gen slash command's argument parser
// and prompt framing. Same Node v22 built-in test runner as the rest of
// the suite; no new dev-deps.

import test from "node:test";
import assert from "node:assert/strict";

import { buildTestGenPrompt, parseTestGenArgs } from "../src/test-gen.ts";

// ---------------------------------------------------------------------------
// parseTestGenArgs
// ---------------------------------------------------------------------------

test("parses a single positional symbol", () => {
  const r = parseTestGenArgs("parseAuditTranscript");
  assert.equal(r.symbol, "parseAuditTranscript");
  assert.equal(r.file, undefined);
  assert.equal(r.framework, undefined);
  assert.equal(r.maxToolRounds, undefined);
  assert.equal(r.error, undefined);
});

test("rejects empty input with a precise message", () => {
  const r = parseTestGenArgs("");
  assert.match(r.error ?? "", /symbol name/);
});

test("rejects whitespace-only input", () => {
  const r = parseTestGenArgs("   ");
  assert.match(r.error ?? "", /symbol name/);
});

test("rejects more than one positional symbol", () => {
  const r = parseTestGenArgs("foo bar");
  assert.match(r.error ?? "", /exactly one symbol; got 2/);
});

test("--file=path is parsed and stripped from positionals", () => {
  const r = parseTestGenArgs("login --file=src/auth/login.ts");
  assert.equal(r.symbol, "login");
  assert.equal(r.file, "src/auth/login.ts");
});

test("--file path (space form) is parsed", () => {
  const r = parseTestGenArgs("--file src/utils.ts login");
  assert.equal(r.symbol, "login");
  assert.equal(r.file, "src/utils.ts");
});

test("--file without a value errors", () => {
  const r = parseTestGenArgs("login --file");
  assert.match(r.error ?? "", /--file expects a path/);
});

test("--framework=vitest accepted", () => {
  const r = parseTestGenArgs("login --framework=vitest");
  assert.equal(r.framework, "vitest");
});

test("--framework space form + case-insensitive", () => {
  const r = parseTestGenArgs("--framework JEST login");
  assert.equal(r.framework, "jest");
});

test("--framework rejects unknown values with explicit options", () => {
  const r = parseTestGenArgs("login --framework=mocha");
  assert.match(r.error ?? "", /vitest, jest, node, cargo, pytest, go/);
});

test("--max-rounds=N parses", () => {
  const r = parseTestGenArgs("login --max-rounds=120");
  assert.equal(r.maxToolRounds, 120);
});

test("--max-rounds rejects non-positive", () => {
  const r = parseTestGenArgs("login --max-rounds=0");
  assert.match(r.error ?? "", /positive integer/);
});

test("flags compose with each other", () => {
  const r = parseTestGenArgs(
    "login --file=src/auth.ts --framework=vitest --max-rounds=90",
  );
  assert.equal(r.symbol, "login");
  assert.equal(r.file, "src/auth.ts");
  assert.equal(r.framework, "vitest");
  assert.equal(r.maxToolRounds, 90);
});

test("rejects member access (Foo.bar)", () => {
  const r = parseTestGenArgs("Foo.bar");
  assert.match(r.error ?? "", /not a plain identifier/);
});

test("rejects file-prefixed forms (auth.ts:login)", () => {
  const r = parseTestGenArgs("auth.ts:login");
  assert.match(r.error ?? "", /not a plain identifier/);
});

test("accepts identifiers with $ and _ characters", () => {
  const r = parseTestGenArgs("_internal$Helper");
  assert.equal(r.symbol, "_internal$Helper");
  assert.equal(r.error, undefined);
});

// ---------------------------------------------------------------------------
// buildTestGenPrompt
// ---------------------------------------------------------------------------

test("buildTestGenPrompt frames an auto-detect run", () => {
  const out = buildTestGenPrompt({ symbol: "parseFooBar" });
  assert.match(out, /Generate tests for the symbol `parseFooBar`/);
  assert.match(out, /symbol: parseFooBar/);
  assert.match(out, /file: <auto-detect>/);
  assert.match(out, /framework: <auto-detect/);
  // Substrate-discipline language must reach the agent.
  assert.match(out, /ast_query op=resolve/);
  assert.match(out, /STOP and say so/);
  assert.match(out, /run_tests/);
});

test("buildTestGenPrompt threads file scope through", () => {
  const out = buildTestGenPrompt({
    symbol: "login",
    file: "src/auth/login.ts",
  });
  assert.match(out, /file: src\/auth\/login\.ts/);
  assert.doesNotMatch(out, /file: <auto-detect>/);
});

test("buildTestGenPrompt threads framework override through", () => {
  const out = buildTestGenPrompt({
    symbol: "login",
    framework: "vitest",
  });
  assert.match(out, /framework: vitest \(user override\)/);
});
