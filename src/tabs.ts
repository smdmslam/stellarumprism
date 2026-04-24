// TabManager: orchestrates the tab strip UI and the collection of
// Workspace instances (one per tab). Each Workspace is independent \u2014 its
// own PTY, chat history, xterm, block manager. The TabManager only handles
// creating/destroying them and flipping which one is visible.

import { Workspace } from "./workspace";

export interface TabManagerOptions {
  tabStripEl: HTMLElement;
  workspacesParent: HTMLElement;
}

export class TabManager {
  private readonly opts: TabManagerOptions;
  private readonly workspaces: Workspace[] = [];
  private activeId: string | null = null;

  constructor(opts: TabManagerOptions) {
    this.opts = opts;
    this.render();

    // Wire the single "+" new-tab button in the strip.
    opts.tabStripEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.matches(".new-tab-btn")) {
        this.newTab();
        return;
      }
      const closeBtn = target.closest<HTMLElement>(".tab-close");
      if (closeBtn) {
        e.stopPropagation();
        const id = closeBtn.dataset.id!;
        void this.closeTab(id);
        return;
      }
      const tabEl = target.closest<HTMLElement>(".tab[data-id]");
      if (tabEl) {
        this.selectTab(tabEl.dataset.id!);
      }
    });

    // Window-level keyboard shortcuts as a fallback (also handled inside the
    // editor, but this covers cases when focus isn't in CodeMirror).
    window.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        this.newTab();
      } else if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (this.activeId) void this.closeTab(this.activeId);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        this.selectByIndex(Number(e.key) - 1);
      } else if (e.key === "]" && e.shiftKey) {
        e.preventDefault();
        this.cycle(1);
      } else if (e.key === "[" && e.shiftKey) {
        e.preventDefault();
        this.cycle(-1);
      }
    });
  }

  // -- public API -----------------------------------------------------------

  newTab(): Workspace {
    const ws = new Workspace(this.opts.workspacesParent, {
      onTitleChange: (id, title) => this.onTitleChange(id, title),
      onRequestClose: (id) => this.closeTab(id),
      onRequestNewTab: () => this.newTab(),
      onRequestSelectIndex: (i) => this.selectByIndex(i),
    });
    this.workspaces.push(ws);
    this.selectTab(ws.id);
    this.render();
    return ws;
  }

  selectTab(id: string): void {
    if (this.activeId === id) return;
    for (const ws of this.workspaces) {
      if (ws.id === id) {
        ws.activate();
      } else {
        ws.deactivate();
      }
    }
    this.activeId = id;
    this.render();
  }

  selectByIndex(idx: number): void {
    const ws = this.workspaces[idx];
    if (ws) this.selectTab(ws.id);
  }

  cycle(delta: number): void {
    if (!this.activeId || this.workspaces.length < 2) return;
    const i = this.workspaces.findIndex((w) => w.id === this.activeId);
    if (i < 0) return;
    const next = (i + delta + this.workspaces.length) % this.workspaces.length;
    this.selectTab(this.workspaces[next].id);
  }

  async closeTab(id: string): Promise<void> {
    const idx = this.workspaces.findIndex((w) => w.id === id);
    if (idx < 0) return;
    const ws = this.workspaces[idx];

    // If the chat has content, confirm before closing.
    const hasContent = ws.hasContent();
    if (hasContent) {
      const choice = await promptSaveBeforeClose(ws.getTitle());
      if (choice === "cancel") return;
      if (choice === "save") {
        await ws.saveChat();
      }
    }

    await ws.dispose();
    this.workspaces.splice(idx, 1);

    if (this.workspaces.length === 0) {
      this.activeId = null;
      this.newTab();
      return;
    }
    if (this.activeId === id) {
      const neighbor = this.workspaces[Math.min(idx, this.workspaces.length - 1)];
      this.selectTab(neighbor.id);
    } else {
      this.render();
    }
  }

  // -- internals ------------------------------------------------------------

  private onTitleChange(id: string, _title: string): void {
    // Cheap re-render \u2014 DOM count is tiny.
    void _title;
    if (this.workspaces.some((w) => w.id === id)) this.render();
  }

  private render(): void {
    const strip = this.opts.tabStripEl;
    strip.innerHTML =
      this.workspaces
        .map((w) => {
          const active = w.id === this.activeId ? " active" : "";
          const title = escapeHtml(w.getTitle());
          return (
            `<div class="tab${active}" data-id="${w.id}" title="${title}">` +
            `<span class="tab-title">${title}</span>` +
            `<span class="tab-close" data-id="${w.id}" title="Close tab">\u00d7</span>` +
            `</div>`
          );
        })
        .join("") + `<button class="new-tab-btn" title="New tab (\u2318T)">+</button>`;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function promptSaveBeforeClose(
  title: string,
): Promise<"save" | "discard" | "cancel"> {
  // Use the Tauri ask/confirm APIs? For an MVP we use a native browser
  // confirm() loop with two questions, which is simple and works in the
  // webview without extra plugins.
  const save = window.confirm(`Save chat "${title}" before closing?`);
  if (!save) {
    // User said no \u2014 but we still want a way to cancel the close entirely.
    // `confirm` can't express three choices, so treat "cancel" on the second
    // prompt as keep-open.
    const discard = window.confirm(`Discard the chat?`);
    return discard ? "discard" : "cancel";
  }
  return "save";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
