// Regression tests for the file-tree pure logic (IDE-shape phase 1).
// Same Node v22 built-in test runner as the rest of the suite.

import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyTreeState,
  flattenVisibleRows,
  formatBytes,
  moveSelection,
  setChildren,
  setError,
  setLoading,
  setRoot,
  setSelected,
  toggleExpanded,
  type RawTreeEntry,
  type RawTreeListing,
} from "../src/file-tree.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function entry(name: string, kind: RawTreeEntry["kind"], path?: string): RawTreeEntry {
  return {
    name,
    path: path ?? `/r/${name}`,
    kind,
    has_children: kind === "dir",
  };
}

function rootListing(...es: RawTreeEntry[]): RawTreeListing {
  return { dir: "/r", entries: es, truncated: false, is_root: true };
}

// ---------------------------------------------------------------------------
// flattenVisibleRows
// ---------------------------------------------------------------------------

test("empty state flattens to no rows", () => {
  const s = emptyTreeState();
  assert.deepEqual(flattenVisibleRows(s), []);
});

test("root listing flattens to top-level rows in backend order", () => {
  let s = emptyTreeState();
  s = setRoot(
    s,
    rootListing(
      entry("docs", "dir"),
      entry("src", "dir"),
      entry("a.txt", "file"),
    ),
  );
  const rows = flattenVisibleRows(s);
  assert.deepEqual(
    rows.map((r) => [r.entry.name, r.depth, r.expanded]),
    [
      ["docs", 0, false],
      ["src", 0, false],
      ["a.txt", 0, false],
    ],
  );
});

test("expanded dir surfaces its loaded children at depth+1", () => {
  let s = emptyTreeState();
  s = setRoot(s, rootListing(entry("src", "dir", "/r/src")));
  let { state } = toggleExpanded(s, "/r/src", true);
  state = setChildren(state, "/r/src", {
    dir: "/r/src",
    is_root: false,
    truncated: false,
    entries: [
      entry("lib.rs", "file", "/r/src/lib.rs"),
      entry("util", "dir", "/r/src/util"),
    ],
  });
  const rows = flattenVisibleRows(state);
  assert.deepEqual(
    rows.map((r) => [r.entry.name, r.depth, r.expanded]),
    [
      ["src", 0, true],
      ["lib.rs", 1, false],
      ["util", 1, false],
    ],
  );
});

test("expanded-but-not-loaded dir contributes only its own row (UI shows spinner)", () => {
  let s = emptyTreeState();
  s = setRoot(s, rootListing(entry("src", "dir", "/r/src")));
  const { state } = toggleExpanded(s, "/r/src", true);
  // No setChildren call yet; loadState should still be idle and the
  // tree should not surface any synthetic rows.
  const rows = flattenVisibleRows(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entry.name, "src");
  assert.equal(rows[0].expanded, true);
});

// ---------------------------------------------------------------------------
// toggleExpanded
// ---------------------------------------------------------------------------

test("toggleExpanded on a file is a no-op", () => {
  const s = emptyTreeState();
  const r = toggleExpanded(s, "/r/a.txt", false);
  assert.equal(r.state, s, "state must be returned unchanged");
  assert.equal(r.needsLoad, false);
});

test("toggleExpanded on an unloaded dir signals needsLoad=true", () => {
  let s = emptyTreeState();
  s = setRoot(s, rootListing(entry("src", "dir", "/r/src")));
  const r = toggleExpanded(s, "/r/src", true);
  assert.ok(r.state.expanded.has("/r/src"));
  assert.equal(r.needsLoad, true);
});

test("toggleExpanded on a loaded dir does NOT request a re-load", () => {
  let s = emptyTreeState();
  s = setRoot(s, rootListing(entry("src", "dir", "/r/src")));
  s = toggleExpanded(s, "/r/src", true).state;
  s = setChildren(s, "/r/src", {
    dir: "/r/src",
    is_root: false,
    truncated: false,
    entries: [],
  });
  // Collapse \u2026
  s = toggleExpanded(s, "/r/src", true).state;
  // \u2026 then re-expand. We already have the listing cached, so no reload.
  const r = toggleExpanded(s, "/r/src", true);
  assert.equal(r.needsLoad, false);
  assert.ok(r.state.expanded.has("/r/src"));
});

// ---------------------------------------------------------------------------
// load-state transitions
// ---------------------------------------------------------------------------

test("setLoading then setChildren ends in 'loaded' state", () => {
  let s = emptyTreeState();
  s = setRoot(s, rootListing(entry("src", "dir", "/r/src")));
  s = setLoading(s, "/r/src");
  assert.deepEqual(s.loadStateByPath.get("/r/src"), { kind: "loading" });
  s = setChildren(s, "/r/src", {
    dir: "/r/src",
    is_root: false,
    truncated: false,
    entries: [entry("lib.rs", "file", "/r/src/lib.rs")],
  });
  assert.deepEqual(s.loadStateByPath.get("/r/src"), { kind: "loaded" });
});

test("setError surfaces the message on the matching row", () => {
  let s = emptyTreeState();
  s = setRoot(s, rootListing(entry("src", "dir", "/r/src")));
  s = toggleExpanded(s, "/r/src", true).state;
  s = setError(s, "/r/src", "permission denied");
  const rows = flattenVisibleRows(s);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].loadState, {
    kind: "error",
    message: "permission denied",
  });
});

// ---------------------------------------------------------------------------
// keyboard nav
// ---------------------------------------------------------------------------

test("moveSelection from no-selection lands on first row when delta>0", () => {
  let s = emptyTreeState();
  s = setRoot(
    s,
    rootListing(
      entry("a", "file", "/r/a"),
      entry("b", "file", "/r/b"),
      entry("c", "file", "/r/c"),
    ),
  );
  const rows = flattenVisibleRows(s);
  const next = moveSelection(s, rows, 1);
  assert.equal(next, "/r/a");
});

test("moveSelection from no-selection lands on last row when delta<0", () => {
  let s = emptyTreeState();
  s = setRoot(
    s,
    rootListing(
      entry("a", "file", "/r/a"),
      entry("b", "file", "/r/b"),
      entry("c", "file", "/r/c"),
    ),
  );
  const rows = flattenVisibleRows(s);
  const next = moveSelection(s, rows, -1);
  assert.equal(next, "/r/c");
});

test("moveSelection clamps at the top and bottom of the list", () => {
  let s = emptyTreeState();
  s = setRoot(
    s,
    rootListing(
      entry("a", "file", "/r/a"),
      entry("b", "file", "/r/b"),
      entry("c", "file", "/r/c"),
    ),
  );
  s = setSelected(s, "/r/a");
  let rows = flattenVisibleRows(s);
  // Up from the top stays at the top.
  assert.equal(moveSelection(s, rows, -1), "/r/a");
  // Down by 1 lands on b.
  assert.equal(moveSelection(s, rows, 1), "/r/b");
  s = setSelected(s, "/r/c");
  rows = flattenVisibleRows(s);
  // Down from the bottom stays at the bottom.
  assert.equal(moveSelection(s, rows, 1), "/r/c");
});

test("moveSelection returns null when there are no visible rows", () => {
  const s = emptyTreeState();
  const rows = flattenVisibleRows(s);
  assert.equal(moveSelection(s, rows, 1), null);
});

// ---------------------------------------------------------------------------
// setRoot semantics
// ---------------------------------------------------------------------------

test("setRoot resets cached children and load states (cwd switch is a fresh tree)", () => {
  let s = emptyTreeState();
  s = setRoot(s, rootListing(entry("src", "dir", "/r/src")));
  s = toggleExpanded(s, "/r/src", true).state;
  s = setChildren(s, "/r/src", {
    dir: "/r/src",
    is_root: false,
    truncated: false,
    entries: [entry("lib.rs", "file", "/r/src/lib.rs")],
  });
  // Now switch cwd; the on-disk shape might be different.
  s = setRoot(
    s,
    { dir: "/other", is_root: true, truncated: false, entries: [] },
  );
  assert.equal(s.childrenByPath.size, 0);
  assert.equal(s.loadStateByPath.size, 0);
  // Expanded set is preserved so the UI can choose to re-expand
  // matching paths after a refresh; the test just sanity-checks the
  // contract.
  assert.ok(s.expanded.has("/r/src"));
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

test("formatBytes scales bytes \u2192 KB \u2192 MB and tolerates null/undefined", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes(undefined), "");
});
