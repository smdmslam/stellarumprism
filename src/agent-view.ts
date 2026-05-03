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
import type { WriteEntry } from "./turn-summary";

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
  let clean = stripAnsi(markdown);

  // 1. Force double-newline before rigor markers (Observed, Inferred, Unverified)
  // if they are currently preceded by only a single newline. This ensures
  // marked renders them as a fresh paragraph with proper vertical spacing.
  clean = clean.replace(
    /(?<!\n)\n([✓~?∼]\s+(?:Observed|Inferred|Unverified))/g,
    "\n\n$1"
  );
  clean = clean.replace(/(?<!\n)\n(Verified total:)/g, "\n\n$1");

  // 2. Wrap markers in a styling span. We do this before passing to marked
  // so it's treated as inline HTML.
  clean = clean.replace(
    /([✓~?∼]\s+(?:Observed|Inferred|Unverified))/g,
    '<span class="agent-rigor-label">$1</span>'
  );
  clean = clean.replace(
    /(Verified total:)/g,
    '<span class="agent-rigor-label">$1</span>'
  );

  const html = marked.parse(clean, { async: false }) as string;
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
  /** Render a list of modified files as interactive chips. */
  appendFilesModified(writes: WriteEntry[]): void;
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
  /** True while streaming should keep the latest output in view. */
  private followStream = true;

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
    this.scrollHost.addEventListener("scroll", () => {
      // If the user scrolls up, stop forcing autoscroll until they come
      // back near the bottom.
      this.followStream = this.isPinnedToBottom();
    });
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
    this.followStream = pinned || userPrompt.trim().length > 0;
    this.scrollToBottomIfFollowing();
  }

  appendProse(piece: string): void {
    if (piece.length === 0) return;
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
    this.scrollToBottomIfFollowing();
  }

  appendToolCall(info: ToolCallInfo): void {
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
    name.textContent = stripAnsi(info.name);
    head.appendChild(name);
    if (info.argsPretty) {
      const args = document.createElement("span");
      args.className = "agent-tool-card-args";
      args.textContent = stripAnsi(info.argsPretty);
      head.appendChild(args);
    }
    card.appendChild(head);

    if (info.summary) {
      const summary = document.createElement("div");
      summary.className = "agent-tool-card-summary";
      summary.textContent = stripAnsi(info.summary);
      card.appendChild(summary);
    }

    this.currentToolLog.appendChild(card);

    // After a tool call, drop the prose pointer so the next prose
    // chunk opens a fresh section underneath the new tool card.
    this.currentProseSection = null;
    this.currentProseMarkdown = "";

    this.scrollToBottomIfFollowing();
  }

  appendReview(piece: string): void {
    if (piece.length === 0) return;
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
    this.scrollToBottomIfFollowing();
  }
 
  appendFilesModified(writes: WriteEntry[]): void {
    if (writes.length === 0) return;
    if (!this.currentTurn) this.beginTurn("");
 
    // Deduplicate by path.
    const unique = new Map<string, WriteEntry>();
    for (const w of writes) unique.set(w.path, w);
    const sorted = Array.from(unique.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    );

    const container = document.createElement("div");
    container.className = "agent-notice agent-notice-files-modified";

    const heading = document.createElement("div");
    heading.className = "files-modified-heading";
    heading.innerHTML = `Files Modified <span class="files-modified-count">${sorted.length}</span>`;
    container.appendChild(heading);

    const chips = document.createElement("div");
    chips.className = "files-modified-chips";

    for (const w of sorted) {
      const chip = document.createElement("div");
      chip.className = "file-chip" + (w.ok ? "" : " file-chip-failed");

      // Extract basename for display; keep full path in title.
      const parts = w.path.split(/[\/\\]/);
      const name = parts[parts.length - 1] || w.path;
      chip.title = w.path;

      const iconEl = document.createElement("span");
      iconEl.className = "file-chip-icon";
      iconEl.innerHTML = getFileIcon(name);
      chip.appendChild(iconEl);

      const nameEl = document.createElement("span");
      nameEl.className = "file-chip-name";
      nameEl.textContent = name;
      chip.appendChild(nameEl);

      if (w.stats && (w.stats.added > 0 || w.stats.removed > 0)) {
        const statsEl = document.createElement("span");
        statsEl.className = "file-chip-stats";
        if (w.stats.added > 0) {
          statsEl.innerHTML += `<span class="file-chip-added">+${w.stats.added}</span>`;
        }
        if (w.stats.removed > 0) {
          statsEl.innerHTML += `<span class="file-chip-removed">-${w.stats.removed}</span>`;
        }
        chip.appendChild(statsEl);
      }

      chips.appendChild(chip);
    }

    container.appendChild(chips);
    this.currentTurn!.appendChild(container);
    this.scrollToBottomIfFollowing();
  }

  appendNotice(kind: NoticeKind, body: string): void {
    if (!this.currentTurn) this.beginTurn("");
    // If the notice is a legacy files-modified string, we ignore it and
    // wait for the explicit appendFilesModified call.
    if (kind === "files-modified") return;

    const el = document.createElement("div");
    el.className = `agent-notice agent-notice-${kind}`;
    el.textContent = stripAnsi(body);
    this.currentTurn!.appendChild(el);
    this.scrollToBottomIfFollowing();
  }

  appendReport(markdown: string): void {
    if (markdown.length === 0) return;
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
    this.scrollToBottomIfFollowing();
  }

  /**
   * Mount an arbitrary DOM element into the current turn. Used by the
   * recipe-runner ProtocolReportCard so the card can self-manage its
   * lifecycle (planning → running → done) without AgentView needing to
   * know about it. Resets the streaming-prose pointer for the same
   * reason `appendReport` does.
   */
  appendCard(card: HTMLElement): void {
    if (!this.currentTurn) this.beginTurn("");
    this.currentTurn!.appendChild(card);
    this.currentProseSection = null;
    this.currentProseMarkdown = "";
    this.scrollToBottomIfFollowing();
  }

  appendError(message: string): void {
    if (!this.currentTurn) this.beginTurn("");
    const el = document.createElement("div");
    el.className = "agent-error";
    el.textContent = stripAnsi(message);
    this.currentTurn!.appendChild(el);
    this.scrollToBottomIfFollowing();
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
    this.followStream = true;
    this.endTurn();
  }

  private scrollToBottomIfFollowing(): void {
    if (!this.followStream) return;
    this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
  }

  private isPinnedToBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.scrollHost;
    // Reduced margin from 48px to 10px. 48px was too aggressive and would
    // "fight" the user if they tried to scroll up just a few lines while
    // the agent was streaming. 10px handles sub-pixel rounding while
    // yielding to the user's intent to scroll back.
    return Math.ceil(scrollTop + clientHeight) >= scrollHeight - 10;
  }
}

/**
 * Return a small SVG icon string based on filename extension.
 * Defaults to a generic file icon if extension is unknown.
 */
function getFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const color = (c: string) => `stroke="${c}"`;

  // Standard Lucide-style file icon as fallback.
  const fallback = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  switch (ext) {
    case "rs":
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ${color("#f97316")} stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;
    case "ts":
    case "tsx":
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ${color("#3b82f6")} stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`;
    case "js":
    case "jsx":
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ${color("#facc15")} stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>`;
    case "md":
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ${color("#94a3b8")} stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    case "css":
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ${color("#3b82f6")} stroke-width="2"><path d="M20 21l-2-16-10-3-8 3 2 16 8 2 8-2z"/><path d="M8 11h8M8 15h5"/></svg>`;
    case "json":
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ${color("#facc15")} stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>`;
    case "html":
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ${color("#ea580c")} stroke-width="2"><path d="m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16"/></svg>`;
    default:
      return fallback;
  }
}
