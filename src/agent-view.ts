/**
 * Agent prose panel — DOM renderer for agent dialogue.
 *
 * xterm stays the shell surface (cell-grid behavior, real terminal
 * semantics). This view renders agent-owned content as ordinary HTML
 * so `overflow-wrap: break-word` handles wrapping and resize is a
 * free reflow on word boundaries — the architecture other AI IDEs
 * (Cursor, Antigravity) use.
 *
 * Streaming model:
 *   - One `<article class="agent-turn">` per query() turn.
 *   - Inside the turn, content lives in typed slots: notice (router /
 *     header), prose, tool-log, review, error. Each slot is its own
 *     child element; CSS handles spacing.
 *   - `appendProse(piece)` accumulates the raw assistant tokens in a
 *     buffer and re-renders the current prose section through `marked`
 *     on each call. That keeps mid-stream Markdown structure correct
 *     for headings, code fences, lists, links, inline code, etc.
 *   - `appendToolCall` renders one card per tool call.
 *   - The view is read-only — typing always lives in `.input-bar`.
 */
import { marked } from "marked";

// ---------------------------------------------------------------------------
// marked setup
// ---------------------------------------------------------------------------

// gfm:    fenced code blocks, tables, autolinks.
// breaks: convert single newline to <br>, matching how chat clients
//         render model output.
marked.setOptions({
  gfm: true,
  breaks: true,
});

/** Render Markdown to a DocumentFragment. Returns a fragment so the
 *  caller doesn't care how many top-level elements parsed out. */
function markdownToFragment(markdown: string): DocumentFragment {
  const html = marked.parse(markdown, { async: false }) as string;
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const frag = document.createDocumentFragment();
  while (tmp.firstChild) frag.appendChild(tmp.firstChild);
  return frag;
}

// ---------------------------------------------------------------------------
// ANSI stripping (transitional)
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences (CSI / OSC / two-byte). Used by
 *  `appendNotice` / `appendError` while the controller still composes
 *  those strings with embedded ANSI for xterm. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type NoticeKind =
  | "router" // auto-route / model-fallback announcements
  | "agent-header" // "✶ agent (model)"
  | "answer-rule" // "─── answer ───"
  | "stall" // "stream silent for Ns"
  | "files-modified" // end-of-turn write-tools footer
  | "turn-footer" // "done in Ns · N tools · model"
  | "grounded-warning"; // grounded-chat rigor caution

export interface ToolCallInfo {
  name: string;
  argsPretty: string;
  status: "ok" | "fail";
  summary: string;
}

export interface AgentViewApi {
  /** Open a new turn, echoing the user's prompt at the top. */
  beginTurn(userPrompt: string): void;
  /** Append (and re-render) Markdown prose into the current turn. */
  appendProse(piece: string): void;
  /** Render a tool-call card in the current turn's tool-log. */
  appendToolCall(info: ToolCallInfo): void;
  /** Open the review slot and append a chunk to it. */
  appendReview(piece: string): void;
  /** Render a typed notice line (router note, header, footer, etc.). */
  appendNotice(kind: NoticeKind, body: string): void;
  /**
   * Render a one-shot Markdown report section into the current turn.
   * Unlike `appendProse` (streaming, buffer-accumulating) each call to
   * `appendReport` creates a fresh `<section>` so structural slash-
   * command output (`/protocol`, future `/help` / `/models` / `/last`
   * conversions) gets headings, lists, and inline code rendered
   * properly via the existing `.markdown-body` styling.
   */
  appendReport(markdown: string): void;
  /** Mount an arbitrary DOM element (e.g. ProtocolReportCard) inline. */
  appendCard(card: HTMLElement): void;
  /** Render an error line at the end of the turn. */
  appendError(message: string): void;
  /** Close the current turn (no more content will be appended). */
  endTurn(): void;
  /** Wipe the entire view (used by `/new`). */
  clear(): void;
}

export class AgentView implements AgentViewApi {
  private readonly root: HTMLElement;
  private readonly scrollHost: HTMLElement;

  private currentTurn: HTMLElement | null = null;
  /** `<section class="agent-turn-prose">` for the active turn. */
  private currentProseSection: HTMLElement | null = null;
  /** Raw Markdown buffer for the active prose section. Re-rendered on
   *  each appendProse so mid-stream structure stays correct. */
  private currentProseMarkdown = "";
  /** Tool-log container for the active turn (lazy-created). */
  private currentToolLog: HTMLElement | null = null;
  /** Review body for the active turn (lazy-created). */
  private currentReview: HTMLElement | null = null;
  private currentReviewMarkdown = "";

  constructor(host: HTMLElement) {
    this.root = host;
    this.scrollHost = document.createElement("div");
    this.scrollHost.className = "agent-stage-scroll";
    this.root.appendChild(this.scrollHost);
  }

  beginTurn(userPrompt: string): void {
    const pinned = this.isPinnedToBottom();
    const turn = document.createElement("article");
    turn.className = "agent-turn";

    if (userPrompt.trim().length > 0) {
      const userBlock = document.createElement("div");
      userBlock.className = "agent-turn-user";
      userBlock.textContent = userPrompt;
      turn.appendChild(userBlock);
    }

    this.scrollHost.appendChild(turn);
    this.currentTurn = turn;
    this.currentProseSection = null;
    this.currentProseMarkdown = "";
    this.currentToolLog = null;
    this.currentReview = null;
    this.currentReviewMarkdown = "";
    if (pinned || userPrompt.trim().length > 0) {
      // Force pinning to bottom on a new user turn
      this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
    }
  }

  appendProse(piece: string): void {
    if (piece.length === 0) return;
    const pinned = this.isPinnedToBottom();
    if (!this.currentTurn) this.beginTurn("");
    if (!this.currentProseSection) {
      const section = document.createElement("section");
      section.className = "agent-turn-prose markdown-body";
      this.currentTurn!.appendChild(section);
      this.currentProseSection = section;
    }
    this.currentProseMarkdown += piece;
    const frag = markdownToFragment(this.currentProseMarkdown);
    this.currentProseSection.replaceChildren(frag);
    if (pinned) this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
  }

  appendToolCall(info: ToolCallInfo): void {
    const pinned = this.isPinnedToBottom();
    if (!this.currentTurn) this.beginTurn("");
    if (!this.currentToolLog) {
      const log = document.createElement("section");
      log.className = "agent-turn-toolog";
      // Keep tool log above any in-progress prose section so the
      // turn reads as "tool work, then answer".
      const proseSection = this.currentProseSection;
      if (proseSection && proseSection.parentNode === this.currentTurn) {
        this.currentTurn!.insertBefore(log, proseSection);
      } else {
        this.currentTurn!.appendChild(log);
      }
      this.currentToolLog = log;
    }

    const card = document.createElement("div");
    card.className = `agent-tool-card status-${info.status}`;

    const head = document.createElement("div");
    head.className = "agent-tool-card-head";
    const glyph = document.createElement("span");
    glyph.className = "agent-tool-card-glyph";
    glyph.textContent = info.status === "ok" ? "✓" : "✗";
    head.appendChild(glyph);
    const name = document.createElement("span");
    name.className = "agent-tool-card-name";
    name.textContent = info.name;
    head.appendChild(name);
    if (info.argsPretty) {
      const args = document.createElement("span");
      args.className = "agent-tool-card-args";
      args.textContent = info.argsPretty;
      head.appendChild(args);
    }
    card.appendChild(head);

    if (info.summary) {
      const summary = document.createElement("div");
      summary.className = "agent-tool-card-summary";
      summary.textContent = info.summary;
      card.appendChild(summary);
    }

    this.currentToolLog.appendChild(card);

    // After a tool call, drop the prose pointer so the next prose
    // chunk opens a fresh section underneath the new tool card.
    this.currentProseSection = null;
    this.currentProseMarkdown = "";

    if (pinned) this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
  }

  appendReview(piece: string): void {
    if (piece.length === 0) return;
    const pinned = this.isPinnedToBottom();
    if (!this.currentTurn) this.beginTurn("");
    if (!this.currentReview) {
      const review = document.createElement("section");
      review.className = "agent-turn-review markdown-body";
      const header = document.createElement("div");
      header.className = "agent-turn-review-header";
      header.textContent = "review";
      review.appendChild(header);
      const body = document.createElement("div");
      body.className = "agent-turn-review-body";
      review.appendChild(body);
      this.currentTurn!.appendChild(review);
      this.currentReview = body;
    }
    this.currentReviewMarkdown += piece;
    const frag = markdownToFragment(this.currentReviewMarkdown);
    this.currentReview.replaceChildren(frag);
    if (pinned) this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
  }

  appendNotice(kind: NoticeKind, body: string): void {
    const pinned = this.isPinnedToBottom();
    if (!this.currentTurn) this.beginTurn("");
    const el = document.createElement("div");
    el.className = `agent-notice agent-notice-${kind}`;
    el.textContent = stripAnsi(body);
    this.currentTurn!.appendChild(el);
    if (pinned) this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
  }

  appendReport(markdown: string): void {
    if (markdown.length === 0) return;
    const pinned = this.isPinnedToBottom();
    if (!this.currentTurn) this.beginTurn("");
    const section = document.createElement("section");
    section.className = "agent-report markdown-body";
    section.appendChild(markdownToFragment(markdown));
    this.currentTurn!.appendChild(section);
    // After a one-shot report, reset the streaming-prose pointer so a
    // subsequent agent turn (which DOES use appendProse) opens a fresh
    // section underneath instead of appending into our DOM block.
    this.currentProseSection = null;
    this.currentProseMarkdown = "";
    if (pinned) this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
  }

  /**
   * Mount an arbitrary DOM element into the current turn. Used by the
   * recipe-runner ProtocolReportCard so the card can self-manage its
   * lifecycle (planning → running → done) without AgentView needing to
   * know about it. Resets the streaming-prose pointer for the same
   * reason `appendReport` does.
   */
  appendCard(card: HTMLElement): void {
    const pinned = this.isPinnedToBottom();
    if (!this.currentTurn) this.beginTurn("");
    this.currentTurn!.appendChild(card);
    this.currentProseSection = null;
    this.currentProseMarkdown = "";
    if (pinned) this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
  }

  appendError(message: string): void {
    const pinned = this.isPinnedToBottom();
    if (!this.currentTurn) this.beginTurn("");
    const el = document.createElement("div");
    el.className = "agent-error";
    el.textContent = stripAnsi(message);
    this.currentTurn!.appendChild(el);
    if (pinned) this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
  }

  endTurn(): void {
    this.currentTurn = null;
    this.currentProseSection = null;
    this.currentProseMarkdown = "";
    this.currentToolLog = null;
    this.currentReview = null;
    this.currentReviewMarkdown = "";
  }

  clear(): void {
    this.scrollHost.innerHTML = "";
    this.endTurn();
  }

  private isPinnedToBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.scrollHost;
    // Extremely forgiving margin to account for padding & rounding
    return scrollHeight - (scrollTop + clientHeight) < 48;
  }
}
