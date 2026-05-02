import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildVerifiedSystemPrefix,
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

test("inventory: fires on 'what can X do'", () => {
  const t = detectVerifiedTrigger("what can Prism do?");
  assert.equal(t?.kind, "inventory");
});

test("inventory: fires on 'list features of X'", () => {
  const t = detectVerifiedTrigger("list features of this app");
  assert.equal(t?.kind, "inventory");
});

test("inventory: fires on 'how does X work'", () => {
  const t = detectVerifiedTrigger("how does the recipe runner work?");
  assert.equal(t?.kind, "inventory");
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
// System-prefix builder
//
// The protocol is now injected as a per-turn system prefix on the wire,
// NOT prepended to the user message. These tests pin the new shape:
//   - the prefix carries the protocol preamble + the kind addendum
//   - the prefix DOES NOT contain the user's prompt (the prompt is sent
//     as a separate user message and the prefix must stay generic so
//     it doesn't contaminate stored history if a future caller did mix
//     them by accident).
// ---------------------------------------------------------------------------

test("buildVerifiedSystemPrefix: does NOT embed the user prompt", () => {
  // Belt-and-suspenders against a future regression that re-introduces
  // prompt embedding (which is what caused the history-bloat / silent
  // empty-response bug we're fixing). The prefix must stay generic so
  // it can be reused across calls without smuggling user content in.
  const original = "how many tests do we have?";
  const trigger = detectVerifiedTrigger(original)!;
  const prefix = buildVerifiedSystemPrefix(trigger);
  assert.ok(
    !prefix.includes(original),
    "system prefix must not contain the user's prompt verbatim",
  );
  assert.ok(
    !prefix.includes("User question:"),
    "system prefix must not carry a 'User question:' header (that was the wrapper era)",
  );
});

test("buildVerifiedSystemPrefix: includes the protocol preamble", () => {
  const trigger = detectVerifiedTrigger("how many tests?")!;
  const prefix = buildVerifiedSystemPrefix(trigger);
  assert.ok(prefix.includes("[Grounded-Chat protocol active]"));
  assert.ok(prefix.includes("EVIDENCE LABELS"));
  assert.ok(prefix.includes("NO RECONCILIATION-BY-ARITHMETIC"));
});

test("buildVerifiedSystemPrefix: count addendum requires breakdown to sum", () => {
  const trigger = detectVerifiedTrigger("how many tests?")!;
  const prefix = buildVerifiedSystemPrefix(trigger);
  assert.ok(prefix.includes("This is a COUNT question"));
  assert.ok(prefix.includes("breakdown sums to the total"));
});

test("buildVerifiedSystemPrefix: enumerate addendum requires per-item paths", () => {
  const trigger = detectVerifiedTrigger("list all tests")!;
  const prefix = buildVerifiedSystemPrefix(trigger);
  assert.ok(prefix.includes("This is an ENUMERATION question"));
  assert.ok(prefix.includes("path or identifier for each item"));
});

test("buildVerifiedSystemPrefix: repo-fact addendum requires a tool call", () => {
  const trigger = detectVerifiedTrigger("where is agent.rs?")!;
  const prefix = buildVerifiedSystemPrefix(trigger);
  assert.ok(prefix.includes("This is a REPO-FACT question"));
  assert.ok(prefix.includes("run a tool to fetch the answer"));
});

test("buildVerifiedSystemPrefix: inventory addendum requires capability evidence", () => {
  const trigger = detectVerifiedTrigger("what can Prism do?")!;
  const prefix = buildVerifiedSystemPrefix(trigger);
  assert.ok(prefix.includes("This is an INVENTORY / CAPABILITY-SUMMARY question"));
  assert.ok(prefix.includes("cite the file path or symbol that proves it exists"));
});
