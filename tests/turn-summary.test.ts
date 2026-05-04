import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanToolSummary,
  extractWritePath,
  formatElapsed,
  formatFilesModifiedFooter,
  formatTurnFooter,
  WRITE_TOOL_NAMES,
  calculateWriteStats,
} from "../src/turn-summary.ts";

// ---------------------------------------------------------------------------
// extractWritePath
// ---------------------------------------------------------------------------

test("extractWritePath: pulls path from valid write_file args", () => {
  const p = extractWritePath('{"path":"src/foo.ts","content":"x"}');
  assert.equal(p, "src/foo.ts");
});

test("extractWritePath: pulls path from edit_file args", () => {
  const p = extractWritePath(
    '{"path":"README.md","old_string":"foo","new_string":"bar"}',
  );
  assert.equal(p, "README.md");
});

test("extractWritePath: returns null on missing path", () => {
  assert.equal(extractWritePath('{"content":"x"}'), null);
});

test("extractWritePath: returns null on malformed JSON", () => {
  // Tolerant of garbage so a malformed args blob doesn't crash the
  // footer rendering; the call just doesn't get tracked.
  assert.equal(extractWritePath("{not json"), null);
});

test("extractWritePath: returns null on empty path string", () => {
  assert.equal(extractWritePath('{"path":""}'), null);
});

test("extractWritePath: returns null when path is not a string", () => {
  assert.equal(extractWritePath('{"path":123}'), null);
});

test("WRITE_TOOL_NAMES: covers the two known write tools", () => {
  assert.equal(WRITE_TOOL_NAMES.has("write_file"), true);
  assert.equal(WRITE_TOOL_NAMES.has("edit_file"), true);
  assert.equal(WRITE_TOOL_NAMES.has("read_file"), false);
  assert.equal(WRITE_TOOL_NAMES.has("run_shell"), false);
});

// ---------------------------------------------------------------------------
// cleanToolSummary
// ---------------------------------------------------------------------------

// cleanToolSummary now returns a structured `CleanSummary { verb, pill?,
// full }` so the renderer can style the verb (bright) and the pill
// (dim) independently. Tests assert against the structured shape
// directly \u2014 the `full` field is the convenience
// `${verb} ${pill}` string the v1 contract returned.

test("cleanToolSummary: strips path from read_file summary", () => {
  const out = cleanToolSummary(
    "read_file",
    "read /Users/x/proj/src/foo.ts (1.2 KB)",
  );
  assert.equal(out.verb, "read");
  assert.equal(out.pill, "1.2 KB");
  assert.equal(out.full, "read 1.2 KB");
});

test("cleanToolSummary: strips path from write_file (created)", () => {
  const out = cleanToolSummary("write_file", "created /path/to/new.md (820 B)");
  assert.equal(out.verb, "created");
  assert.equal(out.pill, "820 B");
  assert.equal(out.full, "created 820 B");
});

test("cleanToolSummary: strips path from edit_file (replacements)", () => {
  const out = cleanToolSummary(
    "edit_file",
    "edited /path/file.ts (3 replacements)",
  );
  assert.equal(out.verb, "edited");
  assert.equal(out.pill, "3 replacements");
  assert.equal(out.full, "edited 3 replacements");
});

test("cleanToolSummary: strips path from list_directory", () => {
  const out = cleanToolSummary("list_directory", "listed /repo/src (14 entries)");
  assert.equal(out.verb, "listed");
  assert.equal(out.pill, "14 entries");
  assert.equal(out.full, "listed 14 entries");
});

test("cleanToolSummary: passes through non-path tools verbatim", () => {
  // grep, http_fetch, run_shell, etc. don't carry a duplicated path
  // and we must not chop their summaries. For non-path tools `verb`
  // is empty (no parsing happened); `full` is the original summary.
  const grep = cleanToolSummary("grep", "matched 12 lines in 3 files");
  assert.equal(grep.verb, "");
  assert.equal(grep.pill, undefined);
  assert.equal(grep.full, "matched 12 lines in 3 files");

  const fetch = cleanToolSummary(
    "http_fetch",
    "http_fetch GET http://localhost:3000/api/health \u2192 200 OK (123 ms)",
  );
  assert.equal(
    fetch.full,
    "http_fetch GET http://localhost:3000/api/health \u2192 200 OK (123 ms)",
  );
});

test("cleanToolSummary: passes through unparseable summary unchanged", () => {
  // Defensive: if a path-tool's summary doesn't match the
  // 'verb path (info)' shape (e.g. an error message), the helper
  // returns the original summary on `full` with no verb/pill so the
  // renderer can fall back to its plain-text path.
  const out = cleanToolSummary("read_file", "error: cannot read file");
  assert.equal(out.verb, "");
  assert.equal(out.pill, undefined);
  assert.equal(out.full, "error: cannot read file");
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

test("formatElapsed: sub-second turns get '<1s'", () => {
  assert.equal(formatElapsed(0), "<1s");
  assert.equal(formatElapsed(123), "<1s");
  assert.equal(formatElapsed(999), "<1s");
});

test("formatElapsed: seconds carry one decimal", () => {
  assert.equal(formatElapsed(4_200), "4.2s");
  assert.equal(formatElapsed(38_700), "38.7s");
});

test("formatElapsed: minutes show whole seconds", () => {
  assert.equal(formatElapsed(60_000), "1m00s");
  assert.equal(formatElapsed(132_000), "2m12s");
});

test("formatElapsed: hours show two-digit minutes", () => {
  assert.equal(formatElapsed(3_780_000), "1h03m");
  assert.equal(formatElapsed(7_260_000), "2h01m");
});

test("formatElapsed: defends against bogus input", () => {
  // NaN, negative, or Infinity could land here from a clock skew or
  // a buggy timer; we just emit a safe fallback rather than throwing.
  assert.equal(formatElapsed(NaN), "0s");
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(Infinity), "0s");
});

// ---------------------------------------------------------------------------
// formatTurnFooter
// ---------------------------------------------------------------------------

test("formatTurnFooter: includes elapsed + tool count + model", () => {
  const s = formatTurnFooter({
    elapsedMs: 4_200,
    toolCount: 3,
    model: "qwen3-next-80b",
  });
  assert.equal(s, "[done in 4.2s \u00b7 3 tools \u00b7 qwen3-next-80b]");
});

test("formatTurnFooter: omits tool count on chat-only turns", () => {
  // No tools = chat-only response. Showing '0 tools' would be noise;
  // we drop the segment instead.
  const s = formatTurnFooter({
    elapsedMs: 1_400,
    toolCount: 0,
    model: "claude-haiku-4.5",
  });
  assert.equal(s, "[done in 1.4s \u00b7 claude-haiku-4.5]");
});

test("formatTurnFooter: '1 tool' is singular", () => {
  const s = formatTurnFooter({
    elapsedMs: 2_000,
    toolCount: 1,
    model: "kimi",
  });
  assert.match(s, /1 tool /);
  assert.doesNotMatch(s, /1 tools/);
});

test("formatTurnFooter: empty model is omitted gracefully", () => {
  const s = formatTurnFooter({
    elapsedMs: 800,
    toolCount: 0,
    model: "",
  });
  assert.equal(s, "[done in <1s]");
});

// ---------------------------------------------------------------------------
// formatFilesModifiedFooter
// ---------------------------------------------------------------------------

test("formatFilesModifiedFooter: empty list returns no lines", () => {
  // Critical: a chat-only turn must not emit an empty header.
  const lines = formatFilesModifiedFooter([]);
  assert.deepEqual(lines, []);
});

test("formatFilesModifiedFooter: single write produces heading + row", () => {
  const lines = formatFilesModifiedFooter([
    { tool: "write_file", path: "src/foo.ts", ok: true },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "files modified (1)");
  assert.match(lines[1], /src\/foo\.ts/);
  assert.match(lines[1], /write_file$/);
});

test("formatFilesModifiedFooter: multiple writes pluralize the count", () => {
  const lines = formatFilesModifiedFooter([
    { tool: "edit_file", path: "a.ts", ok: true },
    { tool: "edit_file", path: "b.ts", ok: true },
    { tool: "write_file", path: "c.md", ok: true },
  ]);
  assert.equal(lines[0], "files modified (3)");
  assert.equal(lines.length, 4);
});

test("formatFilesModifiedFooter: failed writes carry a (failed) tag", () => {
  // Failed attempts must be visible \u2014 the user needs to know the
  // agent tried, not silently assume nothing happened.
  const lines = formatFilesModifiedFooter([
    { tool: "edit_file", path: "src/foo.ts", ok: false },
  ]);
  assert.match(lines[1], /\(failed\)/);
});

test("formatFilesModifiedFooter: paths are aligned for readability", () => {
  // Soft alignment: short paths are padded so the tool column lines
  // up. Longer paths beyond the cap fall back to single-space.
  const lines = formatFilesModifiedFooter([
    { tool: "edit_file", path: "a.ts", ok: true },
    { tool: "edit_file", path: "longer-name.ts", ok: true },
  ]);
  // Both rows should end with the tool name; if alignment worked,
  // the tool names appear at the same column.
  const idxA = lines[1].indexOf("edit_file");
  const idxB = lines[2].indexOf("edit_file");
  assert.equal(idxA, idxB);
});

test("calculateWriteStats: edit_file reports added and removed lines", () => {
  const stats = calculateWriteStats(
    "edit_file",
    JSON.stringify({
      path: "src/a.ts",
      old_string: "old\nvalue",
      new_string: "new\nvalue\nextra",
    }),
  );
  assert.deepEqual(stats, { added: 3, removed: 2 });
});

test("calculateWriteStats: write_file create reports additive-only stats", () => {
  const stats = calculateWriteStats(
    "write_file",
    JSON.stringify({ path: "fresh.txt", content: "a\nb\n" }),
    JSON.stringify({ created: true }),
  );
  assert.deepEqual(stats, { added: 3 });
});

test("calculateWriteStats: write_file overwrite suppresses fake line stats", () => {
  const stats = calculateWriteStats(
    "write_file",
    JSON.stringify({ path: "existing.txt", content: "replacement\ntext" }),
    JSON.stringify({ created: false }),
  );
  assert.equal(stats, undefined);
});

test("calculateWriteStats: write_file create with empty content reports zero added lines", () => {
  const stats = calculateWriteStats(
    "write_file",
    JSON.stringify({ path: "empty.txt", content: "" }),
    JSON.stringify({ created: true }),
  );
  assert.deepEqual(stats, { added: 0 });
});

test("calculateWriteStats: edit_file empty→empty reports zero line changes", () => {
  const stats = calculateWriteStats(
    "edit_file",
    JSON.stringify({
      path: "src/a.ts",
      old_string: "",
      new_string: "",
    }),
  );
  assert.deepEqual(stats, { added: 0, removed: 0 });
});
