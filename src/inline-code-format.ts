// Streaming-safe inline-code colorizer.
//
// Detects backtick-delimited spans in markdown prose as it streams in
// from the model, and wraps the inner text in ANSI cyan so file paths,
// identifiers, and command names visually pop the way they do in
// Cursor / Claude desktop / Antigravity. Triple-backtick fenced code
// blocks are passed through untouched — those need a different (HTML
// overlay) renderer that's deferred to IDE Phase 2; see
// `docs/futurework/xterm-cosmetics.md`.
//
// Why a class with state instead of a single regex sweep: the model
// streams tokens char-by-char (sometimes mid-byte), and a backtick or
// even a triple-backtick boundary can be split across two or three
// chunks. A single-pass regex on each chunk would mis-detect those
// boundaries. The state machine here buffers backtick runs across
// chunks and decides single vs triple only after the run is complete.
//
// The buffer is intentionally tiny — only the trailing run of `\``
// characters is held back. Non-backtick output streams immediately so
// the user perceives no latency on prose.

/** ANSI sequence enabling dim cyan. Chosen to match the existing
 * tool-name styling in agent.ts (`\x1b[36m`) so inline code reads
 * as a continuation of the same visual language. */
const ANSI_INLINE_OPEN = "\x1b[36m";
/** ANSI reset to return to default fg/bg. */
const ANSI_RESET = "\x1b[0m";

/**
 * Per-turn streaming colorizer for assistant prose. Instantiate one
 * per agent turn; call `process()` on each incoming token and write
 * the returned string to xterm. Call `flush()` at end-of-turn to
 * emit any buffered backticks and reset open ANSI state.
 */
export class InlineCodeFormatter {
  /** True while we're inside a single-backtick inline-code span. */
  private inInlineCode = false;
  /** True while we're inside a triple-backtick fenced block. */
  private inFencedCode = false;
  /** Count of consecutive backticks just seen but not yet emitted.
   * Buffered so we can disambiguate single vs triple after the run
   * ends, even if it spans multiple streaming chunks. */
  private backtickRun = 0;

  /** Reset state for a fresh turn. Call before reusing the formatter. */
  reset(): void {
    this.inInlineCode = false;
    this.inFencedCode = false;
    this.backtickRun = 0;
  }

  /**
   * Consume a streaming chunk and return the colorized output ready
   * to write to xterm. Stateful: subsequent calls continue from where
   * the previous one left off. Trailing backticks in `piece` are NOT
   * emitted yet (they're buffered until the next call's first
   * non-backtick char or until `flush()`).
   */
  process(piece: string): string {
    let out = "";
    for (let i = 0; i < piece.length; i++) {
      const ch = piece[i];
      if (ch === "`") {
        this.backtickRun++;
        continue;
      }
      // Non-backtick char: first flush any pending backtick run, then
      // emit the char.
      if (this.backtickRun > 0) {
        out += this.flushBackticks();
      }
      out += ch;
    }
    return out;
  }

  /**
   * Flush any held-back state and return the result. Called at the
   * end of a turn (onDone) so an unbalanced inline-code span can't
   * leak its color across the next prompt's prose.
   */
  flush(): string {
    let out = "";
    if (this.backtickRun > 0) {
      out += this.flushBackticks();
    }
    if (this.inInlineCode) {
      out += ANSI_RESET;
      this.inInlineCode = false;
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  /** Decide what to emit for the just-completed backtick run, then
   * reset the run counter. */
  private flushBackticks(): string {
    const n = this.backtickRun;
    this.backtickRun = 0;
    let out = "";
    if (n >= 3) {
      // Triple (or more) backticks: a fenced-code-block boundary.
      // Toggle the fence state; any extra backticks beyond the third
      // are treated as inline-code toggles immediately after.
      if (this.inFencedCode) {
        this.inFencedCode = false;
      } else {
        // Closing any open inline-code span first prevents an
        // unbalanced inline span from bleeding ANSI state into the
        // fenced block's body.
        if (this.inInlineCode) {
          out += "`" + ANSI_RESET;
          this.inInlineCode = false;
          // The above accounts for one of the n backticks; remaining
          // count is n-1 minus the 3 we'll emit as the fence below.
          // Easier to re-derive cleanly:
          out += "``"; // we owe two more to reach the triple
          for (let i = 0; i < n - 3; i++) {
            out += this.toggleInline();
          }
          this.inFencedCode = true;
          return out;
        }
        this.inFencedCode = true;
      }
      out += "```";
      for (let i = 0; i < n - 3; i++) {
        out += this.toggleInline();
      }
    } else {
      // Run of 1 or 2 backticks. Inside a fenced block we pass them
      // through verbatim (could legitimately be code content). Outside,
      // each backtick toggles inline-code state.
      if (this.inFencedCode) {
        out += "`".repeat(n);
      } else {
        for (let i = 0; i < n; i++) {
          out += this.toggleInline();
        }
      }
    }
    return out;
  }

  /** Emit a single backtick that flips inline-code state, with the
   * matching ANSI open/close sequence around it so the backticks
   * themselves render in the same color as the span they delimit. */
  private toggleInline(): string {
    if (this.inInlineCode) {
      this.inInlineCode = false;
      return "`" + ANSI_RESET;
    } else {
      this.inInlineCode = true;
      return ANSI_INLINE_OPEN + "`";
    }
  }
}
