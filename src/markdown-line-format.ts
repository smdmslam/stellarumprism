// Streaming-safe markdown line-marker formatter.
//
// Detects markdown structural markers at the START of a line as the
// model streams in tokens, and rewrites them with ANSI styling so
// assistant prose reads with structure instead of as a wall of dim
// text. Specifically:
//
//   ^#{1,3} <text>     headings    \u2192 dim hashes + bold cyan content
//   ^- <text>          unordered   \u2192 dim-cyan \u2022 glyph + space + content
//   ^\* <text>         unordered   \u2192 dim-cyan \u2022 glyph + space + content
//
// Numbered lists are deliberately deferred \u2014 they add a multi-char
// buffer state machine for marginal payoff. Indented (nested) markers
// are also deferred \u2014 only line-start markers fire. Both expansions
// fit cleanly on top of the current state shape if we want them later.
//
// Why a class with state instead of a per-chunk regex sweep:
//   - Tokens stream char-by-char; a marker can be split across chunks
//     (e.g. "##" in one token, " Heading" in the next).
//   - Headings need a "scope close" event at the next \n so the bold
//     ANSI doesn't leak past the line. We have to track an open-bold
//     state across chunks.
//   - Fenced ``` blocks must fully suppress markdown rules; that's a
//     line-start lookahead the chunk boundary can split.
//
// Composition with `inline-code-format.ts`:
//   This formatter runs FIRST in the agent's onToken pipeline, then
//   passes its output to InlineCodeFormatter for backtick handling.
//   The two formatters track fenced-block state independently \u2014
//   they're computing the same decision off the same input, so they
//   stay in sync without sharing memory.

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_CYAN = "\x1b[36m";
/** Heading prose: bold + cyan. Closes on the next newline. */
const ANSI_HEADING_OPEN = ANSI_BOLD + ANSI_CYAN;
/** Bullet glyph: dim cyan, narrow visual weight so the prose pops. */
const ANSI_BULLET_OPEN = ANSI_DIM + ANSI_CYAN;

/**
 * Per-turn streaming markdown formatter. Instantiate one per agent
 * turn, call `process()` on each incoming token chunk, write the
 * returned string to xterm. Call `flush()` at end-of-turn to emit any
 * buffered chars and close any open heading scope.
 */
export class MarkdownLineFormatter {
  /** True at stream start and after every emitted '\n'. */
  private atLineStart = true;
  /** True when we've seen ``` at a line start and are inside a code fence. */
  private inFencedCode = false;
  /** Held-back chars that may resolve into a marker. Tiny by construction. */
  private buffer = "";
  /** True when we've opened heading ANSI but not yet closed it (close on \n). */
  private inHeading = false;

  /** Reset state for a fresh turn. */
  reset(): void {
    this.atLineStart = true;
    this.inFencedCode = false;
    this.buffer = "";
    this.inHeading = false;
  }

  /**
   * Consume a streaming chunk and return ANSI-styled output ready
   * to write to xterm. Stateful: call repeatedly across the turn.
   */
  process(piece: string): string {
    let out = "";
    for (let i = 0; i < piece.length; i++) {
      out += this.consume(piece[i]);
    }
    return out;
  }

  /**
   * Drain held state at end-of-turn. Emits any buffered (unresolved)
   * chars verbatim and closes an open heading scope so its bold ANSI
   * can't leak into the next prompt's prose.
   */
  flush(): string {
    let out = "";
    if (this.buffer.length > 0) {
      out += this.buffer;
      this.buffer = "";
    }
    if (this.inHeading) {
      out += ANSI_RESET;
      this.inHeading = false;
    }
    return out;
  }

  // -- internals ----------------------------------------------------------

  private consume(ch: string): string {
    // Newlines close any open heading scope and re-arm line-start
    // detection. Carriage returns don't, on the theory that the model
    // could emit "\r\n" and we want only one close-emit. The check
    // covers both by treating '\n' alone as the trigger.
    if (ch === "\n") {
      let out = "";
      // Drain any unresolved buffer first (e.g. "## " on its own
      // followed immediately by newline).
      if (this.buffer.length > 0) {
        out += this.buffer;
        this.buffer = "";
      }
      if (this.inHeading) {
        out += ANSI_RESET;
        this.inHeading = false;
      }
      out += ch;
      this.atLineStart = true;
      return out;
    }

    // Mid-buffer resolution: every char while we have a buffer goes
    // through tryResolve() to decide whether the buffered prefix is a
    // marker, definitely-not, or still ambiguous.
    if (this.buffer.length > 0) {
      this.buffer += ch;
      return this.tryResolve();
    }

    // No buffer, at line start, NOT inside a code fence: the only
    // chars that could begin a marker are #, -, *, and `. Anything
    // else streams immediately and clears the line-start flag.
    if (this.atLineStart && !this.inFencedCode) {
      if (ch === "#" || ch === "-" || ch === "*" || ch === "`") {
        this.buffer = ch;
        return "";
      }
    }

    // Inside a fenced block, the only marker we care about is the
    // closing ``` at line start. Everything else passes through.
    if (this.atLineStart && this.inFencedCode && ch === "`") {
      this.buffer = ch;
      return "";
    }

    this.atLineStart = false;
    return ch;
  }

  /**
   * Decide whether the current buffer represents a marker, a
   * definitely-not-a-marker prefix, or remains ambiguous. Returns
   * the string to emit (possibly empty when still buffering).
   */
  private tryResolve(): string {
    const buf = this.buffer;
    const first = buf[0];

    // ---- Fenced block delimiter (``` at line start) -------------------
    if (first === "`") {
      // Need exactly 3 backticks to toggle. Any non-backtick before
      // we hit 3 means it wasn't a fence \u2014 emit verbatim.
      if (buf.length < 3) {
        if (buf[buf.length - 1] !== "`") {
          return this.giveUpBuffer();
        }
        return ""; // keep buffering toward 3
      }
      if (buf === "```") {
        this.inFencedCode = !this.inFencedCode;
        this.buffer = "";
        this.atLineStart = false;
        // Emit the literal ``` so the InlineCodeFormatter downstream
        // still sees and handles it (backtick coloring of fence).
        return "```";
      }
      // 3 chars but not all backticks (impossible given the per-char
      // check above, but handled defensively).
      return this.giveUpBuffer();
    }

    // ---- Headings (1-3 # then space then content) ---------------------
    if (first === "#") {
      const lastCh = buf[buf.length - 1];
      // Still in the run of #'s: keep buffering until a space (or
      // overflow at 4+). 4+ # is not a heading by CommonMark; emit
      // verbatim.
      if (lastCh === "#") {
        if (buf.length > 3) return this.giveUpBuffer();
        return "";
      }
      // Run ended. Was it ended by a space? Then it's a heading
      // (1-3 hashes guaranteed by the overflow check above).
      const hashes = buf.length - 1;
      if (lastCh === " " && hashes >= 1 && hashes <= 3) {
        this.buffer = "";
        this.atLineStart = false;
        this.inHeading = true;
        // Dim hashes (subtle marker) + space + bold-cyan open. The
        // bold-cyan stays open until the next '\n' closes it.
        return `${ANSI_DIM}${"#".repeat(hashes)}${ANSI_RESET} ${ANSI_HEADING_OPEN}`;
      }
      // Run ended on a non-space (e.g. "#foo" — not a heading per
      // CommonMark which requires space after the hashes).
      return this.giveUpBuffer();
    }

    // ---- Unordered bullets ('- ' or '* ' at line start) ---------------
    if (first === "-" || first === "*") {
      if (buf.length === 1) return ""; // peek the next char first
      const next = buf[1];
      if (next === " ") {
        this.buffer = "";
        this.atLineStart = false;
        // Replace the dash/star with a small dim-cyan bullet glyph
        // and the space the model emitted. The body of the bullet
        // streams through normally afterward.
        return `${ANSI_BULLET_OPEN}\u2022${ANSI_RESET} `;
      }
      // Not a bullet \u2014 could be '**bold**', '--flag', etc.
      return this.giveUpBuffer();
    }

    // Shouldn't reach here \u2014 we only buffer on the chars above.
    return this.giveUpBuffer();
  }

  /**
   * The buffered prefix did NOT resolve to a marker. Flush it
   * verbatim, clear buffer state, and step out of line-start mode.
   * Centralized so every fall-through path stays consistent.
   */
  private giveUpBuffer(): string {
    const out = this.buffer;
    this.buffer = "";
    this.atLineStart = false;
    return out;
  }
}
