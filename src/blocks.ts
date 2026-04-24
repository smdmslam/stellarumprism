import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

/** Lifecycle of a single command+output region in the terminal. */
export type BlockStatus = "running" | "success" | "error";

export interface Block {
  id: string;
  /** The command text (captured via OSC 1337 PrismCmd=<base64>). */
  command: string;
  status: BlockStatus;
  /** Exit code reported by OSC 133;D. `undefined` while running. */
  exitCode?: number;
  /** Timestamps in ms since epoch. */
  startedAt: number;
  finishedAt?: number;
  /** xterm.js buffer marker pinned to the prompt line (first line of block). */
  marker?: IMarker;
  /** Gutter decoration showing status color. */
  decoration?: IDecoration;
}

type ChangeListener = (blocks: readonly Block[]) => void;

// ---------------------------------------------------------------------------
// Status colors (kept in sync with the CSS tokens in styles.css).
// ---------------------------------------------------------------------------
const COLOR_RUNNING = "#eab308"; // amber
const COLOR_SUCCESS = "#22c55e"; // green
const COLOR_ERROR = "#ef4444"; // red

// ---------------------------------------------------------------------------
// BlockManager
// ---------------------------------------------------------------------------

/**
 * Listens to OSC 133 semantic-prompt escapes emitted by the shell integration
 * and segments the terminal stream into a list of `Block`s.
 *
 * Event flow per command:
 *   OSC 133;A               -> prompt starts  (new block begins, status=running)
 *   OSC 1337;PrismCmd=<b64> -> captured just before the command runs
 *   OSC 133;C               -> output begins
 *   OSC 133;D;<exit_code>   -> command finished (status resolves)
 *   OSC 133;A               -> next prompt starts (loops)
 */
export class BlockManager {
  private readonly term: Terminal;
  private readonly blocks: Block[] = [];
  private active: Block | null = null;
  private readonly listeners = new Set<ChangeListener>();

  constructor(term: Terminal) {
    this.term = term;
    this.registerOscHandlers();
  }

  // -- public API -----------------------------------------------------------

  /** Subscribe to block-list changes. Returns an unsubscribe function. */
  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getBlocks(): readonly Block[] {
    return this.blocks;
  }

  /** Scroll the xterm viewport to the top of the given block. */
  scrollToBlock(id: string): void {
    const b = this.blocks.find((x) => x.id === id);
    if (b?.marker && !b.marker.isDisposed) {
      // `scrollToLine` expects absolute buffer line index.
      this.term.scrollToLine(b.marker.line);
    }
  }

  // -- internals ------------------------------------------------------------

  private emit(): void {
    const snapshot = [...this.blocks];
    for (const cb of this.listeners) cb(snapshot);
  }

  private registerOscHandlers(): void {
    // OSC 133 – semantic prompt (FinalTerm/Contour/Warp/VSCode-compatible).
    this.term.parser.registerOscHandler(133, (data) => {
      const [kind, ...rest] = data.split(";");
      switch (kind) {
        case "A":
          this.onPromptStart();
          break;
        case "B":
          // Prompt-end marker; nothing to do at the moment.
          break;
        case "C":
          this.onCommandStart();
          break;
        case "D": {
          const raw = rest[0];
          const parsed = raw !== undefined && raw !== "" ? Number(raw) : undefined;
          const ec = Number.isFinite(parsed) ? (parsed as number) : undefined;
          this.onCommandEnd(ec);
          break;
        }
      }
      // Return true so xterm treats the OSC as handled and doesn't render it.
      return true;
    });

    // OSC 1337 – iTerm2-style custom payload. We use PrismCmd=<base64>.
    this.term.parser.registerOscHandler(1337, (data) => {
      const m = /^PrismCmd=(.*)$/.exec(data);
      if (m && this.active) {
        this.active.command = safeAtob(m[1]);
        this.emit();
      }
      return true;
    });
  }

  private onPromptStart(): void {
    // If the previous block is still in-flight (shouldn't normally happen, but
    // guards against a missing OSC 133;D), resolve it as success.
    if (this.active && this.active.status === "running") {
      this.resolveActive(0);
    }

    const marker = this.term.registerMarker(0) ?? undefined;
    const block: Block = {
      id: cryptoRandomId(),
      command: "",
      status: "running",
      startedAt: Date.now(),
      marker,
    };

    if (marker) {
      block.decoration = this.term.registerDecoration({
        marker,
        overviewRulerOptions: {
          color: COLOR_RUNNING,
          position: "right",
        },
      }) ?? undefined;
    }

    this.active = block;
    this.blocks.push(block);
    this.emit();
  }

  private onCommandStart(): void {
    // OSC 133;C marks the boundary between prompt/input and command output.
    // We currently don't need to do anything here; `startedAt` remains the
    // prompt time for simplicity. A future iteration can distinguish
    // "time waiting at prompt" from "time running" using this marker.
  }

  private onCommandEnd(exitCode?: number): void {
    if (!this.active) return;
    this.resolveActive(exitCode);
    this.emit();
  }

  private resolveActive(exitCode: number | undefined): void {
    const block = this.active;
    if (!block) return;

    block.exitCode = exitCode;
    block.finishedAt = Date.now();
    block.status = exitCode === undefined || exitCode === 0 ? "success" : "error";

    // Swap the gutter color from amber (running) to green/red.
    if (block.decoration) {
      try {
        block.decoration.dispose();
      } catch {
        /* no-op */
      }
    }
    if (block.marker && !block.marker.isDisposed) {
      const color = block.status === "success" ? COLOR_SUCCESS : COLOR_ERROR;
      block.decoration = this.term.registerDecoration({
        marker: block.marker,
        overviewRulerOptions: {
          color,
          position: "right",
        },
      }) ?? undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cryptoRandomId(): string {
  // `crypto.randomUUID` is available in modern webviews (WKWebView on macOS).
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback: time + random suffix.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function safeAtob(b64: string): string {
  try {
    // `atob` gives Latin-1; decode as UTF-8 to handle non-ASCII commands.
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return b64;
  }
}
