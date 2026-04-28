import { test } from "node:test";
import assert from "node:assert/strict";

import { wrapForXterm, StreamWrapper } from "../src/word-wrap.ts";

test("wrapForXterm preserves short lines", () => {
  assert.equal(wrapForXterm("short line", 40), "short line");
});

test("wrapForXterm wraps at spaces instead of splitting words", () => {
  assert.equal(
    wrapForXterm("alpha beta gamma", 10),
    "alpha beta\ngamma",
  );
});

test("wrapForXterm preserves explicit newlines", () => {
  assert.equal(
    wrapForXterm("alpha beta\ngamma delta", 10),
    "alpha beta\ngamma\ndelta",
  );
});

test("wrapForXterm breaks long hyphenated words at hyphens", () => {
  assert.equal(
    wrapForXterm("state-of-the-art", 8),
    "state-\nof-the-\nart",
  );
});

test("wrapForXterm breaks snake_case at underscores", () => {
  assert.equal(
    wrapForXterm("very_long_identifier_name", 10),
    "very_long_\nidentifier_\nname",
  );
});

test("wrapForXterm breaks camelCase before capitals", () => {
  assert.equal(
    wrapForXterm("renderMarkdownLineFormatter", 12),
    "render\nMarkdown\nLine\nFormatter",
  );
});

test("wrapForXterm does not emit empty lines for long first words", () => {
  assert.equal(
    wrapForXterm("supercalifragilistic test", 8),
    "supercal\nifragili\nstic\ntest",
  );
});

test("wrapForXterm preserves runs of internal whitespace between words", () => {
  assert.equal(
    wrapForXterm("alpha   beta gamma", 12),
    "alpha   beta\ngamma",
  );
});

// ---------------------------------------------------------------------------
// StreamWrapper
// ---------------------------------------------------------------------------

/** Helper: feed a string in fixed-size chunks and concat the output. */
function streamThrough(
  wrapper: StreamWrapper,
  text: string,
  columns: number,
  chunkSize: number,
): string {
  let out = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    out += wrapper.process(text.slice(i, i + chunkSize), columns);
  }
  out += wrapper.flush(columns);
  return out;
}

test("StreamWrapper passes short input through unchanged", () => {
  const w = new StreamWrapper();
  const out = streamThrough(w, "hello world", 80, 3);
  assert.equal(out, "hello world");
});

test("StreamWrapper inserts a hard break before a word that would overflow", () => {
  // "hello world should" with cols=12: "hello world" is 11 chars and
  // fits. The trailing space takes us to col 12 (still within). Then
  // "should" (6 chars) would push col to 18 \u2014 wrap before it.
  const w = new StreamWrapper();
  const out = streamThrough(w, "hello world should fit", 12, 4);
  assert.equal(out, "hello world\r\nshould fit");
});

test("StreamWrapper never splits a word in the middle, even across chunk boundaries", () => {
  // Feed the exact word that triggered the user's bug report
  // ("should") one character per chunk and verify it stays whole.
  const w = new StreamWrapper();
  const out = streamThrough(w, "aaa bbb ccc should ddd", 14, 1);
  // "aaa bbb ccc" is 11 chars; " should" would push to 18 \u2014 wrap.
  assert.equal(out, "aaa bbb ccc\r\nshould ddd");
});

test("StreamWrapper preserves explicit newlines and resets the column counter", () => {
  const w = new StreamWrapper();
  const out = streamThrough(w, "alpha beta\r\ngamma delta", 80, 5);
  assert.equal(out, "alpha beta\r\ngamma delta");
});

test("StreamWrapper does not count ANSI escapes toward the visible column", () => {
  // "\x1b[1;36mhello\x1b[0m world frob" \u2014 visible chars are
  // "hello world frob" which is 16 chars. With cols=14 we expect a
  // wrap before "frob" (visible col would be 17 if we kept it on the
  // current row). If the wrapper mistakenly counted ANSI bytes it
  // would wrap after "hello" instead.
  const w = new StreamWrapper();
  const styled = "\x1b[1;36mhello\x1b[0m world frob";
  const out = streamThrough(w, styled, 14, 4);
  assert.equal(out, "\x1b[1;36mhello\x1b[0m world\r\nfrob");
});

test("StreamWrapper drops a trailing space that would land at column 0", () => {
  // "foo " stops the wrapper at col 4 with a space \u2014 then "bar"
  // arrives, doesn't fit, so we wrap. The trailing space must NOT be
  // emitted at the start of the new row.
  const w = new StreamWrapper();
  const out = streamThrough(w, "foo bar baz", 4, 8);
  assert.equal(out, "foo\r\nbar\r\nbaz");
});

test("StreamWrapper.flush emits the final word verbatim if it still fits", () => {
  const w = new StreamWrapper();
  const out = streamThrough(w, "final", 80, 2);
  assert.equal(out, "final");
});

test("StreamWrapper passes through unchanged when columns is 0", () => {
  const w = new StreamWrapper();
  const out = streamThrough(w, "any text at all", 0, 4);
  assert.equal(out, "any text at all");
});
