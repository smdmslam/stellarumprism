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
import { openUrl } from "@tauri-apps/plugin-opener";
import type { WriteEntry } from "./turn-summary";
import { AgentFind } from "./agent-find";

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

/** http(s) / mailto links in the agent pane must not navigate the Tauri
 *  webview (that replaces the whole app with no back affordance). */
function openExternalHref(href: string): void {
  const h = href.trim();
  const isWeb = h.startsWith("https://") || h.startsWith("http://");
  const isMail = h.toLowerCase().startsWith("mailto:");
  if (!isWeb && !isMail) return;
  void openUrl(h).catch(() => {
    try {
      window.open(h, "_blank", "noopener,noreferrer");
    } catch {
      /* ignore */
    }
  });
}

/** Match http(s) URLs in plain text (code fences, etc.). */
const HTTP_URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Normalize a URL substring for `href`; return null if not http(s). */
function normalizeUrlForHref(raw: string): string | null {
  const u = raw.replace(/[),.;:!?\]]+$/g, "").trim();
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Split text into nodes, wrapping recognized http(s) URLs in `<a>`. */
function fragmentForTextWithUrls(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  HTTP_URL_IN_TEXT_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = HTTP_URL_IN_TEXT_RE.exec(text)) !== null) {
    if (m.index > last) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const raw = m[0];
    const href = normalizeUrlForHref(raw);
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.className = "markdown-code-url-link";
      a.rel = "noopener noreferrer";
      a.textContent = raw;
      frag.appendChild(a);
    } else {
      frag.appendChild(document.createTextNode(raw));
    }
    last = HTTP_URL_IN_TEXT_RE.lastIndex;
  }
  if (last < text.length) {
    frag.appendChild(document.createTextNode(text.slice(last)));
  }
  return frag;
}

/**
 * Models often paste URLs inside fenced ``` blocks or inline `code`, so
 * marked renders them as plain text (not `<a>`). Turn those into real
 * links so they open externally like normal markdown links.
 */
function linkifyHttpUrlsInCodeElements(root: ParentNode): void {
  const codes = Array.from(root.querySelectorAll("code"));
  for (const node of codes) {
    if (!(node instanceof HTMLElement)) continue;
    const code = node;
    if (code.closest("a.markdown-code-url-link")) continue;
    if (code.getElementsByTagName("*").length > 0) continue;

    const text = code.textContent ?? "";
    if (!/https?:\/\//i.test(text)) continue;

    const inPre = code.parentElement?.tagName === "PRE";
    if (inPre) {
      code.replaceChildren(fragmentForTextWithUrls(text));
      continue;
    }

    const trimmed = text.trim();
    if (trimmed.includes("\n")) continue;
    if (!/^https?:\/\/\S+$/i.test(trimmed)) continue;
    const href = normalizeUrlForHref(trimmed);
    if (!href) continue;

    const a = document.createElement("a");
    a.href = href;
    a.className = "markdown-code-url-link markdown-code-url-link--inline";
    a.rel = "noopener noreferrer";
    const inner = document.createElement("code");
    inner.textContent = trimmed;
    a.appendChild(inner);
    code.replaceWith(a);
  }
}

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
  linkifyHttpUrlsInCodeElements(frag);
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
  | "write-timeline" // ordered per-turn write attempt log
  | "turn-footer" // "done in Ns · N tools · model"
  | "grounded-warning"; // grounded-chat rigor caution

export interface ToolCallInfo {
  name: string;
  argsPretty: string;
  status: "ok" | "fail";
  summary: string;
}

export interface AgentDiffInfo {
  path: string;
  diff: string;
  source: "approval-preview" | "tool-artifact";
  operation?: "create" | "overwrite" | "edit" | "delete" | "move" | "mkdir";
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
  /** Render an ordered per-turn log of write attempts. */
  appendWriteTimeline(writes: WriteEntry[]): void;
  /** Render an inline diff card for a specific file change. */
  appendDiff(info: AgentDiffInfo): void;
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
  /** Reveal the file in the sidebar tree (expand parents + select). */
  onRevealInTree?: (path: string) => void;
  /** Reveal the file in the OS file explorer (Finder / Explorer) and select it. */
  onRevealInExplorer?: (path: string) => void;
}

export class AgentView implements AgentViewApi {
  private readonly root: HTMLElement;
  private readonly scrollHost: HTMLElement;
  private readonly cb?: AgentViewCallbacks;
  /** True while streaming should keep the latest output in view. */
  private followStream = true;
  private readonly find: AgentFind;

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
    this.find = new AgentFind(this.root, this.scrollHost);

    // Capture phase so we win over the webview's default in-window navigation.
    this.root.addEventListener(
      "click",
      (e: MouseEvent) => {
        const t = e.target;
        if (!(t instanceof Node)) return;
        const a = (t as HTMLElement).closest("a[href]");
        if (!(a instanceof HTMLAnchorElement)) return;
        const href = a.getAttribute("href");
        if (!href) return;
        const trimmed = href.trim();
        if (
          !trimmed.startsWith("http://") &&
          !trimmed.startsWith("https://") &&
          !trimmed.toLowerCase().startsWith("mailto:")
        ) {
          return;
        }
        e.preventDefault();
        openExternalHref(trimmed);
      },
      true,
    );
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

    // Task 2.5: Render a slim, non-intrusive inline chip for read_skill
    if (info.name === "read_skill") {
      const chip = document.createElement("div");
      chip.className = "file-chip" + (info.status === "ok" ? "" : " file-chip-failed");
      chip.style.margin = "2px 0";
      chip.style.width = "fit-content";
      
      const icon = document.createElement("span");
      icon.className = "file-chip-icon";
      icon.style.color = "#c084fc"; // purple for skills
      icon.textContent = "✦";
      chip.appendChild(icon);
      
      const nameEl = document.createElement("span");
      nameEl.className = "file-chip-name";
      nameEl.style.color = "#d8b4fe";
      
      let skillName = info.argsPretty || "unknown";
      try {
        const parsed = JSON.parse(skillName);
        if (parsed.slug) skillName = parsed.slug;
      } catch {
        // Fall back to raw args
      }
      nameEl.textContent = `skill engaged: ${stripAnsi(skillName)}`;
      chip.appendChild(nameEl);
      
      this.currentToolLog.appendChild(chip);
      
      // Reset prose pointer so next text chunk drops below
      this.currentProseSection = null;
      this.currentProseMarkdown = "";
      this.scrollToBottomIfFollowing();
      return;
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

      if (w.operation === "overwrite") {
        const overwriteEl = document.createElement("span");
        overwriteEl.className = "file-chip-overwrite";
        overwriteEl.textContent = "overwrite";
        chip.appendChild(overwriteEl);
      } else if (w.stats && ((w.stats.added ?? 0) > 0 || (w.stats.removed ?? 0) > 0)) {
        const statsEl = document.createElement("span");
        statsEl.className = "file-chip-stats";
        if ((w.stats.added ?? 0) > 0) {
          statsEl.innerHTML += `<span class="file-chip-added">+${w.stats.added}</span>`;
        }
        if ((w.stats.removed ?? 0) > 0) {
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

  appendWriteTimeline(writes: WriteEntry[]): void {
    if (writes.length === 0) return;
    if (!this.currentTurn) this.beginTurn("");

    const container = document.createElement("div");
    container.className = "agent-notice agent-notice-write-timeline";

    const heading = document.createElement("div");
    heading.className = "files-modified-heading";
    heading.innerHTML = `Write Timeline <span class="files-modified-count">${writes.length}</span>`;
    container.appendChild(heading);

    const list = document.createElement("div");
    list.className = "write-timeline-list";

    for (const w of writes) {
      const row = document.createElement("div");
      row.className = "write-timeline-row" + (w.ok ? "" : " write-timeline-row-failed");

      const status = document.createElement("span");
      status.className = "write-timeline-status";
      status.textContent = w.ok ? "✓" : "✗";
      row.appendChild(status);

      const text = document.createElement("span");
      text.className = "write-timeline-text";
      const op = w.operation ? ` — ${w.operation}` : "";
      const summary = w.summary ? `: ${stripAnsi(w.summary)}` : "";
      text.textContent = `${w.tool} ${w.path}${op}${summary}`;
      row.appendChild(text);

      list.appendChild(row);
    }

    container.appendChild(list);
    this.currentTurn!.appendChild(container);
    this.scrollToBottomIfFollowing();
  }

  appendDiff(info: AgentDiffInfo): void {
    if (!this.currentTurn) this.beginTurn("");

    const { path, diff, source, operation } = info;
    const isPreviewOnly = source === "approval-preview";
    const isOverwritePreview = isPreviewOnly && operation === "overwrite";

    const container = document.createElement("div");
    container.className = "agent-diff-card agent-diff-card-collapsed";
    if (isOverwritePreview) container.classList.add("agent-diff-card-preview-warning");

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
        if (this.cb!.onRevealInExplorer) this.cb!.onRevealInExplorer(path);
        else if (this.cb!.onRevealInTree) this.cb!.onRevealInTree(path);
        else this.cb!.onFileClick(path);
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
    if (source === "tool-artifact" && operation === "overwrite") {
      expandHint.textContent = "overwrite · actual diff";
    } else if (isOverwritePreview) {
      expandHint.textContent = "⚠ preview only";
    } else if (isPreviewOnly && operation === "create") {
      expandHint.textContent = "created · preview";
    } else if (isPreviewOnly && operation === "edit") {
      expandHint.textContent = "edited · preview";
    } else if (isPreviewOnly && operation) {
      expandHint.textContent = `${operation === "mkdir" ? "mkdir" : operation + "d"} · preview`;
    } else if (source === "tool-artifact") {
      expandHint.textContent = "actual diff";
    } else {
      expandHint.textContent = "preview";
    }
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

      // Partition lines to pair additions/removals and fold long context blocks
      const lineItems = buildRenderedLineItems(hunk.lines);

      const createLineEl = (type: "added" | "removed" | "context", oldLine: number | null, newLine: number | null, contentHtml: string): HTMLDivElement => {
        const lineEl = document.createElement("div");
        lineEl.className = `agent-diff-line agent-diff-line-${type}`;
        
        const gutter = document.createElement("div");
        gutter.className = "agent-diff-gutter";
        
        const oldNo = document.createElement("span");
        oldNo.className = "agent-diff-ln agent-diff-ln-old";
        oldNo.textContent = oldLine !== null ? String(oldLine) : "";
        
        const newNo = document.createElement("span");
        newNo.className = "agent-diff-ln agent-diff-ln-new";
        newNo.textContent = newLine !== null ? String(newLine) : "";
        
        gutter.appendChild(oldNo);
        gutter.appendChild(newNo);
        lineEl.appendChild(gutter);

        const contentDiv = document.createElement("div");
        contentDiv.className = "agent-diff-content";
        
        const prefix = document.createElement("span");
        prefix.className = "agent-diff-prefix";
        prefix.textContent = type === "added" ? "+" : type === "removed" ? "-" : " ";
        contentDiv.appendChild(prefix);

        const code = document.createElement("code");
        code.className = "agent-diff-code";
        code.innerHTML = contentHtml;
        contentDiv.appendChild(code);
        
        lineEl.appendChild(contentDiv);

        const targetLine = newLine !== null ? newLine : (oldLine !== null ? oldLine : null);
        if (this.cb && targetLine !== null) {
          lineEl.style.cursor = "pointer";
          lineEl.onclick = (ev) => {
            ev.stopPropagation();
            this.cb!.onFileClick(path, targetLine);
          };
        }
        return lineEl;
      };

      for (const item of lineItems) {
        if (item.type === "single") {
          const line = item.line;
          const contentHtml = highlightCode(line.content, lang);
          hunkContent.appendChild(createLineEl(line.type, line.oldLine, line.newLine, contentHtml));
        } else if (item.type === "paired") {
          const rem = item.removed;
          const add = item.added;
          const diffResult = diffWords(rem.content, add.content);

          hunkContent.appendChild(createLineEl("removed", rem.oldLine, rem.newLine, diffResult.oldHtml));
          hunkContent.appendChild(createLineEl("added", add.oldLine, add.newLine, diffResult.newHtml));
        } else if (item.type === "fold") {
          const foldRow = document.createElement("div");
          foldRow.className = "agent-diff-fold-row";
          
          const iconSpan = document.createElement("span");
          iconSpan.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
          foldRow.appendChild(iconSpan);

          const textSpan = document.createElement("span");
          textSpan.textContent = `+${item.lines.length} unchanged lines (click to expand)`;
          foldRow.appendChild(textSpan);

          const foldContent = document.createElement("div");
          foldContent.className = "agent-diff-fold-content";
          foldContent.style.display = "none";

          for (const line of item.lines) {
            const contentHtml = highlightCode(line.content, lang);
            foldContent.appendChild(createLineEl(line.type, line.oldLine, line.newLine, contentHtml));
          }

          foldRow.onclick = (ev) => {
            ev.stopPropagation();
            if (foldContent.style.display === "none") {
              foldContent.style.display = "flex";
              textSpan.textContent = `Collapse unchanged lines`;
              iconSpan.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
            } else {
              foldContent.style.display = "none";
              textSpan.textContent = `+${item.lines.length} unchanged lines (click to expand)`;
              iconSpan.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
            }
            queueMicrotask(() => syncDiffPreviewOverflow());
          };

          hunkContent.appendChild(foldRow);
          hunkContent.appendChild(foldContent);
        }
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
    this.find.clear();
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
  const editPreview = parsePrismEditPreview(normalized);
  if (editPreview.length > 0) return editPreview;
  return parsePrismWritePreview(normalized);
}

/**
 * Parse Rust `preview_write` output for `edit_file`:
 *   ... --- old\n<old_string>\n+++ new\n<new_string>
 * There are no `@@` hunk lines; the unified-diff branch yields zero hunks without this.
 */
function parsePrismEditPreview(s: string): DiffHunk[] {
  let startLine = 1;
  const lineMatch = / \(line (\d+)\)/.exec(s);
  if (lineMatch) {
    startLine = parseInt(lineMatch[1], 10);
  }

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
  let o = startLine;
  let n = startLine;
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
      header: `@@ edit preview (at line ${startLine}) @@`,
      oldStart: startLine,
      newStart: startLine,
      lines,
    },
  ];
}

/**
 * Parse Rust `preview_write` output for `write_file`:
 *   write_file: <path>  (<size>)
 *
 *   <new content preview...>
 *
 * There is no old/new split in this shape, so we render a synthetic
 * "added-only" hunk instead of leaving the diff card empty.
 */
function parsePrismWritePreview(s: string): DiffHunk[] {
  if (!s.startsWith("write_file:")) return [];
  const sep = s.indexOf("\n\n");
  if (sep < 0) return [];
  const body = s.slice(sep + 2);
  if (body.trim().length === 0) return [];
  const newLines = body.split("\n");
  const lines: DiffLine[] = [];
  let n = 1;
  for (const content of newLines) {
    lines.push({
      type: "added",
      content,
      oldLine: null,
      newLine: n++,
    });
  }
  return [
    {
      header: "@@ write preview (new content) @@",
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

interface RenderedLineItemSingle {
  type: "single";
  line: DiffLine;
}

interface RenderedLineItemPaired {
  type: "paired";
  removed: DiffLine;
  added: DiffLine;
}

interface RenderedLineItemFold {
  type: "fold";
  lines: DiffLine[];
}

type RenderedLineItem = RenderedLineItemSingle | RenderedLineItemPaired | RenderedLineItemFold;

function buildRenderedLineItems(lines: DiffLine[]): RenderedLineItem[] {
  const items: RenderedLineItem[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      // Collect consecutive context lines
      const contextLines: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "context") {
        contextLines.push(lines[i]);
        i++;
      }
      
      // If there are more than 10 context lines, fold the middle!
      // (We keep 3 lines of context at the top and bottom visible, and fold the rest
      // if the folded part is at least 4 lines).
      const threshold = 10;
      if (contextLines.length > threshold) {
        const visibleTop = contextLines.slice(0, 3);
        const visibleBottom = contextLines.slice(contextLines.length - 3);
        const folded = contextLines.slice(3, contextLines.length - 3);
        
        for (const line of visibleTop) {
          items.push({ type: "single", line });
        }
        items.push({ type: "fold", lines: folded });
        for (const line of visibleBottom) {
          items.push({ type: "single", line });
        }
      } else {
        for (const line of contextLines) {
          items.push({ type: "single", line });
        }
      }
    } else if (lines[i].type === "removed") {
      // Handle pairing
      const removals: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "removed") {
        removals.push(lines[i]);
        i++;
      }
      const additions: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "added") {
        additions.push(lines[i]);
        i++;
      }

      const pairCount = Math.min(removals.length, additions.length);
      for (let k = 0; k < pairCount; k++) {
        items.push({
          type: "paired",
          removed: removals[k],
          added: additions[k],
        });
      }
      for (let k = pairCount; k < removals.length; k++) {
        items.push({ type: "single", line: removals[k] });
      }
      for (let k = pairCount; k < additions.length; k++) {
        items.push({ type: "single", line: additions[k] });
      }
    } else {
      // Standard added lines
      items.push({ type: "single", line: lines[i] });
      i++;
    }
  }
  return items;
}

function diffWords(oldStr: string, newStr: string): { oldHtml: string; newHtml: string } {
  if (!oldStr && !newStr) {
    return { oldHtml: "&nbsp;", newHtml: "&nbsp;" };
  }
  if (!oldStr) {
    return { oldHtml: "&nbsp;", newHtml: `<ins class="agent-diff-char-added">${escapeForSpan(newStr)}</ins>` };
  }
  if (!newStr) {
    return { oldHtml: `<del class="agent-diff-char-removed">${escapeForSpan(oldStr)}</del>`, newHtml: "&nbsp;" };
  }

  // Tokenize preserving whitespace, words, and delimiters
  const tokenize = (s: string) => {
    return s.split(/(\s+|[.,;:{}\[\]()'"+\-*\/&|%^~=<>?!`~]+)/).filter(Boolean);
  };

  const oldTokens = tokenize(oldStr);
  const newTokens = tokenize(newStr);

  // Dynamic programming LCS
  const dp: number[][] = Array(oldTokens.length + 1)
    .fill(null)
    .map(() => Array(newTokens.length + 1).fill(0));

  for (let i = 1; i <= oldTokens.length; i++) {
    for (let j = 1; j <= newTokens.length; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = oldTokens.length;
  let j = newTokens.length;
  const oldResult: string[] = [];
  const newResult: string[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      const escaped = escapeForSpan(oldTokens[i - 1]);
      oldResult.unshift(escaped);
      newResult.unshift(escaped);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      newResult.unshift(`<ins class="agent-diff-char-added">${escapeForSpan(newTokens[j - 1])}</ins>`);
      j--;
    } else {
      oldResult.unshift(`<del class="agent-diff-char-removed">${escapeForSpan(oldTokens[i - 1])}</del>`);
      i--;
    }
  }

  return {
    oldHtml: oldResult.join(""),
    newHtml: newResult.join(""),
  };
}
