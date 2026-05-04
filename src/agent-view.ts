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
  /** Render an inline diff card for a specific file change. */
  appendDiff(path: string, diff: string): void;
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

export interface AgentViewCallbacks {
  /** Triggered when a modified file chip is clicked. */
  onFileClick: (path: string, lineNumber?: number) => void;
}

export class AgentView implements AgentViewApi {
  private readonly root: HTMLElement;
  private readonly scrollHost: HTMLElement;
  private readonly cb?: AgentViewCallbacks;
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

  constructor(host: HTMLElement, cb?: AgentViewCallbacks) {
    this.root = host;
    this.cb = cb;
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
      if (this.cb) {
        chip.style.cursor = "pointer";
        chip.onclick = () => this.cb!.onFileClick(w.path);
      }

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

  appendDiff(path: string, diff: string): void {
    if (!this.currentTurn) this.beginTurn("");

    const container = document.createElement("div");
    container.className = "agent-diff-card agent-diff-card-collapsed";

    // Extract basename and stats
    const parts = path.split(/[\/\\]/);
    const name = parts[parts.length - 1] || path;
    const hunks = parseUnifiedDiff(diff);
    
    let added = 0;
    let removed = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.type === "added") added++;
        if (line.type === "removed") removed++;
      }
    }

    // Header (Glassmorphism + Stats)
    const header = document.createElement("div");
    header.className = "agent-diff-header";
    header.title = "Click to show full diff or back to preview";

    const chevronEl = document.createElement("span");
    chevronEl.className = "agent-diff-chevron";
    chevronEl.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    header.appendChild(chevronEl);

    const iconEl = document.createElement("span");
    iconEl.className = "agent-diff-icon";
    iconEl.innerHTML = getFileIcon(name);
    header.appendChild(iconEl);

    const nameEl = document.createElement("span");
    nameEl.className = "agent-diff-name";
    nameEl.textContent = name;
    nameEl.title = path;
    if (this.cb) {
      nameEl.style.cursor = "pointer";
      nameEl.onclick = (e) => {
        e.stopPropagation();
        this.cb!.onFileClick(path);
      };
    }
    header.appendChild(nameEl);

    const revealBtn = document.createElement("span");
    revealBtn.className = "agent-diff-reveal";
    revealBtn.title = "Reveal in explorer";
    revealBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    if (this.cb) {
      revealBtn.onclick = (e) => {
        e.stopPropagation();
        this.cb!.onFileClick(path);
      };
    }
    header.appendChild(revealBtn);

    const statsEl = document.createElement("div");
    statsEl.className = "agent-diff-stats";
    if (added > 0) statsEl.innerHTML += `<span class="agent-diff-added">+${added}</span>`;
    if (removed > 0) statsEl.innerHTML += `<span class="agent-diff-removed">-${removed}</span>`;
    header.appendChild(statsEl);

    const expandHint = document.createElement("span");
    expandHint.className = "agent-diff-expand-hint";
    expandHint.textContent = "preview";
    header.appendChild(expandHint);

    container.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "agent-diff-body";

    const lang = name.split(".").pop() || "";

    for (const hunk of hunks) {
      const hunkHeader = document.createElement("div");
      hunkHeader.className = "agent-diff-hunk-header";
      hunkHeader.textContent = hunk.header;
      if (this.cb) {
        hunkHeader.style.cursor = "pointer";
        hunkHeader.onclick = (ev) => {
          ev.stopPropagation();
          this.cb!.onFileClick(path, hunk.newStart);
        };
      }
      body.appendChild(hunkHeader);

      const hunkContent = document.createElement("div");
      hunkContent.className = "agent-diff-hunk-content";

      for (const line of hunk.lines) {
        const lineEl = document.createElement("div");
        lineEl.className = `agent-diff-line agent-diff-line-${line.type}`;
        
        const gutter = document.createElement("div");
        gutter.className = "agent-diff-gutter";
        
        const oldNo = document.createElement("span");
        oldNo.className = "agent-diff-ln agent-diff-ln-old";
        oldNo.textContent = line.oldLine !== null ? String(line.oldLine) : "";
        
        const newNo = document.createElement("span");
        newNo.className = "agent-diff-ln agent-diff-ln-new";
        newNo.textContent = line.newLine !== null ? String(line.newLine) : "";
        
        gutter.appendChild(oldNo);
        gutter.appendChild(newNo);
        lineEl.appendChild(gutter);

        const content = document.createElement("div");
        content.className = "agent-diff-content";
        
        const prefix = document.createElement("span");
        prefix.className = "agent-diff-prefix";
        prefix.textContent = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
        content.appendChild(prefix);

        const code = document.createElement("code");
        code.className = "agent-diff-code";
        // Simple syntax highlighting
        code.innerHTML = highlightCode(line.content, lang);
        content.appendChild(code);
        
        lineEl.appendChild(content);

        if (this.cb && line.newLine !== null) {
          lineEl.style.cursor = "pointer";
          lineEl.onclick = (ev) => {
            ev.stopPropagation();
            this.cb!.onFileClick(path, line.newLine!);
          };
        }

        hunkContent.appendChild(lineEl);
      }
      body.appendChild(hunkContent);
    }

    container.appendChild(body);
    this.currentTurn!.appendChild(container);

    /** ~6 code rows + hunk header — matches CSS `max-height` on collapsed body. */
    const syncDiffPreviewOverflow = (): void => {
      if (!container.classList.contains("agent-diff-card-collapsed")) {
        expandHint.style.display = "none";
        return;
      }
      expandHint.style.display = "";
      const clipped = body.scrollHeight > body.clientHeight + 2;
      container.classList.toggle("agent-diff-preview-overflow", clipped);
      expandHint.textContent = clipped ? "preview · more below" : "preview";
    };

    requestAnimationFrame(() => {
      syncDiffPreviewOverflow();
      const ro = new ResizeObserver(() => syncDiffPreviewOverflow());
      ro.observe(body);
    });

    header.addEventListener("click", (e) => {
      if (
        (e.target as HTMLElement).closest(".agent-diff-reveal") ||
        (e.target as HTMLElement).closest(".agent-diff-name")
      ) {
        return;
      }
      container.classList.toggle("agent-diff-card-collapsed");
      queueMicrotask(() => syncDiffPreviewOverflow());
    });

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

// ---------------------------------------------------------------------------
// Diff Parsing & Highlighting (V2)
// ---------------------------------------------------------------------------

interface DiffLine {
  type: "added" | "removed" | "context";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/**
 * Robust unified diff parser. Handles multiple hunks and preserves context.
 * Falls back to Prism's edit approval preview (`--- old` / `+++ new` from
 * `tools::preview_write`), which has no `@@` headers — see `parsePrismEditPreview`.
 */
function parseUnifiedDiff(diff: string): DiffHunk[] {
  const normalized = diff.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;

    const hunkMatch = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)/.exec(line);
    if (hunkMatch) {
      currentHunk = {
        header: line.trim(),
        oldStart: parseInt(hunkMatch[1], 10),
        newStart: parseInt(hunkMatch[3], 10),
        lines: [],
      };
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "added",
        content: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "removed",
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
    } else {
      // Context line (starts with space or is empty)
      const content = line.startsWith(" ") ? line.slice(1) : line;
      currentHunk.lines.push({
        type: "context",
        content,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  if (hunks.length > 0) return hunks;
  return parsePrismEditPreview(normalized);
}

/**
 * Parse Rust `preview_write` output for `edit_file`:
 *   ... --- old\n<old_string>\n+++ new\n<new_string>
 * There are no `@@` hunk lines; the unified-diff branch yields zero hunks without this.
 */
function parsePrismEditPreview(s: string): DiffHunk[] {
  const oldMarker = "--- old\n";
  const i = s.indexOf(oldMarker);
  if (i < 0) return [];

  const from = i + oldMarker.length;
  let j = s.indexOf("\n+++ new\n", from);
  let sepLen = "\n+++ new\n".length;
  if (j < 0) {
    j = s.indexOf("+++ new\n", from);
    if (j < 0) return [];
    sepLen = "+++ new\n".length;
  }

  const oldText = s.slice(from, j);
  const newText = s.slice(j + sepLen);

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const lines: DiffLine[] = [];
  let o = 1;
  let n = 1;
  for (const content of oldLines) {
    lines.push({
      type: "removed",
      content,
      oldLine: o++,
      newLine: null,
    });
  }
  for (const content of newLines) {
    lines.push({
      type: "added",
      content,
      oldLine: null,
      newLine: n++,
    });
  }

  if (lines.length === 0) return [];

  return [
    {
      header: "@@ edit preview (old → new) @@",
      oldStart: 1,
      newStart: 1,
      lines,
    },
  ];
}

/** HTML-escape a slice of already-escaped source (identity on safe text). */
function escapeForSpan(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface HighlightRegion {
  start: number;
  end: number;
  cls: "cm-comment" | "cm-string";
}

function rangesOverlap(s1: number, e1: number, s2: number, e2: number): boolean {
  return s1 < e2 && s2 < e1;
}

function mergeSortedRegions(regions: HighlightRegion[]): HighlightRegion[] {
  const sorted = [...regions].sort((x, y) => x.start - y.start);
  const out: HighlightRegion[] = [];
  for (const r of sorted) {
    if (out.length === 0) {
      out.push(r);
      continue;
    }
    const last = out[out.length - 1]!;
    if (r.start >= last.end) {
      out.push(r);
    } else {
      last.end = Math.max(last.end, r.end);
    }
  }
  return out;
}

/** True if [pos, end) overlaps any merged comment region (strings inside // or block comments are skipped). */
function overlapsCommentRegions(pos: number, end: number, comments: HighlightRegion[]): boolean {
  for (const r of comments) {
    if (rangesOverlap(pos, end, r.start, r.end)) return true;
  }
  return false;
}

const KEYWORD_LIST = [
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "let", "static",
  "pub", "fn", "use", "mod", "type", "impl", "trait", "where", "async", "struct",
  "match", "mut", "self", "Self", "crate", "ref",
];

/**
 * Keyword / number / type highlighting on a gap of **escaped source text only**
 * (never on HTML we already emitted — avoids matching `class` inside `<span …>`).
 */
function highlightCodeGap(gap: string): string {
  let h = gap;
  h = h.replace(
    new RegExp(`\\b(${KEYWORD_LIST.join("|")})\\b`, "g"),
    (m) => `<span class="cm-keyword">${m}</span>`,
  );
  h = h.replace(/\b\d+\b/g, (m) => `<span class="cm-number">${m}</span>`);
  h = h.replace(
    /\b[A-Z][a-zA-Z0-9_]*\b/g,
    (m) => `<span class="cm-type">${m}</span>`,
  );
  return h;
}

/**
 * Lightweight syntax highlighter for diff lines. Comments/strings are resolved on
 * the raw escaped source first; keywords run only in gaps — so we never apply
 * keyword regex to `<span class="cm-string">` attributes (that caused leaked
 * `class="cm-…"` junk in the UI).
 */
function highlightCode(code: string, _lang: string): string {
  if (!code) return "&nbsp;";

  const escaped = escapeForSpan(code);

  if (escaped.length > 500) return escaped;

  const commentParts: HighlightRegion[] = [];

  for (const m of escaped.matchAll(/\/\/.*$/gm)) {
    commentParts.push({
      start: m.index!,
      end: m.index! + m[0].length,
      cls: "cm-comment",
    });
  }
  for (const m of escaped.matchAll(/\/\*[\s\S]*?\*\//g)) {
    commentParts.push({
      start: m.index!,
      end: m.index! + m[0].length,
      cls: "cm-comment",
    });
  }

  const comments = mergeSortedRegions(commentParts);

  const allRegions: HighlightRegion[] = [...comments];

  const strRe = /(["'])(?:(?=(\\?))\2.)*?\1/g;
  for (const m of escaped.matchAll(strRe)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (overlapsCommentRegions(start, end, comments)) continue;
    allRegions.push({ start, end, cls: "cm-string" });
  }

  const merged = mergeSortedRegions(allRegions);

  let out = "";
  let pos = 0;
  for (const r of merged) {
    if (pos < r.start) {
      out += highlightCodeGap(escaped.slice(pos, r.start));
    }
    const slice = escaped.slice(r.start, r.end);
    out += `<span class="${r.cls}">${slice}</span>`;
    pos = r.end;
  }
  if (pos < escaped.length) {
    out += highlightCodeGap(escaped.slice(pos));
  }

  return out || "&nbsp;";
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
