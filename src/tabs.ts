// TabManager: orchestrates the tab strip UI and the collection of
// Workspace instances (one per tab). Each Workspace is independent \u2014 its
// own PTY, chat history, xterm, block manager. The TabManager only handles
// creating/destroying them and flipping which one is visible.

import { Workspace, type WorkspaceRestoreOptions } from "./workspace";
import { writeSessionState, type PersistedTab } from "./session";

export interface TabManagerOptions {
  tabStripEl: HTMLElement;
  workspacesParent: HTMLElement;
  onSelectTab?: (id: string) => void;
}

/** Debounce window for writing session.json. Long enough that a
 *  `cd a; cd b` script doesn't hammer the file, short enough that
 *  closing the app within a couple seconds of a cwd change still
 *  captures the change on disk. */
const SESSION_WRITE_DEBOUNCE_MS = 500;

export class TabManager {
  private readonly opts: TabManagerOptions;
  private readonly workspaces: Workspace[] = [];
  private activeId: string | null = null;
  /**
   * Pending debounce timer for the session.json write. Reset on
   * every event that mutates the persisted shape (cwd change, title
   * change, tab open, tab close). `null` when no write is pending.
   */
  private sessionWriteTimer: number | null = null;

  constructor(opts: TabManagerOptions) {
    this.opts = opts;
    this.render();

    // Final flush on window unload so a cwd change in the last 500ms
    // before quit still lands on disk. `beforeunload` fires reliably
    // in Tauri / WebView; the immediate (non-debounced) write keeps
    // it synchronous-enough to land before the process exits.
    window.addEventListener("beforeunload", () => {
      if (this.sessionWriteTimer !== null) {
        window.clearTimeout(this.sessionWriteTimer);
        this.sessionWriteTimer = null;
      }
      void this.flushSessionWrite();
    });

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
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        const ws = this.getActiveWorkspace();
        if (ws) {
          ws.toggleSidebar();
          // We don't have a direct reference to ToolbarManager here, 
          // but we can trigger the onSelectTab callback which main.ts 
          // uses to sync the UI.
          this.opts.onSelectTab?.(this.activeId!);
        }
      }
    });
  }

  // -- public API -----------------------------------------------------------

  /**
   * Create a new tab. Pass `restore` to rehydrate from a persisted
   * session entry (id + cwd + title), or omit for a fresh tab. Both
   * paths flow through the same plumbing; the only difference is
   * which arguments the Workspace receives.
   */
  newTab(restore?: WorkspaceRestoreOptions): Workspace {
    const ws = new Workspace(
      this.opts.workspacesParent,
      {
        onTitleChange: (id, title) => this.onTitleChange(id, title),
        onRequestClose: (id) => this.closeTab(id),
        onRequestNewTab: () => this.newTab(),
        onRequestSelectIndex: (i) => this.selectByIndex(i),
        // Cwd updates are the primary trigger for session writeback \u2014
        // they're the field a user actually cares about restoring.
        onCwdChange: () => this.scheduleSessionWrite(),
      },
      restore,
    );
    this.workspaces.push(ws);
    this.selectTab(ws.id);
    this.render();
    // Persist the new tab even if the user closes the app before its
    // cwd resolves \u2014 they'll get the tab back next launch with no cwd,
    // which is the same outcome as if it had never been opened, just
    // explicit instead of implicit.
    this.scheduleSessionWrite();
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
    this.opts.onSelectTab?.(id);
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

  getActiveWorkspace(): Workspace | null {
    return this.workspaces.find((w) => w.id === this.activeId) || null;
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

    // Tab close is the one event we ALWAYS persist immediately rather
    // than debouncing \u2014 closing then quitting within 500ms would
    // otherwise restore the closed tab on next launch, which would
    // feel broken (\"I closed it, why is it back?\"). Cancel any
    // pending debounce; flush synchronously.
    if (this.sessionWriteTimer !== null) {
      window.clearTimeout(this.sessionWriteTimer);
      this.sessionWriteTimer = null;
    }
    void this.flushSessionWrite();

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
    // Title changes are part of the persisted session shape (so the
    // tab strip restores with the right labels at zero latency on
    // launch). They're noisy on /audit / /build turns, hence the
    // debounce \u2014 a flurry of title updates becomes one write.
    this.scheduleSessionWrite();
  }

  /**
   * Schedule a debounced session.json write. Resets the existing
   * timer if one is pending. The persisted shape is computed at
   * flush time, not schedule time, so a cwd that lands during the
   * debounce window still makes it into the next write.
   */
  private scheduleSessionWrite(): void {
    if (this.sessionWriteTimer !== null) {
      window.clearTimeout(this.sessionWriteTimer);
    }
    this.sessionWriteTimer = window.setTimeout(() => {
      this.sessionWriteTimer = null;
      void this.flushSessionWrite();
    }, SESSION_WRITE_DEBOUNCE_MS);
  }

  /**
   * Materialize the current tabs into a `PersistedTab[]` and ship
   * them to the Rust side. Best-effort \u2014 `writeSessionState`
   * swallows errors with a console warning. Called from the
   * scheduler, the tab-close path, and the `beforeunload` hook.
   */
  private async flushSessionWrite(): Promise<void> {
    const tabs: PersistedTab[] = this.workspaces.map((w) => ({
      id: w.id,
      cwd: w.getCwd(),
      title: w.getTitle(),
    }));
    await writeSessionState(tabs);
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

    // Wire up context menus natively after render since innerHTML strips them
    strip.querySelectorAll(".tab").forEach((tabEl) => {
      tabEl.addEventListener("contextmenu", (e) => this.onTabContextMenu(e as MouseEvent, (tabEl as HTMLElement).dataset.id!));
    });
  }

  private onTabContextMenu(e: MouseEvent, id: string): void {
    e.preventDefault();
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) return;

    // Build and show a lightweight native-feeling popup menu
    const menu = document.createElement("div");
    menu.className = "tab-context-menu";
    menu.style.position = "fixed";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.background = "#1f2937";
    menu.style.border = "1px solid #374151";
    menu.style.borderRadius = "6px";
    menu.style.padding = "4px 0";
    menu.style.zIndex = "10000";
    menu.style.boxShadow = "0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.5)";
    menu.style.minWidth = "160px";
    menu.style.fontSize = "12px";
    menu.style.color = "#d1d5db";

    const addTarget = (label: string, icon: string, onClick: () => void) => {
      const item = document.createElement("div");
      item.style.padding = "6px 16px";
      item.style.cursor = "pointer";
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.gap = "8px";
      item.innerHTML = `<span style="opacity: 0.7;">${icon}</span> <span>${label}</span>`;
      item.onmouseover = () => (item.style.background = "#374151");
      item.onmouseout = () => (item.style.background = "transparent");
      item.onclick = () => {
        close();
        onClick();
      };
      menu.appendChild(item);
    };

    addTarget("Duplicate Path / New Chat", "↳", () => {
      this.newTab({ cwd: ws.getCwd() });
    });

    addTarget("Duplicate Full Session", "⧉", () => {
      ws.duplicateSession().then((newRestoreOpts) => {
        if (newRestoreOpts) {
          this.newTab(newRestoreOpts);
        }
      });
    });

    // Close area
    const backdrop = document.createElement("div");
    backdrop.style.position = "fixed";
    backdrop.style.inset = "0";
    backdrop.style.zIndex = "9999";

    const close = () => {
      menu.remove();
      backdrop.remove();
    };
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      close();
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
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
