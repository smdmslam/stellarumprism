/**
 * Agent Pane Find — Cmd+F search overlay for the agent dialogue panel.
 *
 * Implements match highlighting using a DOM text-node walker to avoid
 * corrupting HTML structures, and provides prev/next navigation, match
 * counts, and keyboard shortcuts (Enter for next, Shift+Enter for prev, Esc to close).
 */

export class AgentFind {
  private readonly stage: HTMLElement;
  private readonly scrollHost: HTMLElement;
  private barEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private countEl: HTMLElement | null = null;

  private matches: HTMLElement[] = [];
  private currentMatchIndex = -1;
  private activeQuery = "";

  constructor(stage: HTMLElement, scrollHost: HTMLElement) {
    this.stage = stage;
    this.scrollHost = scrollHost;

    this.initUI();
    this.bindEvents();
  }

  private initUI(): void {
    const bar = document.createElement("div");
    bar.className = "agent-find-bar";
    bar.setAttribute("hidden", "");
    bar.innerHTML = `
      <div class="agent-find-input-wrapper">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" class="agent-find-search-icon">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" class="agent-find-input" placeholder="Find in conversation..." spellcheck="false" autocomplete="off">
      </div>
      <span class="agent-find-count">0/0</span>
      <button class="agent-find-btn agent-find-prev" title="Previous match (Shift+Enter)">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
      </button>
      <button class="agent-find-btn agent-find-next" title="Next match (Enter)">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button class="agent-find-btn agent-find-close" title="Close search (Esc)">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;

    this.stage.appendChild(bar);
    this.barEl = bar;
    this.inputEl = bar.querySelector<HTMLInputElement>(".agent-find-input");
    this.countEl = bar.querySelector<HTMLElement>(".agent-find-count");
  }

  private bindEvents(): void {
    const input = this.inputEl;
    const bar = this.barEl;
    if (!input || !bar) return;

    // Search query typing
    input.addEventListener("input", () => {
      this.performSearch(input.value);
    });

    // Navigation and closing keyboard listeners inside input
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          this.navigate(-1);
        } else {
          this.navigate(1);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.hide();
      }
    });

    // Button clicks
    bar.querySelector(".agent-find-prev")?.addEventListener("click", () => this.navigate(-1));
    bar.querySelector(".agent-find-next")?.addEventListener("click", () => this.navigate(1));
    bar.querySelector(".agent-find-close")?.addEventListener("click", () => this.hide());

    // Global Cmd+F listener
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        // Fall back to standard editor search if focused in CodeMirror
        if (document.activeElement?.closest(".cm-editor")) {
          return;
        }
        e.preventDefault();
        this.show();
      } else if (e.key === "Escape" && !bar.hasAttribute("hidden")) {
        // Global Escape closes search if it's visible
        e.preventDefault();
        this.hide();
      }
    });
  }

  public show(): void {
    if (!this.barEl || !this.inputEl) return;
    this.barEl.removeAttribute("hidden");
    this.inputEl.focus();
    this.inputEl.select();

    // Re-run search in case content streamed in since last time
    if (this.inputEl.value) {
      this.performSearch(this.inputEl.value);
    }
  }

  public hide(): void {
    if (!this.barEl) return;
    this.barEl.setAttribute("hidden", "");
    this.clearSearch();
    
    // Return focus to previous element or input bar
    const inputBar = this.stage.ownerDocument.querySelector<HTMLElement>(".input-bar textarea, .input-bar input");
    inputBar?.focus();
  }

  public clear(): void {
    this.hide();
  }

  private clearSearch(): void {
    this.activeQuery = "";
    this.currentMatchIndex = -1;
    this.matches = [];
    this.clearHighlights();
    this.updateCountUI();
  }

  private performSearch(query: string): void {
    this.clearHighlights();
    this.activeQuery = query.trim();

    if (!this.activeQuery) {
      this.matches = [];
      this.currentMatchIndex = -1;
      this.updateCountUI();
      return;
    }

    this.matches = this.highlightText(this.scrollHost, this.activeQuery);
    this.currentMatchIndex = this.matches.length > 0 ? 0 : -1;
    this.updateCountUI();

    if (this.matches.length > 0) {
      this.selectMatch(0);
    }
  }

  private navigate(direction: number): void {
    if (this.matches.length === 0) return;
    const nextIdx = (this.currentMatchIndex + direction + this.matches.length) % this.matches.length;
    this.selectMatch(nextIdx);
    this.updateCountUI();
  }

  private selectMatch(index: number): void {
    if (this.currentMatchIndex >= 0 && this.currentMatchIndex < this.matches.length) {
      this.matches[this.currentMatchIndex].classList.remove("agent-find-match-current");
    }

    this.currentMatchIndex = index;
    const current = this.matches[this.currentMatchIndex];
    current.classList.add("agent-find-match-current");

    // Scroll match into view, ensuring we don't jump too violently
    current.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  private updateCountUI(): void {
    if (!this.countEl) return;
    if (this.matches.length === 0) {
      this.countEl.textContent = "0/0";
      this.countEl.classList.toggle("agent-find-no-matches", this.activeQuery.length > 0);
    } else {
      this.countEl.textContent = `${this.currentMatchIndex + 1}/${this.matches.length}`;
      this.countEl.classList.remove("agent-find-no-matches");
    }
  }

  private highlightText(container: HTMLElement, query: string): HTMLElement[] {
    const matches: HTMLElement[] = [];
    const walk = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walk.nextNode())) {
      textNodes.push(node as Text);
    }

    const regex = new RegExp(this.escapeRegExp(query), "gi");

    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (
        parent &&
        (parent.tagName === "SCRIPT" ||
          parent.tagName === "STYLE" ||
          parent.classList.contains("agent-find-match"))
      ) {
        continue;
      }

      const text = textNode.nodeValue || "";
      let match;
      const matchesInNode: { start: number; end: number }[] = [];
      while ((match = regex.exec(text)) !== null) {
        matchesInNode.push({ start: match.index, end: regex.lastIndex });
        if (match.index === regex.lastIndex) regex.lastIndex++; // avoid infinite loop
      }

      if (matchesInNode.length > 0) {
        let currentNode = textNode;
        for (let i = matchesInNode.length - 1; i >= 0; i--) {
          const { start, end } = matchesInNode[i];
          currentNode.splitText(end);
          const matchNode = currentNode.splitText(start);

          const span = container.ownerDocument.createElement("span");
          span.className = "agent-find-match";
          span.textContent = matchNode.textContent;
          matchNode.parentNode?.replaceChild(span, matchNode);

          matches.unshift(span); // keep them ordered
          currentNode = textNode;
        }
      }
    }

    return matches;
  }

  private clearHighlights(): void {
    const matches = this.scrollHost.querySelectorAll(".agent-find-match");
    for (const m of matches) {
      const parent = m.parentNode;
      if (parent) {
        while (m.firstChild) {
          parent.insertBefore(m.firstChild, m);
        }
        parent.removeChild(m);
      }
    }
    this.scrollHost.normalize();
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
