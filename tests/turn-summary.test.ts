import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanToolSummary,
  extractWritePath,
  formatElapsed,
  formatFilesModifiedFooter,
  formatTurnFooter,
  WRITE_TOOL_NAMES,
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

test("cleanToolSummary: strips path from read_file summary", () => {
  // Rust emits 'read /Users/.../foo.ts (1.2 KB)'; we want just the
  // verb + parenthetical content since the path is on the args line.
  const out = cleanToolSummary(
    "read_file",
    "read /Users/x/proj/src/foo.ts (1.2 KB)",
  );
  assert.equal(out, "read 1.2 KB");
});

test("cleanToolSummary: strips path from write_file (created)", () => {
  const out = cleanToolSummary("write_file", "created /path/to/new.md (820 B)");
  assert.equal(out, "created 820 B");
});

test("cleanToolSummary: strips path from edit_file (replacements)", () => {
  const out = cleanToolSummary(
    "edit_file",
    "edited /path/file.ts (3 replacements)",
  );
  assert.equal(out, "edited 3 replacements");
});

test("cleanToolSummary: strips path from list_directory", () => {
  const out = cleanToolSummary("list_directory", "listed /repo/src (14 entries)");
  assert.equal(out, "listed 14 entries");
});

test("cleanToolSummary: passes through non-path tools verbatim", () => {
  // grep, http_fetch, run_shell, etc. don't carry a duplicated path
  // and we must not chop their summaries.
  const grep = cleanToolSummary("grep", 'matched 12 lines in 3 files');
  assert.equal(grep, "matched 12 lines in 3 files");

  const fetch = cleanToolSummary(
    "http_fetch",
    "http_fetch GET http://localhost:3000/api/health \u2192 200 OK (123 ms)",
  );
  assert.equal(
    fetch,
    "http_fetch GET http://localhost:3000/api/health \u2192 200 OK (123 ms)",
  );
});

test("cleanToolSummary: passes through unparseable summary unchanged", () => {
  // Defensive: if a path-tool's summary doesn't match the
  // 'verb path (info)' shape (e.g. an error message), return verbatim
  // so we don't lose information.
  const out = cleanToolSummary("read_file", "error: cannot read file");
  assert.equal(out, "error: cannot read file");
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
