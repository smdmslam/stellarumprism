import { test } from "node:test";
import assert from "node:assert/strict";

import { MarkdownLineFormatter } from "../src/markdown-line-format.ts";

// ANSI sequences emitted by the formatter. Keeping them as constants
// here so tests assert against the contract rather than hard-coding
// escape strings inline (easier to read AND tests fail with a useful
// diff if styling changes intentionally).
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const HEADING_OPEN = BOLD + CYAN;
const BULLET_OPEN = DIM + CYAN;

/** Helper: feed an entire string through process+flush in one go. */
function render(input: string): string {
  const f = new MarkdownLineFormatter();
  return f.process(input) + f.flush();
}

/** Helper: feed a string char-by-char to simulate the worst-case
 * streaming chunk-boundary where every token is one char wide. */
function renderStreaming(input: string): string {
  const f = new MarkdownLineFormatter();
  let out = "";
  for (const ch of input) out += f.process(ch);
  out += f.flush();
  return out;
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

test("heading h1: '# Foo' becomes dim hash + bold cyan content + reset on \\n", () => {
  const out = render("# Foo\n");
  assert.equal(out, `${DIM}#${RESET} ${HEADING_OPEN}Foo${RESET}\n`);
});

test("heading h2: '## Bar' uses two dim hashes", () => {
  const out = render("## Bar\n");
  assert.equal(out, `${DIM}##${RESET} ${HEADING_OPEN}Bar${RESET}\n`);
});

test("heading h3: '### Baz' uses three dim hashes", () => {
  const out = render("### Baz\n");
  assert.equal(out, `${DIM}###${RESET} ${HEADING_OPEN}Baz${RESET}\n`);
});

test("heading: 4+ hashes is NOT a heading (CommonMark caps at 6 but we only style 1-3)", () => {
  // We deliberately decline 4+ \u2014 anything with that many hashes is
  // either a code-style ASCII art separator or extreme nesting and
  // shouldn't get bold-cyan.
  const out = render("#### Foo\n");
  assert.equal(out, "#### Foo\n");
});

test("heading: '#Foo' (no space after hash) is NOT a heading", () => {
  // CommonMark requires a space after the hashes. Without it we let
  // the line stream through verbatim; otherwise '#bash-tag' would
  // accidentally style as a heading.
  const out = render("#Foo\n");
  assert.equal(out, "#Foo\n");
});

test("heading: open scope closes on the very next \\n, no leakage", () => {
  // Two-line input \u2014 first is a heading, second is plain prose.
  // The plain line must not inherit bold-cyan from the heading.
  const out = render("# Title\nbody\n");
  assert.equal(out, `${DIM}#${RESET} ${HEADING_OPEN}Title${RESET}\nbody\n`);
});

test("heading: scope is closed by flush() if no \\n arrived", () => {
  // Defensive: an unfinished heading at end-of-turn must not leak
  // ANSI into the next prompt's `you \u203a` line.
  const f = new MarkdownLineFormatter();
  let out = f.process("## Unfinished");
  out += f.flush();
  assert.equal(out, `${DIM}##${RESET} ${HEADING_OPEN}Unfinished${RESET}`);
});

// ---------------------------------------------------------------------------
// Bullets
// ---------------------------------------------------------------------------

test("bullet: '- item' becomes dim-cyan bullet + space + plain content", () => {
  const out = render("- foo\n");
  assert.equal(out, `${BULLET_OPEN}\u2022${RESET} foo\n`);
});

test("bullet: '* item' (asterisk variant) also becomes a bullet", () => {
  const out = render("* foo\n");
  assert.equal(out, `${BULLET_OPEN}\u2022${RESET} foo\n`);
});

test("bullet: '-flag' (no space) is NOT a bullet", () => {
  // '--flag' style CLI option in prose. Don't over-recognize.
  const out = render("--flag\n");
  assert.equal(out, "--flag\n");
});

test("bullet: '**bold**' (double asterisk) is NOT a bullet", () => {
  // Markdown bold marker; bullet detection must defer to the second
  // char being a space, which '**' fails by definition.
  const out = render("**bold**\n");
  assert.equal(out, "**bold**\n");
});

test("bullet: indented bullets ARE recognized and keep their leading whitespace", () => {
  // v1 was line-start-only; v2 supports nested bullets so the agent's
  // multi-level lists render with proper indentation. The leading
  // whitespace is preserved verbatim and only the marker is rewritten
  // to the dim-cyan bullet glyph.
  const out = render("  - nested\n");
  assert.equal(out, `  ${BULLET_OPEN}\u2022${RESET} nested\n`);
});

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

test("fenced: markers inside ``` block are NOT styled", () => {
  // # foo inside a fenced block is just code, not a heading.
  const out = render("```\n# not-a-heading\n- not-a-bullet\n```\n");
  assert.equal(
    out,
    "```\n# not-a-heading\n- not-a-bullet\n```\n",
  );
});

test("fenced: heading after the fence closes resumes styling", () => {
  // After the closing ```, the next # at line start is a heading again.
  const out = render("```\nx\n```\n# After\n");
  assert.equal(
    out,
    `\`\`\`\nx\n\`\`\`\n${DIM}#${RESET} ${HEADING_OPEN}After${RESET}\n`,
  );
});

test("fenced: ``` open with language tag still toggles state", () => {
  // ```ts is a common shape; we only toggle on the bare ``` prefix
  // and let the language tag stream through afterward. The chars
  // after the third backtick must NOT be markdown-styled because
  // we're now inside a fence.
  const out = render("```ts\n# in-code\n```\n");
  assert.equal(out, "```ts\n# in-code\n```\n");
});

// ---------------------------------------------------------------------------
// Streaming chunk boundaries
// ---------------------------------------------------------------------------

test("streaming: '## ' split across chunks still recognized", () => {
  const f = new MarkdownLineFormatter();
  const a = f.process("##");
  const b = f.process(" Heading\n");
  const out = a + b;
  assert.equal(out, `${DIM}##${RESET} ${HEADING_OPEN}Heading${RESET}\n`);
});

test("streaming: '- foo' fed one char at a time still produces a bullet", () => {
  const out = renderStreaming("- foo\n");
  assert.equal(out, `${BULLET_OPEN}\u2022${RESET} foo\n`);
});

test("streaming: '### Heading' fed char-by-char keeps scope tight", () => {
  const out = renderStreaming("### Heading\nbody\n");
  assert.equal(
    out,
    `${DIM}###${RESET} ${HEADING_OPEN}Heading${RESET}\nbody\n`,
  );
});

test("streaming: ``` boundary split across chunks still toggles", () => {
  const f = new MarkdownLineFormatter();
  const a = f.process("``");
  const b = f.process("`\n# inside\n");
  const c = f.process("```\n# after\n");
  const out = a + b + c;
  assert.equal(
    out,
    `\`\`\`\n# inside\n\`\`\`\n${DIM}#${RESET} ${HEADING_OPEN}after${RESET}\n`,
  );
});

// ---------------------------------------------------------------------------
// Mixed prose
// ---------------------------------------------------------------------------

test("mixed: heading then bullets then prose all render correctly", () => {
  const input = "# Plan\n- step one\n- step two\nThat's it.\n";
  const out = render(input);
  const expected =
    `${DIM}#${RESET} ${HEADING_OPEN}Plan${RESET}\n` +
    `${BULLET_OPEN}\u2022${RESET} step one\n` +
    `${BULLET_OPEN}\u2022${RESET} step two\n` +
    `That's it.\n`;
  assert.equal(out, expected);
});

test("mixed: bullets after a heading don't inherit heading bold", () => {
  // Regression guard: heading scope must close before the bullet
  // glyph emits, otherwise the bullet would appear in bold-cyan.
  const out = render("## Steps\n- one\n");
  // The heading reset must appear strictly before the bullet open.
  const headingClose = out.indexOf(RESET);
  const bulletOpen = out.indexOf(BULLET_OPEN);
  assert.ok(headingClose !== -1);
  assert.ok(bulletOpen !== -1);
  assert.ok(headingClose < bulletOpen);
});

test("idempotent: flush on a fresh formatter returns empty", () => {
  // Defensive: calling flush() with nothing buffered is a no-op.
  const f = new MarkdownLineFormatter();
  assert.equal(f.flush(), "");
});

test("idempotent: reset() returns formatter to a usable state", () => {
  // After processing some content, reset() should leave the formatter
  // ready to handle a new turn from scratch.
  const f = new MarkdownLineFormatter();
  f.process("# Old turn\n");
  f.flush();
  f.reset();
  const out = f.process("# Fresh\n");
  assert.equal(out, `${DIM}#${RESET} ${HEADING_OPEN}Fresh${RESET}\n`);
});
