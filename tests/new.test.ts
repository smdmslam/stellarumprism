// Regression tests for the /new (scaffold) slash command's argument
// parser and prompt framing. Same Node v22 built-in test runner as
// the rest of the suite; no new dev-deps.

import test from "node:test";
import assert from "node:assert/strict";

import { buildNewPrompt, parseNewArgs } from "../src/new.ts";

// ---------------------------------------------------------------------------
// parseNewArgs
// ---------------------------------------------------------------------------

test("parses a single positional project name with no description", () => {
  const r = parseNewArgs("todo-app");
  assert.equal(r.projectName, "todo-app");
  assert.equal(r.description, "");
  assert.equal(r.into, undefined);
  assert.equal(r.maxToolRounds, undefined);
  assert.equal(r.error, undefined);
});

test("rejects empty input with a precise message that disambiguates from chat-clear", () => {
  const r = parseNewArgs("");
  assert.match(r.error ?? "", /project name/);
  // The user might have expected /new to clear chat. Make sure the
  // error explicitly tells them where to look.
  assert.match(r.error ?? "", /clears the conversation history/);
});

test("rejects whitespace-only input", () => {
  const r = parseNewArgs("   ");
  assert.match(r.error ?? "", /project name/);
});

test("multi-word stack description is joined back together preserving order", () => {
  const r = parseNewArgs("todo-app vite + react + typescript");
  assert.equal(r.projectName, "todo-app");
  assert.equal(r.description, "vite + react + typescript");
});

test("project name with description containing flags-like punctuation survives", () => {
  const r = parseNewArgs(
    "api express+ts api with prisma+postgres",
  );
  assert.equal(r.projectName, "api");
  assert.equal(r.description, "express+ts api with prisma+postgres");
});

test("--into=path is parsed and stripped from positionals", () => {
  const r = parseNewArgs("web --into=apps/web vite + react");
  assert.equal(r.projectName, "web");
  assert.equal(r.into, "apps/web");
  assert.equal(r.description, "vite + react");
});

test("--into space form is parsed", () => {
  const r = parseNewArgs("web --into apps/web vite");
  assert.equal(r.projectName, "web");
  assert.equal(r.into, "apps/web");
  assert.equal(r.description, "vite");
});

test("--into without a value errors", () => {
  const r = parseNewArgs("web --into");
  assert.match(r.error ?? "", /--into expects a directory path/);
});

test("--into=. (scaffold into cwd) is preserved verbatim", () => {
  // The agent's prompt enforces 'target directory must be empty';
  // the parser stays neutral and just preserves the value.
  const r = parseNewArgs("inplace --into=.");
  assert.equal(r.into, ".");
});

test("--max-rounds=N parses", () => {
  const r = parseNewArgs("todo-app --max-rounds=150 vite + react");
  assert.equal(r.maxToolRounds, 150);
});

test("--max-rounds rejects non-positive", () => {
  const r = parseNewArgs("todo-app --max-rounds=0");
  assert.match(r.error ?? "", /positive integer/);
});

test("--max-rounds rejects non-numeric", () => {
  const r = parseNewArgs("todo-app --max-rounds=lots");
  assert.match(r.error ?? "", /positive integer/);
});

test("flags compose in any order with each other", () => {
  const r = parseNewArgs(
    "api --into=services/api express + typescript --max-rounds=120",
  );
  assert.equal(r.projectName, "api");
  assert.equal(r.into, "services/api");
  assert.equal(r.description, "express + typescript");
  assert.equal(r.maxToolRounds, 120);
});

test("rejects path-prefixed project names (use --into instead)", () => {
  const r = parseNewArgs("apps/web vite");
  assert.match(r.error ?? "", /not a filesystem-safe slug/);
  // The error should hint at the right knob.
  assert.match(r.error ?? "", /--into/);
});

test("rejects shell-unsafe project names (spaces, leading dot, etc.)", () => {
  const cases = [".hidden", "-leading-dash", "trailing-dash-"];
  for (const name of cases) {
    const r = parseNewArgs(name);
    assert.match(
      r.error ?? "",
      /not a filesystem-safe slug/,
      `expected rejection for ${JSON.stringify(name)}`,
    );
  }
});

test("accepts dot-versioned project names", () => {
  const r = parseNewArgs("foo.v2 vite + react");
  assert.equal(r.projectName, "foo.v2");
  assert.equal(r.error, undefined);
});

test("accepts underscore + digit names", () => {
  const r = parseNewArgs("_my_app42 vite");
  assert.equal(r.projectName, "_my_app42");
  assert.equal(r.error, undefined);
});

// ---------------------------------------------------------------------------
// buildNewPrompt
// ---------------------------------------------------------------------------

test("buildNewPrompt frames a stack-described run", () => {
  const out = buildNewPrompt({
    projectName: "todo-app",
    description: "vite + react + typescript",
  });
  assert.match(out, /Scaffold a new project/);
  assert.match(out, /project_name: todo-app/);
  // Default target is `<projectName>/` when --into is unset.
  assert.match(out, /target_directory: todo-app\//);
  assert.match(out, /stack_description: vite \+ react \+ typescript/);
  // Substrate-discipline language must reach the agent.
  assert.match(out, /VERIFYING the target directory is empty/);
  assert.match(out, /SCAFFOLD REPORT/);
});

test("buildNewPrompt threads --into through as target_directory", () => {
  const out = buildNewPrompt({
    projectName: "web",
    description: "vite",
    into: "apps/web",
  });
  assert.match(out, /target_directory: apps\/web/);
  assert.doesNotMatch(out, /target_directory: web\//);
});

test("buildNewPrompt handles missing description by inviting ask-by-acting", () => {
  const out = buildNewPrompt({
    projectName: "thing",
    description: "",
  });
  assert.match(out, /none provided/);
  assert.match(out, /pick simplest sensible default/);
});

test("buildNewPrompt's empty-target guardrail is the first instruction after framing", () => {
  // The empty-target check is the most important precondition; it
  // must appear in the user-message framing too, not just the system
  // prompt, so a model that only re-reads the user turn still sees it.
  const out = buildNewPrompt({
    projectName: "x",
    description: "vite",
  });
  const verifyIdx = out.indexOf("VERIFYING the target directory is empty");
  assert.ok(verifyIdx >= 0, "empty-target check must appear in user prompt");
});
