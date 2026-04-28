/**
 * Word wrapping for xterm output.
 *
 * xterm.js itself is cell-based and will happily split a word at the
 * right margin. This helper pre-wraps plain prose before it is written
 * so we prefer semantic break points:
 *
 *   1. spaces / existing newlines
 *   2. hyphens / underscores / dots inside identifiers
 *   3. camelCase / PascalCase boundaries
 *   4. hard split only as a last resort
 *
 * It is intentionally conservative: we do NOT attempt dictionary-backed
 * linguistic hyphenation yet. The goal is simply “don’t cut words at an
 * arbitrary cell boundary when a cleaner breakpoint exists”.
 */

/**
 * Wrap text for xterm output, respecting word boundaries where possible.
 *
 * Existing `\n` boundaries are preserved. Runs of spaces between words are
 * also preserved instead of being normalized to a single space.
 */
export function wrapForXterm(text: string, columns: number): string {
  if (columns <= 0 || text.length === 0) return text;

  const paragraphs = text.split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    lines.push(...wrapParagraph(paragraph, columns));
  }

  return lines.join("\n");
}

function wrapParagraph(paragraph: string, columns: number): string[] {
  if (paragraph.length === 0) return [""];

  const tokens = splitTokens(paragraph);
  const lines: string[] = [];
  let currentLine = "";

  // Pushing a line strips trailing whitespace so an interword space
  // that happened to fit on the previous line doesn't survive into
  // the line break ("gamma \ndelta" \u2192 "gamma\ndelta"). Internal
  // runs of whitespace between two words on the same emitted line
  // are preserved \u2014 we only ever strip what's at the very end.
  const pushCurrentLine = (): void => {
    lines.push(currentLine.replace(/\s+$/, ""));
    currentLine = "";
  };

  for (const token of tokens) {
    if (token.length === 0) continue;

    if (isWhitespace(token)) {
      if (currentLine.length === 0) continue;
      if (currentLine.length + token.length <= columns) {
        currentLine += token;
      } else {
        pushCurrentLine();
      }
      continue;
    }

    if (currentLine.length > 0 && currentLine.length + token.length <= columns) {
      currentLine += token;
      continue;
    }

    if (currentLine.length === 0 && token.length <= columns) {
      currentLine = token;
      continue;
    }

    if (currentLine.length > 0) {
      pushCurrentLine();
    }

    const chunks = splitLongToken(token, columns);
    if (chunks.length === 0) continue;

    currentLine = chunks[0]!;
    for (let i = 1; i < chunks.length; i += 1) {
      pushCurrentLine();
      currentLine = chunks[i]!;
    }
  }

  if (currentLine.length > 0 || lines.length === 0) {
    lines.push(currentLine.replace(/\s+$/, ""));
  }

  return lines;
}

/** Split a paragraph into alternating whitespace and non-whitespace runs. */
function splitTokens(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

function isWhitespace(token: string): boolean {
  return /^\s+$/.test(token);
}

/**
 * Split a long token (one with no whitespace) that cannot fit on one
 * line into a sequence of pieces that are each suitable for a line.
 *
 * Strategy:
 *   1. Tokenize the input into "atoms" at every semantic break point:
 *      - punctuation runs (`-`, `_`, `/`, `.`) stay attached to the
 *        atom immediately before them so the punctuation lives at
 *        end-of-line (`"state-of-the-art"` → `["state-", "of-", "the-", "art"]`)
 *      - camelCase / PascalCase / digit transitions split between the
 *        boundary characters so the upper / digit starts a new atom
 *        (`"renderMarkdownLineFormatter"` → `["render", "Markdown",
 *        "Line", "Formatter"]`)
 *   2. Pack atoms greedily onto a line, but only merge an atom onto
 *      the previous one when the previous atom ends with a punctuation
 *      breakpoint. Atoms ending in plain letters (i.e. those produced
 *      by case / digit transitions or a hard split) get their own line
 *      so the visual boundary that distinguished them isn't smothered
 *      by recombination.
 *   3. If no breakpoints exist at all (e.g. `"supercalifragilistic"`),
 *      fall back to a fixed-width hard split.
 *
 * One-character overshoot of `columns` is tolerated for atoms that
 * end in punctuation (e.g. `"identifier_"` at columns=10) because
 * keeping the punctuation glued to the end of the line produces a
 * cleaner visual break than hard-splitting it off.
 */
function splitLongToken(token: string, columns: number): string[] {
  if (columns <= 0) return [token];
  if (token.length <= columns) return [token];

  const atoms = splitTokenAtoms(token);

  // No semantic break points at all \u2014 hard wrap at column boundary.
  if (atoms.length === 1 && atoms[0]!.length > columns) {
    return hardSplit(atoms[0]!, columns);
  }

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const atom of atoms) {
    if (current.length === 0) {
      current = atom;
      continue;
    }

    // Only pack the next atom onto the current line when the line
    // currently ends in punctuation; otherwise the camelCase /
    // digit-transition signal that separated the atoms gets erased
    // when they're glued back together.
    if (!endsWithBreakable(current)) {
      flush();
      current = atom;
      continue;
    }

    if (current.length + atom.length <= columns) {
      current += atom;
    } else {
      flush();
      current = atom;
    }
  }
  flush();
  return chunks;
}

/**
 * Split a token into atoms at every semantic break point. Punctuation
 * (`-`, `_`, `/`, `.`) stays glued to the preceding atom; case- and
 * digit-transitions split between the two characters so the new atom
 * starts with the upper / digit.
 */
function splitTokenAtoms(token: string): string[] {
  if (token.length === 0) return [];
  const atoms: string[] = [];
  let start = 0;
  for (let i = 1; i < token.length; i += 1) {
    const prev = token[i - 1]!;
    const curr = token[i]!;
    let breakHere = false;
    if (prev === "-" || prev === "_" || prev === "/" || prev === ".") {
      breakHere = true;
    } else if (isLowerOrDigit(prev) && isUpper(curr)) {
      breakHere = true;
    } else if (
      (isLetter(prev) && isDigit(curr)) ||
      (isDigit(prev) && isLetter(curr))
    ) {
      breakHere = true;
    }
    if (breakHere) {
      atoms.push(token.slice(start, i));
      start = i;
    }
  }
  atoms.push(token.slice(start));
  return atoms;
}

/** True iff `s` ends with a punctuation character we treat as a soft break. */
function endsWithBreakable(s: string): boolean {
  if (s.length === 0) return false;
  const last = s[s.length - 1]!;
  return last === "-" || last === "_" || last === "/" || last === ".";
}

/** Fixed-width hard split for atoms that have no internal breakpoints. */
function hardSplit(token: string, columns: number): string[] {
  if (columns <= 0) return [token];
  const out: string[] = [];
  for (let i = 0; i < token.length; i += columns) {
    out.push(token.slice(i, i + columns));
  }
  return out;
}

function isUpper(ch: string): boolean {
  return /^[A-Z]$/.test(ch);
}

function isLetter(ch: string): boolean {
  return /^[A-Za-z]$/.test(ch);
}

function isDigit(ch: string): boolean {
  return /^[0-9]$/.test(ch);
}

function isLowerOrDigit(ch: string): boolean {
  return /^[a-z0-9]$/.test(ch);
}

/**
 * Simple hard wrap fallback. Kept for callers that want deterministic
 * fixed-width splitting without breakpoint heuristics.
 */
export function simpleWrap(text: string, columns: number): string {
  if (columns <= 0) return text;

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    for (let i = 0; i < paragraph.length; i += columns) {
      lines.push(paragraph.slice(i, i + columns));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Streaming wrapper
// ---------------------------------------------------------------------------

/**
 * ANSI-aware streaming word wrap for xterm output.
 *
 * The model streams text token-by-token. xterm itself will hard-wrap
 * at the terminal's column boundary the moment a cell overflows,
 * which produces "shoul" / "d" splits in the middle of normal English
 * words whenever a word happens to straddle the right margin.
 * Pre-buffering a whole assistant response and running `wrapForXterm`
 * would fix that, but it would also defeat streaming \u2014 the user
 * would see the reply appear in big clumps instead of as it arrives.
 *
 * `StreamWrapper` is the streaming equivalent: it watches characters
 * as they fly past, tracks the visible column on the current row, and
 * inserts a `\r\n` _before_ any word that would overflow `columns`.
 *
 * Two pieces of state make this robust:
 *
 *   1. **Deferred-space buffering.** Spaces between words don't get
 *      written immediately. They sit in `interBuf` until the next
 *      word commits to the same row, at which point they're emitted
 *      alongside the word. If the word doesn't fit and we have to
 *      wrap, the held-back spaces are dropped \u2014 they would otherwise
 *      end up stranded at the end of the previous row, surviving even
 *      across chunk boundaries where a downstream `rstrip` can't
 *      reach them.
 *
 *   2. **Cross-chunk ANSI parsing.** ANSI escape sequences (CSI / OSC
 *      / two-byte) can be split across multiple `process()` calls.
 *      `escBuf` carries an in-progress sequence forward so its
 *      parameter bytes never get miscounted as visible width when the
 *      sequence happens to straddle a chunk boundary.
 *
 * ANSI bytes are tracked separately from visible chars so styled
 * output (bold headings, cyan inline code) wraps on perceived width,
 * not raw byte count.
 */
export class StreamWrapper {
  /** Visible chars already committed to the current row. */
  private col = 0;
  /** "in-word" once we've seen a visible non-space char since the
   * last word commit / newline; "between" otherwise. Drives whether
   * incoming ANSI sequences attach to `wordBuf` or `interBuf`. */
  private mode: "between" | "in-word" = "between";
  /** Held-back content between the last committed word and the next
   * pending word: spaces, tabs, and any ANSI sequences that arrived
   * while we were between words. Emitted on commit only if the
   * pending word fits on the current row; dropped on wrap so the
   * spaces don't trail past the right margin or land at column 0. */
  private interBuf = "";
  /** Visible-char count of `interBuf` (ANSI excluded). */
  private interVisible = 0;
  /** Pending word: visible chars plus any ANSI seen mid-word. */
  private wordBuf = "";
  /** Visible-char count of `wordBuf`. */
  private wordVisible = 0;
  /** In-progress ANSI escape spanning chunk boundaries. Empty when
   * not currently inside an escape sequence. */
  private escBuf = "";

  /** Reset for a fresh turn. Call before each new agent query. */
  reset(): void {
    this.col = 0;
    this.mode = "between";
    this.interBuf = "";
    this.interVisible = 0;
    this.wordBuf = "";
    this.wordVisible = 0;
    this.escBuf = "";
  }

  /**
   * Consume a streaming chunk and return the wrapped output suitable
   * for direct write to xterm. Trailing visible characters of the
   * current word are NOT emitted yet \u2014 they wait for the next
   * whitespace or newline (or `flush()`).
   */
  process(chunk: string, columns: number): string {
    if (columns <= 0 || chunk.length === 0) return chunk;

    let out = "";
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i]!;

      // Continue an in-progress ANSI sequence carried over from a
      // previous chunk (or earlier this chunk). Each char appends to
      // escBuf until we recognise the terminator.
      if (this.escBuf.length > 0) {
        this.escBuf += ch;
        if (isAnsiTerminator(this.escBuf)) {
          this.attachAnsi(this.escBuf);
          this.escBuf = "";
        }
        i += 1;
        continue;
      }

      // Start of a new ANSI sequence.
      if (ch === "\x1b") {
        this.escBuf = "\x1b";
        i += 1;
        continue;
      }

      if (ch === "\n" || ch === "\r") {
        // Hard line break disregards wrap entirely. Emit any held
        // inter-word content + word verbatim, then the control char.
        out += this.interBuf + this.wordBuf + ch;
        this.interBuf = "";
        this.interVisible = 0;
        this.wordBuf = "";
        this.wordVisible = 0;
        this.mode = "between";
        this.col = 0;
        i += 1;
        continue;
      }

      if (ch === " " || ch === "\t") {
        // Whitespace closes the in-progress word. Commit the word
        // (which decides wrap) before accumulating the new space
        // into the inter-word buffer.
        if (this.mode === "in-word") {
          out += this.commitWord(columns);
          this.mode = "between";
        }
        this.interBuf += ch;
        this.interVisible += 1;
        i += 1;
        continue;
      }

      // Visible non-space char: extend the pending word.
      this.mode = "in-word";
      this.wordBuf += ch;
      this.wordVisible += 1;
      i += 1;
    }
    return out;
  }

  /**
   * Drain any held-back word at end-of-stream. Must be called at
   * `onDone` / `onError` so an in-flight word doesn't get stranded
   * inside the wrapper between turns.
   */
  flush(columns: number): string {
    let out = "";
    // Defensive: a chunk that ended mid-escape leaves escBuf populated.
    // Attach it to whichever side is current so it isn't silently lost.
    if (this.escBuf.length > 0) {
      this.attachAnsi(this.escBuf);
      this.escBuf = "";
    }
    if (this.wordVisible > 0) {
      out += this.commitWord(columns);
    } else if (this.wordBuf.length > 0) {
      // ANSI-only word (e.g. a trailing reset). Attach to the row
      // without counting it toward column width.
      out += this.interBuf + this.wordBuf;
      this.interBuf = "";
      this.interVisible = 0;
      this.wordBuf = "";
    }
    // Drop any purely trailing inter-word buffer so unused trailing
    // spaces don't land at column 0 of a future write.
    this.interBuf = "";
    this.interVisible = 0;
    this.mode = "between";
    return out;
  }

  // -- internals --------------------------------------------------------

  /**
   * Decide where the pending word goes:
   *   - `col === 0`: start of row \u2014 drop any visible spaces from the
   *     inter-word buffer (their natural place is between words on a
   *     non-empty row), keep ANSI scopes, then emit the word.
   *   - fits on current row: emit `interBuf + wordBuf` verbatim.
   *   - overflows: emit `\r\n`, drop visible spaces from `interBuf`
   *     (they would otherwise land at col 0 of the new row), keep
   *     any ANSI between words, then emit the word.
   */
  private commitWord(columns: number): string {
    let out = "";
    if (this.col === 0) {
      out += stripVisibleWhitespace(this.interBuf) + this.wordBuf;
      this.col = this.wordVisible;
    } else if (
      this.col + this.interVisible + this.wordVisible <= columns
    ) {
      out += this.interBuf + this.wordBuf;
      this.col += this.interVisible + this.wordVisible;
    } else {
      out += "\r\n" + stripVisibleWhitespace(this.interBuf) + this.wordBuf;
      this.col = this.wordVisible;
    }
    this.interBuf = "";
    this.interVisible = 0;
    this.wordBuf = "";
    this.wordVisible = 0;
    return out;
  }

  /** Attach a completed ANSI sequence to the current side of state. */
  private attachAnsi(seq: string): void {
    if (this.mode === "in-word") {
      this.wordBuf += seq;
    } else {
      this.interBuf += seq;
    }
  }
}

/**
 * Return true once `buf` (which must start with `\x1b`) holds a
 * complete ANSI escape sequence. Recognises CSI (`\x1b[<params><final>`),
 * OSC (`\x1b]<text>BEL` or `\x1b]<text>ESC\\`), and any two-byte
 * escape (everything else after `\x1b<X>`).
 */
function isAnsiTerminator(buf: string): boolean {
  if (buf.length < 2) return false;
  const second = buf[1]!;
  if (second === "[") {
    if (buf.length < 3) return false;
    const last = buf.charCodeAt(buf.length - 1);
    return last >= 0x40 && last <= 0x7e;
  }
  if (second === "]") {
    if (buf.length < 3) return false;
    const lastCh = buf[buf.length - 1]!;
    if (lastCh === "\x07") return true;
    if (lastCh === "\\" && buf[buf.length - 2] === "\x1b") return true;
    return false;
  }
  // Bare two-byte escape: `\x1b<X>` where X is anything other than
  // `[` / `]`. Length 2 means we've seen the second byte.
  return buf.length >= 2;
}

/** Remove plain space and tab characters from `s`, preserving
 * everything else (ANSI sequences in particular). Used at column-0
 * commit / wrap so trailing inter-word spaces don't show up at the
 * start of a fresh row. */
function stripVisibleWhitespace(s: string): string {
  if (s.length === 0) return s;
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch !== " " && ch !== "\t") out += ch;
  }
  return out;
}
