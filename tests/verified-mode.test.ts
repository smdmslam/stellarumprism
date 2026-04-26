import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyVerifiedProtocol,
  detectVerifiedTrigger,
} from "../src/verified-mode.ts";

// ---------------------------------------------------------------------------
// Trigger detection — fires on inspectable questions
// ---------------------------------------------------------------------------

test("count: fires on 'how many'", () => {
  const t = detectVerifiedTrigger("how many tests are there?");
  assert.equal(t?.kind, "count");
});

test("count: fires on 'total of'", () => {
  const t = detectVerifiedTrigger("what's the total of test prompts in the file?");
  assert.equal(t?.kind, "count");
});

test("count: fires on 'number of'", () => {
  const t = detectVerifiedTrigger("Number of slash commands available?");
  assert.equal(t?.kind, "count");
});

test("count: wins over enumerate when both could match", () => {
  // The COUNT_REGEX is checked before ENUM_REGEX so an "how many tests"
  // prompt routes to count (with its strict arithmetic addendum).
  const t = detectVerifiedTrigger("how many tests do we have?");
  assert.equal(t?.kind, "count");
});

test("enumerate: fires on 'list all'", () => {
  const t = detectVerifiedTrigger("list all the audit modes");
  assert.equal(t?.kind, "enumerate");
});

test("enumerate: fires on 'which files'", () => {
  const t = detectVerifiedTrigger("which files were touched in the last commit?");
  assert.equal(t?.kind, "enumerate");
});

test("enumerate: fires on 'show me the'", () => {
  const t = detectVerifiedTrigger("show me the slash commands");
  assert.equal(t?.kind, "enumerate");
});

test("repo-fact: fires on 'where is'", () => {
  const t = detectVerifiedTrigger("where is the agent.rs file?");
  assert.equal(t?.kind, "repo-fact");
});

test("repo-fact: fires on 'did we'", () => {
  const t = detectVerifiedTrigger("did we ever add a /diff command?");
  assert.equal(t?.kind, "repo-fact");
});

test("repo-fact: fires on 'what changed'", () => {
  const t = detectVerifiedTrigger("what changed since yesterday?");
  assert.equal(t?.kind, "repo-fact");
});

// ---------------------------------------------------------------------------
// Trigger detection — does NOT fire on opinion / vague prompts
// ---------------------------------------------------------------------------

test("opinion: does not fire on 'any thoughts'", () => {
  const t = detectVerifiedTrigger("any thoughts on the architecture?");
  assert.equal(t, null);
});

test("opinion: does not fire on 'what would you call this'", () => {
  const t = detectVerifiedTrigger("what would you call this feature?");
  assert.equal(t, null);
});

test("vague: does not fire on bare verbs", () => {
  const t = detectVerifiedTrigger("can you help me think about this?");
  assert.equal(t, null);
});

test("instruction: does not fire on commit-style prompts", () => {
  // git instructions are imperative actions, not factual questions \u2014
  // they get their own routing (router.ts GIT_SIGNALS) and shouldn't
  // be wrapped with the count/enumerate scaffold.
  const t = detectVerifiedTrigger("commit and push");
  assert.equal(t, null);
});

// ---------------------------------------------------------------------------
// Protocol application
// ---------------------------------------------------------------------------

test("applyVerifiedProtocol: preserves the original user question", () => {
  const original = "how many tests do we have?";
  const trigger = detectVerifiedTrigger(original)!;
  const wrapped = applyVerifiedProtocol(original, trigger);
  assert.ok(
    wrapped.endsWith("User question:\n" + original),
    "wrapped prompt should end with 'User question:\\n<original>'",
  );
});

test("applyVerifiedProtocol: includes the protocol preamble", () => {
  const trigger = detectVerifiedTrigger("how many tests?")!;
  const wrapped = applyVerifiedProtocol("how many tests?", trigger);
  assert.ok(wrapped.includes("[Grounded-Chat protocol active]"));
  assert.ok(wrapped.includes("EVIDENCE LABELS"));
  assert.ok(wrapped.includes("NO RECONCILIATION-BY-ARITHMETIC"));
});

test("applyVerifiedProtocol: count addendum requires breakdown to sum", () => {
  const trigger = detectVerifiedTrigger("how many tests?")!;
  const wrapped = applyVerifiedProtocol("how many tests?", trigger);
  assert.ok(wrapped.includes("This is a COUNT question"));
  assert.ok(wrapped.includes("breakdown sums to the total"));
});

test("applyVerifiedProtocol: enumerate addendum requires per-item paths", () => {
  const trigger = detectVerifiedTrigger("list all tests")!;
  const wrapped = applyVerifiedProtocol("list all tests", trigger);
  assert.ok(wrapped.includes("This is an ENUMERATION question"));
  assert.ok(wrapped.includes("path or identifier for each item"));
});

test("applyVerifiedProtocol: repo-fact addendum requires a tool call", () => {
  const trigger = detectVerifiedTrigger("where is agent.rs?")!;
  const wrapped = applyVerifiedProtocol("where is agent.rs?", trigger);
  assert.ok(wrapped.includes("This is a REPO-FACT question"));
  assert.ok(wrapped.includes("run a tool to fetch the answer"));
});
