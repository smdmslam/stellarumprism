/**
 * Controller for the Pop-out Reader Modal.
 * Manages "Pinned" files for side-by-side comparison.
 */

import { FileEditor } from "./file-editor";
import { invoke } from "@tauri-apps/api/core";

interface PaneState {
  path: string | null;
  cwd: string | null;
  editor: FileEditor | null;
  hostId: string;
}

const READER_EMPTY_HINT =
  '<div class="reader-pane-empty">No file open. Right-click a file in the tree → <strong>Open in Reader</strong>, or use <strong>Clear</strong> after a moved or deleted file.</div>';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, " ");
}

const COPY_PATH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

const COPY_CONTENTS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1Z"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>`;

export class ReaderUI {
  private readonly overlay: HTMLElement;
  private readonly content: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly splitBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  
  private left: PaneState = { path: null, cwd: null, editor: null, hostId: "reader-left" };
  private right: PaneState = { path: null, cwd: null, editor: null, hostId: "reader-right" };
  private isSplit = false;
  private activeSide: "left" | "right" = "left";
  private onChange?: () => void;

  constructor() {
    this.overlay = document.getElementById("reader-overlay")!;
    this.content = document.getElementById("reader-content")!;
    this.saveBtn = document.getElementById("reader-save") as HTMLButtonElement;
    this.splitBtn = document.getElementById("reader-split") as HTMLButtonElement;
    this.clearBtn = document.getElementById("reader-clear-panes") as HTMLButtonElement;
    this.wireEvents();
  }

  public setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  public isVisible(): boolean {
    return this.overlay.getAttribute("aria-hidden") === "false";
  }

  private async pin(cwd: string, path: string, silent = false): Promise<void> {
    if (!silent && !this.isVisible()) {
      this.overlay.setAttribute("aria-hidden", "false");
    }

    if (!this.left.path) {
      this.renderGrid();
      await this.loadPane("left", cwd, path);
    } else {
      if (!this.isSplit) {
        this.isSplit = true;
        this.renderGrid();
        // Re-load left because the host DOM changed
        if (this.left.path && this.left.cwd) await this.loadPane("left", this.left.cwd, this.left.path);
      }
      await this.loadPane("right", cwd, path);
    }
  }

  public async open(cwd: string, paths: string | string[]): Promise<void> {
    const pathList = Array.isArray(paths) ? paths : [paths];
    if (pathList.length === 0) return;

    // If reader is closed, open it and pin the first one or two.
    if (!this.isVisible()) {
      await this.pin(cwd, pathList[0]);
      if (pathList.length > 1) {
        this.isSplit = true;
        this.renderGrid();
        // Re-load left because the host DOM changed during renderGrid()
        if (this.left.path && this.left.cwd) {
          await this.loadPane("left", this.left.cwd, this.left.path);
        }
        await this.loadPane("right", cwd, pathList[1]);
      }
    } else {
      // If already open, just update the active pane(s).
      if (pathList.length > 1 && !this.isSplit) {
        this.isSplit = true;
        this.renderGrid();
        // Re-load existing content because the host DOM changed
        const existingSide = this.activeSide === "left" ? "right" : "left";
        const pane = existingSide === "left" ? this.left : this.right;
        if (pane.path && pane.cwd) {
          await this.loadPane(existingSide, pane.cwd, pane.path);
        }
      }
      await this.loadPane(this.activeSide, cwd, pathList[0]);
      if (pathList.length > 1) {
        const otherSide = this.activeSide === "left" ? "right" : "left";
        await this.loadPane(otherSide, cwd, pathList[1]);
      }
    }
  }

  private async loadPane(side: "left" | "right", cwd: string, path: string): Promise<void> {
    const pane = side === "left" ? this.left : this.right;
    pane.cwd = cwd;
    pane.path = path;
    this.activeSide = side;
    
    const host = document.getElementById(pane.hostId);
    if (!host) return;

    pane.editor?.destroy();
    pane.editor = null;
    host.innerHTML = `<div style="padding: 24px; color: #6b7280;">Loading...</div>`;

    try {
      const result = await invoke<{ content: string }>("read_file_text", { cwd, path });
      const filename = path.split("/").pop() ?? "unknown";
      
      host.innerHTML = `
        <div class="pane-header">
          <div class="pane-header-top">
            <span class="pane-filename" title="${escapeAttr(path)}">${escapeHtml(filename)}</span>
            <div class="pane-header-actions">
              <button class="file-preview-copy-path" type="button" aria-label="Copy path to clipboard" title="Copy path to clipboard">${COPY_PATH_SVG}</button>
              <button class="file-preview-copy-contents" type="button" aria-label="Copy file contents to clipboard" title="Copy file contents to clipboard">${COPY_CONTENTS_SVG}</button>
            </div>
          </div>
          <span class="pane-path" title="${escapeAttr(path)}">${escapeHtml(path)}</span>
        </div>
        <div id="${pane.hostId}-editor" class="reader-col-editor"></div>
      `;

      const editorHost = document.getElementById(`${pane.hostId}-editor`)!;
      pane.editor = new FileEditor(editorHost, result.content, path, {
        onDirtyChange: () => this.updateSaveButton(),
      });

      const copyPathBtn = host.querySelector<HTMLButtonElement>(".file-preview-copy-path");
      if (copyPathBtn) {
        copyPathBtn.addEventListener("click", () => {
          void navigator.clipboard.writeText(path).then(() => {
            copyPathBtn.classList.add("copied");
            copyPathBtn.setAttribute("title", "Copied!");
            setTimeout(() => {
              copyPathBtn.classList.remove("copied");
              copyPathBtn.setAttribute("title", "Copy path to clipboard");
            }, 1800);
          });
        });
      }

      const copyContentsBtn = host.querySelector<HTMLButtonElement>(".file-preview-copy-contents");
      if (copyContentsBtn) {
        copyContentsBtn.addEventListener("click", () => {
          const ed = pane.editor;
          if (!ed) return;
          void navigator.clipboard.writeText(ed.getValue()).then(() => {
            copyContentsBtn.classList.add("copied");
            copyContentsBtn.setAttribute("title", "Copied!");
            setTimeout(() => {
              copyContentsBtn.classList.remove("copied");
              copyContentsBtn.setAttribute("title", "Copy file contents to clipboard");
            }, 1800);
          });
        });
      }

      // Track focus to set activeSide
      editorHost.addEventListener("focusin", () => {
        this.activeSide = side;
        this.updateActivePaneUI();
      });

      this.updateSaveButton();
      this.updateActivePaneUI();
      pane.editor.focus();
      this.onChange?.();
    } catch (err) {
      // Drop stale path so pin()/reopen don't treat this pane as still occupied
      // (e.g. file was moved; next open should load on the left, not the right).
      pane.path = null;
      pane.cwd = null;
      pane.editor = null;
      host.innerHTML = `<div style="padding: 24px; color: #ef4444;">Error: ${String(err)}</div>`;
      this.onChange?.();
    }
  }

  private renderGrid(): void {
    this.content.innerHTML = `
      <div id="reader-grid" class="reader-grid ${this.isSplit ? "is-split" : ""}">
        <div id="reader-left" class="reader-col"></div>
        <div id="reader-right" class="reader-col" style="${this.isSplit ? "" : "display: none;"}"></div>
      </div>
    `;
    this.splitBtn.classList.toggle("active", this.isSplit);
    this.updateActivePaneUI();
  }

  private updateActivePaneUI(): void {
    const grid = document.getElementById("reader-grid");
    if (!grid) return;
    
    const leftCol = document.getElementById("reader-left");
    const rightCol = document.getElementById("reader-right");
    
    leftCol?.classList.toggle("is-active", this.activeSide === "left");
    rightCol?.classList.toggle("is-active", this.activeSide === "right");
  }

  private async toggleSplit(): Promise<void> {
    this.isSplit = !this.isSplit;
    this.renderGrid();

    // Single-pane layout only shows the left column. If the left pane lost its
    // path (load error) but the right pane is valid, promote right → left.
    if (!this.isSplit && !this.left.path && this.right.path && this.right.cwd) {
      const np = this.right.path;
      const nc = this.right.cwd;
      this.left.editor?.destroy();
      this.right.editor?.destroy();
      this.left.editor = null;
      this.right.editor = null;
      this.left.path = np;
      this.left.cwd = nc;
      this.right.path = null;
      this.right.cwd = null;
      this.activeSide = "left";
    }

    if (this.left.path && this.left.cwd) await this.loadPane("left", this.left.cwd, this.left.path);
    if (this.isSplit && this.right.path && this.right.cwd) {
      await this.loadPane("right", this.right.cwd, this.right.path);
    }
    this.onChange?.();
  }

  private updateSaveButton(): void {
    const isDirty = (this.left.editor?.isDirty() || this.right.editor?.isDirty());
    this.saveBtn.style.display = isDirty ? "block" : "none";
  }

  /** Drop all pane paths/editors so the next open starts fresh (fixes stale paths after moves). */
  public clearPanes(): void {
    this.left.editor?.destroy();
    this.right.editor?.destroy();
    this.left = { path: null, cwd: null, editor: null, hostId: "reader-left" };
    this.right = { path: null, cwd: null, editor: null, hostId: "reader-right" };
    this.isSplit = false;
    this.activeSide = "left";
    this.renderGrid();
    const leftHost = document.getElementById("reader-left");
    if (leftHost) leftHost.innerHTML = READER_EMPTY_HINT;
    this.updateSaveButton();
    this.onChange?.();
  }

  public close(): void {
    this.left.editor?.destroy();
    this.right.editor?.destroy();
    this.left = { path: null, cwd: null, editor: null, hostId: "reader-left" };
    this.right = { path: null, cwd: null, editor: null, hostId: "reader-right" };
    this.isSplit = false;
    this.activeSide = "left";
    this.overlay.setAttribute("aria-hidden", "true");
    this.onChange?.();
  }

  private async save(): Promise<void> {
    const panes = [this.left, this.right];
    for (const pane of panes) {
      if (pane.editor?.isDirty() && pane.path && pane.cwd) {
        const content = pane.editor.getValue();
        try {
          this.saveBtn.textContent = "Saving...";
          this.saveBtn.disabled = true;
          await invoke("write_file_text", {
            cwd: pane.cwd,
            path: pane.path,
            content,
            expectedMtimeSecs: null,
          });
          pane.editor.markClean(content);
        } catch (err) {
          alert(`Failed to save ${pane.path}: ${String(err)}`);
        }
      }
    }
    this.saveBtn.textContent = "Save";
    this.saveBtn.disabled = false;
    this.updateSaveButton();
  }

  private wireEvents(): void {
    document.getElementById("reader-close")?.addEventListener("click", () => this.close());
    this.saveBtn.addEventListener("click", () => this.save());
    this.splitBtn.addEventListener("click", () => void this.toggleSplit());
    this.clearBtn?.addEventListener("click", () => this.clearPanes());

    window.addEventListener("keydown", (e) => {
      if (this.isVisible()) {
        if (e.key === "Escape") this.close();
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          this.save();
        }
      }
    });
  }
}

let readerUISingleton: ReaderUI | null = null;

/** Minimal stub so Workspace can still boot if reader DOM is incomplete. */
function disabledReaderStub(): ReaderUI {
  return {
    setOnChange() {},
    open() {
      return Promise.resolve();
    },
  } as unknown as ReaderUI;
}

/**
 * Lazily construct ReaderUI on first use (during Workspace.init), not at module
 * load. Constructor failures fall back to a no-op stub so the rest of Prism
 * still mounts.
 */
export function getReaderUI(): ReaderUI {
  if (!readerUISingleton) {
    try {
      readerUISingleton = new ReaderUI();
    } catch (err) {
      console.error("[reader-ui] constructor failed — reader disabled:", err);
      readerUISingleton = disabledReaderStub();
    }
  }
  return readerUISingleton;
}
