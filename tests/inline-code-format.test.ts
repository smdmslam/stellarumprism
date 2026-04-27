import { test } from "node:test";
import assert from "node:assert/strict";

import { InlineCodeFormatter } from "../src/inline-code-format.ts";

const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

test("plain prose with no backticks passes through unchanged", () => {
  const f = new InlineCodeFormatter();
  const out = f.process("hello world");
  assert.equal(out, "hello world");
  assert.equal(f.flush(), "");
});

test("single inline-code span gets wrapped in cyan", () => {
  const f = new InlineCodeFormatter();
  const out = f.process("see `foo.ts` for details");
  assert.equal(out, `see ${CYAN}\`foo.ts\`${RESET} for details`);
  assert.equal(f.flush(), "");
});

test("two inline-code spans on one line each get wrapped", () => {
  const f = new InlineCodeFormatter();
  // Trailing backtick is buffered until flush() so process+flush
  // is the canonical \"finish a turn\" pattern; matches how onDone()
  // calls flush() in agent.ts.
  const out = f.process("compare `a.ts` and `b.ts`") + f.flush();
  assert.equal(
    out,
    `compare ${CYAN}\`a.ts\`${RESET} and ${CYAN}\`b.ts\`${RESET}`,
  );
});


test("backticks inside a fenced block are passed through verbatim", () => {
  const f = new InlineCodeFormatter();
  // Closing fence backticks are buffered; flush() emits them as the
  // close of the (now still-open) fence in plain ``` form.
  const out = f.process("```\nthe `inline` look\n```") + f.flush();
  assert.equal(out, "```\nthe `inline` look\n```");
});

test("backtick split across two chunks still pairs correctly", () => {
  const f = new InlineCodeFormatter();
  // Token 1 ends mid-pair; token 2 finishes the closing backtick.
  const a = f.process("see `fo");
  const b = f.process("o` here");
  assert.equal(a, `see ${CYAN}\`fo`);
  assert.equal(b, `o\`${RESET} here`);
});

test("triple backtick split across chunks still detects fence", () => {
  const f = new InlineCodeFormatter();
  // Three backticks split as 2 + 1; the formatter must hold them
  // back until it can decide single vs triple.
  const a = f.process("``"); // buffered, no emit yet
  assert.equal(a, "");
  const b = f.process("`\nbody"); // completes the triple, then prose
  assert.equal(b, "```\nbody");
});

test("unbalanced inline span is closed by flush()", () => {
  const f = new InlineCodeFormatter();
  // Stream ends mid-span (model truncated). Flush must emit the
  // RESET so subsequent writes don't inherit cyan.
  const out = f.process("look at `foo");
  assert.equal(out, `look at ${CYAN}\`foo`);
  const tail = f.flush();
  assert.equal(tail, RESET);
});

test("trailing backtick buffered until flush", () => {
  const f = new InlineCodeFormatter();
  // A single backtick at end of chunk is held — could be the start
  // of a triple. Flush emits it as a single inline-toggle.
  const a = f.process("hello `");
  assert.equal(a, "hello ");
  const tail = f.flush();
  // flush() emits the buffered backtick as an inline-open, then the
  // unbalanced-inline RESET path closes it.
  assert.equal(tail, `${CYAN}\`${RESET}`);
});

test("reset() clears state between turns", () => {
  const f = new InlineCodeFormatter();
  f.process("look at `foo"); // leaves inInlineCode = true
  f.reset();
  // Next turn starts fresh; non-backtick prose stays uncolored.
  const out = f.process("hello world");
  assert.equal(out, "hello world");
});

test("path-like strings get colored: a real-world prose sample", () => {
  const f = new InlineCodeFormatter();
  const sample =
    "I edited `src/agent.ts` and `tests/inline-code-format.test.ts`";
  const out = f.process(sample) + f.flush();
  assert.equal(
    out,
    `I edited ${CYAN}\`src/agent.ts\`${RESET} and ${CYAN}\`tests/inline-code-format.test.ts\`${RESET}`,
  );
});

test("inline span next to a fenced block doesn't leak", () => {
  const f = new InlineCodeFormatter();
  const out = f.process("`foo`\n```\nbar\n```\n`baz`") + f.flush();
  // Inline `foo` colored; fenced block raw; inline `baz` colored.
  assert.equal(
    out,
    `${CYAN}\`foo\`${RESET}\n\`\`\`\nbar\n\`\`\`\n${CYAN}\`baz\`${RESET}`,
  );
});
