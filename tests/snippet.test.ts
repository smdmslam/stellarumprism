// Regression tests for the Problems-panel snippet renderer.
// Same Node v22 built-in test runner as the rest of the suite; no new
// dev-deps.

import test from "node:test";
import assert from "node:assert/strict";

import {
  renderSnippet,
  renderSnippetError,
  type FileSnippet,
} from "../src/snippet.ts";

function snippet(over: Partial<FileSnippet> = {}): FileSnippet {
  return {
    path: over.path ?? "/work/proj/src/a.ts",
    original: over.original ?? "src/a.ts",
    start_line: over.start_line ?? 1,
    end_line: over.end_line ?? 5,
    target_line: over.target_line ?? 3,
    total_lines: over.total_lines ?? 100,
    content:
      over.content ??
      ["one", "two", "three", "four", "five"].join("\n"),
    truncated: over.truncated ?? false,
  };
}

test("renderSnippet emits one row per source line with absolute line numbers", () => {
  const html = renderSnippet(snippet());
  // 5 rows expected.
  const rowCount = (html.match(/class="snippet-row /g) ?? []).length;
  assert.equal(rowCount, 5);
  // Line numbers run from start_line through end_line.
  for (const n of [1, 2, 3, 4, 5]) {
    assert.match(html, new RegExp(`<span class="snippet-lineno">${n}</span>`));
  }
});

test("renderSnippet flags only the target line", () => {
  const html = renderSnippet(snippet({ target_line: 3 }));
  // Exactly one row carries the `target` class.
  const targetMatches = html.match(/snippet-row target/g) ?? [];
  assert.equal(targetMatches.length, 1);
  // The target-class row sits next to the line number we expect.
  assert.match(
    html,
    /<div class="snippet-row target"><span class="snippet-lineno">3<\/span>/,
  );
});

test("renderSnippet escapes HTML in source content", () => {
  const html = renderSnippet(
    snippet({
      content: '<script>alert("xss")</script>',
      start_line: 10,
      end_line: 10,
      target_line: 10,
    }),
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderSnippet escapes the file path", () => {
  const html = renderSnippet(snippet({ path: "/tmp/<bad>.ts" }));
  assert.doesNotMatch(html, /<bad>/);
  assert.match(html, /\/tmp\/&lt;bad&gt;\.ts/);
});

test("renderSnippet renders the range header with total line count", () => {
  const html = renderSnippet(
    snippet({
      start_line: 30,
      end_line: 50,
      total_lines: 412,
    }),
  );
  // Uses an en-dash between start/end.
  assert.match(html, /30\u201350 of 412/);
});

test("renderSnippet shows a 'clipped' badge when truncated", () => {
  const html = renderSnippet(snippet({ truncated: true }));
  assert.match(html, /class="snippet-truncated"/);
  assert.match(html, /clipped/);
  const noClip = renderSnippet(snippet({ truncated: false }));
  assert.doesNotMatch(noClip, /class="snippet-truncated"/);
});

test("renderSnippetError surfaces a precise message and optional path", () => {
  const withPath = renderSnippetError("oops", "src/a.ts");
  assert.match(withPath, /class="snippet snippet-error"/);
  assert.match(withPath, /src\/a\.ts/);
  assert.match(withPath, /oops/);
  const noPath = renderSnippetError("oops");
  assert.doesNotMatch(noPath, /class="snippet-error-path"/);
});

test("renderSnippetError escapes user-controlled message and path", () => {
  const html = renderSnippetError(
    '<img src=x onerror=alert(1)>',
    "src/<bad>.ts",
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<bad>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /src\/&lt;bad&gt;\.ts/);
});
