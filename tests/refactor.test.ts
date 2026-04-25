// Regression tests for the /refactor slash command's argument parser
// and prompt framing. Same Node v22 built-in test runner as the rest of
// the suite; no new dev-deps.

import test from "node:test";
import assert from "node:assert/strict";

import { buildRefactorPrompt, parseRefactorArgs } from "../src/refactor.ts";

// ---------------------------------------------------------------------------
// parseRefactorArgs
// ---------------------------------------------------------------------------

test("parses two positional identifiers", () => {
  const r = parseRefactorArgs("oldName newName");
  assert.equal(r.oldName, "oldName");
  assert.equal(r.newName, "newName");
  assert.equal(r.scope, undefined);
  assert.equal(r.maxToolRounds, undefined);
  assert.equal(r.error, undefined);
});

test("rejects empty input with a precise message", () => {
  const r = parseRefactorArgs("");
  assert.match(r.error ?? "", /two identifiers/);
});

test("rejects whitespace-only input", () => {
  const r = parseRefactorArgs("   ");
  assert.match(r.error ?? "", /two identifiers/);
});

test("rejects when only one positional is given", () => {
  const r = parseRefactorArgs("loneName");
  assert.match(r.error ?? "", /old name and a new name/);
});

test("rejects when more than two positionals are given", () => {
  const r = parseRefactorArgs("a b c");
  assert.match(r.error ?? "", /exactly two identifiers; got 3/);
});

test("--scope=path is parsed and stripped from positional args", () => {
  const r = parseRefactorArgs("Foo Bar --scope=src/auth.ts");
  assert.equal(r.oldName, "Foo");
  assert.equal(r.newName, "Bar");
  assert.equal(r.scope, "src/auth.ts");
});

test("--scope path (space form) is parsed and stripped", () => {
  const r = parseRefactorArgs("--scope src/pages Foo Bar");
  assert.equal(r.oldName, "Foo");
  assert.equal(r.newName, "Bar");
  assert.equal(r.scope, "src/pages");
});

test("--scope without a value errors", () => {
  const r = parseRefactorArgs("Foo Bar --scope");
  assert.match(r.error ?? "", /--scope expects a path/);
});

test("--max-rounds=N is parsed and stripped", () => {
  const r = parseRefactorArgs("Foo Bar --max-rounds=120");
  assert.equal(r.maxToolRounds, 120);
});

test("--max-rounds N (space form) is parsed", () => {
  const r = parseRefactorArgs("--max-rounds 90 Foo Bar");
  assert.equal(r.maxToolRounds, 90);
});

test("--max-rounds rejects non-positive values", () => {
  const r = parseRefactorArgs("Foo Bar --max-rounds=0");
  assert.match(r.error ?? "", /positive integer/);
});

test("--scope and --max-rounds compose with positionals", () => {
  const r = parseRefactorArgs(
    "Foo Bar --scope=src/auth.ts --max-rounds=90",
  );
  assert.equal(r.oldName, "Foo");
  assert.equal(r.newName, "Bar");
  assert.equal(r.scope, "src/auth.ts");
  assert.equal(r.maxToolRounds, 90);
});

test("rejects member access (Foo.bar) as oldName", () => {
  const r = parseRefactorArgs("Foo.bar Bar");
  assert.match(r.error ?? "", /not a plain identifier/);
});

test("rejects CSS-like selectors as newName", () => {
  const r = parseRefactorArgs("oldName .btn-primary");
  assert.match(r.error ?? "", /not a plain identifier/);
});

test("rejects identifiers starting with digits", () => {
  const r = parseRefactorArgs("2Foo Bar");
  assert.match(r.error ?? "", /not a plain identifier/);
});

test("accepts identifiers with $ and _ characters", () => {
  const r = parseRefactorArgs("_oldName $NewName");
  assert.equal(r.oldName, "_oldName");
  assert.equal(r.newName, "$NewName");
  assert.equal(r.error, undefined);
});

test("rejects when oldName === newName", () => {
  const r = parseRefactorArgs("Same Same");
  assert.match(r.error ?? "", /identical/);
});

// ---------------------------------------------------------------------------
// buildRefactorPrompt
// ---------------------------------------------------------------------------

test("buildRefactorPrompt frames a project-wide rename", () => {
  const out = buildRefactorPrompt({
    oldName: "fooBar",
    newName: "fooBaz",
  });
  assert.match(out, /Rename the identifier `fooBar` to `fooBaz`/);
  assert.match(out, /old_name: fooBar/);
  assert.match(out, /new_name: fooBaz/);
  assert.match(out, /scope: <project-wide>/);
  // Same-symbol gating language must reach the agent so it doesn't
  // rename shadowed locals or unrelated symbols.
  assert.match(out, /SAME declaration/);
  assert.match(out, /LEFT ALONE/);
  // Must instruct the substrate flow.
  assert.match(out, /ast_query op=resolve/);
});

test("buildRefactorPrompt frames a scoped rename", () => {
  const out = buildRefactorPrompt({
    oldName: "fooBar",
    newName: "fooBaz",
    scope: "src/auth",
  });
  assert.match(out, /scope: src\/auth/);
  assert.match(out, /Limit the rename to the scope above/);
  assert.doesNotMatch(out, /<project-wide>/);
});
