/**
 * Agent prose panel — DOM-based renderer for agent dialogue.
 *
 * Lives next to xterm in the workspace. xterm stays as the shell
 * surface (cell-grid behavior, fixed-width fonts, real terminal
 * semantics); this view renders agent prose as ordinary HTML so
 * `overflow-wrap: break-word` handles wrapping and resize is a no-op.
 *
 * Phase 1 scope (this file): plain-text streaming with ANSI stripped.
 * Phase 2 ports the markdown / inline-code formatters into DOM nodes.
 * Phase 3 absorbs tool log, review block, headers, footers, errors.
 */

/**
 * Strip ANSI escape sequences (CSI, OSC, two-byte) from a string so
 * the agent panel doesn't render `\x1b[1;36m` literally while we
 * still have an upstream pipeline that emits ANSI for xterm.
 *
 * Intentionally permissive: any malformed sequence is dropped along
 * with the surrounding bytes up to the next safe boundary.
 */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b[@-Z\\-_]/g, ""); // bare two-byte
}

/** Public surface used by `AgentController`. Kept minimal in phase 1
 * so the controller can side-by-side-render with xterm; later phases
 * grow this to cover tool log, review, headers, footers, errors. */
export interface AgentViewApi {
  /** Append streaming prose text to the active turn. ANSI is stripped. */
  appendProse(text: string): void;
  /** Mark the boundary between the user's prompt and the next turn's
   * assistant response so the panel can group content visually. */
  beginTurn(userPrompt: string): void;
  /** Mark the current turn as complete (closes any open paragraph). */
  endTurn(): void;
  /** Wipe the entire view. Used by `/new` / session reset. */
  clear(): void;
}

export class AgentView implements AgentViewApi {
  private readonly root: HTMLElement;
  private readonly scrollHost: HTMLElement;
  private currentProse: HTMLElement | null = null;

  constructor(host: HTMLElement) {
    this.root = host;
    // Internal scroll container so the panel scrolls independently
    // from the page; auto-scrolls to bottom as new prose arrives.
    this.scrollHost = document.createElement("div");
    this.scrollHost.className = "agent-stage-scroll";
    this.root.appendChild(this.scrollHost);
  }

  beginTurn(userPrompt: string): void {
    const turn = document.createElement("article");
    turn.className = "agent-turn";

    const userBlock = document.createElement("div");
    userBlock.className = "agent-turn-user";
    userBlock.textContent = userPrompt;
    turn.appendChild(userBlock);

    const proseBlock = document.createElement("div");
    proseBlock.className = "agent-turn-prose";
    turn.appendChild(proseBlock);

    this.scrollHost.appendChild(turn);
    this.currentProse = proseBlock;
    this.scrollToBottom();
  }

  appendProse(text: string): void {
    if (!this.currentProse) {
      // Defensive: caller appended without a beginTurn. Open one
      // implicitly so the text isn't lost.
      this.beginTurn("");
    }
    const target = this.currentProse;
    if (!target) return;
    const cleaned = stripAnsi(text);
    if (cleaned.length === 0) return;
    target.appendChild(document.createTextNode(cleaned));
    this.scrollToBottom();
  }

  endTurn(): void {
    this.currentProse = null;
  }

  clear(): void {
    this.scrollHost.innerHTML = "";
    this.currentProse = null;
  }

  /** True when the user has scrolled within ~24px of the bottom edge. */
  private isPinnedToBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.scrollHost;
    return scrollHeight - (scrollTop + clientHeight) < 24;
  }

  private scrollToBottom(): void {
    // Only auto-scroll when the user is already pinned to the bottom
    // — otherwise we'd yank the viewport away from a passage they're
    // reading mid-stream.
    if (this.isPinnedToBottom()) {
      this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
    }
  }
}
