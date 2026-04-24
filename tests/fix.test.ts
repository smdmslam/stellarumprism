// Regression tests for the /fix slash command's argument parser + the
// finding-filter selector. Same Node v22 built-in test runner as the
// findings parser tests; no new dev-deps.

import test from "node:test";
import assert from "node:assert/strict";

import { parseFixArgs, filterFindings } from "../src/fix.ts";
import type { Finding } from "../src/findings.ts";

function fixture(): Finding[] {
  return [
    {
      id: "F1",
      severity: "error",
      file: "src/a.ts",
      line: 1,
      description: "stale import",
      suggested_fix: "remove it",
    },
    {
      id: "F2",
      severity: "warning",
      file: "src/b.ts",
      line: 2,
      description: "unused export",
      suggested_fix: "delete or use",
    },
    {
      id: "F3",
      severity: "info",
      file: "src/c.ts",
      line: 3,
      description: "todo comment",
      suggested_fix: "address or remove",
    },
  ];
}

// ---------------------------------------------------------------------------
// parseFixArgs
// ---------------------------------------------------------------------------

test("empty selector defaults to all", () => {
  const r = parseFixArgs("");
  assert.equal(r.selector.kind, "all");
  assert.equal(r.error, undefined);
});

test("'all' selector parses to all", () => {
  const r = parseFixArgs("all");
  assert.equal(r.selector.kind, "all");
});

test("single index", () => {
  const r = parseFixArgs("3");
  assert.deepEqual(r.selector, { kind: "indices", indices: [3] });
});

test("comma-separated indices", () => {
  const r = parseFixArgs("1,3,5");
  assert.deepEqual(r.selector, { kind: "indices", indices: [1, 3, 5] });
});

test("range expansion", () => {
  const r = parseFixArgs("2-4");
  assert.deepEqual(r.selector, { kind: "indices", indices: [2, 3, 4] });
});

test("mixed indices and ranges", () => {
  const r = parseFixArgs("1,3-5,8");
  assert.deepEqual(r.selector, {
    kind: "indices",
    indices: [1, 3, 4, 5, 8],
  });
});

test("id list", () => {
  const r = parseFixArgs("#F2,#F4");
  assert.deepEqual(r.selector, { kind: "ids", ids: ["F2", "F4"] });
});

test("rejects mixed ids and indices", () => {
  const r = parseFixArgs("1,#F2");
  assert.match(r.error ?? "", /mixed id and index/);
});

test("rejects bad range (descending)", () => {
  const r = parseFixArgs("5-2");
  assert.match(r.error ?? "", /bad range/);
});

test("rejects garbage selector token", () => {
  const r = parseFixArgs("foo");
  assert.match(r.error ?? "", /unrecognized selector token/);
});

test("--max-rounds=N flag is parsed and stripped from selector", () => {
  const r = parseFixArgs("1,3 --max-rounds=80");
  assert.deepEqual(r.selector, { kind: "indices", indices: [1, 3] });
  assert.equal(r.maxToolRounds, 80);
});

test("--max-rounds N (space form)", () => {
  const r = parseFixArgs("--max-rounds 50 all");
  assert.equal(r.selector.kind, "all");
  assert.equal(r.maxToolRounds, 50);
});

test("--max-rounds rejects non-positive", () => {
  const r = parseFixArgs("1 --max-rounds=0");
  assert.match(r.error ?? "", /positive integer/);
});

test("--report=path is parsed and stripped", () => {
  const r = parseFixArgs(
    "all --report=.prism/second-pass/audit-2026-04-24T12-00-00.json",
  );
  assert.equal(r.selector.kind, "all");
  assert.equal(
    r.reportPath,
    ".prism/second-pass/audit-2026-04-24T12-00-00.json",
  );
});

test("--report missing value errors", () => {
  const r = parseFixArgs("all --report");
  assert.match(r.error ?? "", /--report expects a path/);
});

// ---------------------------------------------------------------------------
// filterFindings
// ---------------------------------------------------------------------------

test("filter all returns every finding", () => {
  const r = filterFindings(fixture(), { kind: "all" });
  assert.equal(r.findings.length, 3);
});

test("filter by indices preserves order", () => {
  const r = filterFindings(fixture(), { kind: "indices", indices: [3, 1] });
  assert.deepEqual(
    r.findings.map((f) => f.id),
    ["F3", "F1"],
  );
});

test("filter dedupes repeated indices", () => {
  const r = filterFindings(fixture(), {
    kind: "indices",
    indices: [1, 1, 2],
  });
  assert.deepEqual(
    r.findings.map((f) => f.id),
    ["F1", "F2"],
  );
});

test("filter rejects out-of-range indices with helpful message", () => {
  const r = filterFindings(fixture(), {
    kind: "indices",
    indices: [1, 9],
  });
  assert.equal(r.findings.length, 0);
  assert.match(r.error ?? "", /no findings at index 9/);
  assert.match(r.error ?? "", /report has 3 findings/);
});

test("filter by ids", () => {
  const r = filterFindings(fixture(), { kind: "ids", ids: ["F2", "F3"] });
  assert.deepEqual(
    r.findings.map((f) => f.id),
    ["F2", "F3"],
  );
});

test("filter by ids surfaces missing ids", () => {
  const r = filterFindings(fixture(), {
    kind: "ids",
    ids: ["F2", "F99"],
  });
  assert.equal(r.findings.length, 0);
  assert.match(r.error ?? "", /no findings with id #F99/);
});

test("filter all on empty list returns empty without error", () => {
  const r = filterFindings([], { kind: "all" });
  assert.equal(r.findings.length, 0);
  assert.equal(r.error, undefined);
});
