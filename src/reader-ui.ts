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

export class ReaderUI {
  private readonly overlay: HTMLElement;
  private readonly content: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly splitBtn: HTMLButtonElement;
  
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
    this.wireEvents();
  }

  public setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  public isVisible(): boolean {
    return this.overlay.getAttribute("aria-hidden") === "false";
  }

  public getPinnedPaths(): string[] {
    const paths: string[] = [];
    if (this.left.path) paths.push(this.left.path);
    if (this.right.path) paths.push(this.right.path);
    return paths;
  }

  /** Toggle a file's pinned status in the reader. */
  public async togglePin(cwd: string, path: string): Promise<void> {
    if (this.left.path === path) {
      await this.unpin("left");
    } else if (this.right.path === path) {
      await this.unpin("right");
    } else {
      await this.pin(cwd, path);
    }
  }

  private async pin(cwd: string, path: string): Promise<void> {
    if (!this.isVisible()) {
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

  private async unpin(side: "left" | "right"): Promise<void> {
    const pane = side === "left" ? this.left : this.right;
    pane.editor?.destroy();
    pane.editor = null;
    pane.path = null;
    pane.cwd = null;

    if (side === "left" && this.right.path) {
      const rPath = this.right.path;
      const rCwd = this.right.cwd!;
      await this.unpin("right");
      await this.pin(rCwd, rPath);
    }

    if (this.isSplit && (!this.left.path || !this.right.path)) {
      this.isSplit = false;
      this.renderGrid();
      if (this.left.path && this.left.cwd) await this.loadPane("left", this.left.cwd, this.left.path);
    }

    if (!this.left.path && !this.right.path) {
      this.close();
    }
    
    this.onChange?.();
  }

  public async open(cwd: string, path: string): Promise<void> {
    // Standard "Open" behavior (e.g. from context menu)
    // If reader is open, target the active pane. If not, open as pinned.
    if (!this.isVisible()) {
      await this.pin(cwd, path);
    } else {
      await this.loadPane(this.activeSide, cwd, path);
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
    host.innerHTML = `<div style="padding: 24px; color: #6b7280;">Loading...</div>`;

    try {
      const result = await invoke<{ content: string }>("read_file_text", { cwd, path });
      const filename = path.split("/").pop() ?? "unknown";
      
      host.innerHTML = `
        <div class="pane-header">
          <span class="pane-filename">${filename}</span>
          <span class="pane-path">${path}</span>
        </div>
        <div id="${pane.hostId}-editor" class="reader-col-editor"></div>
      `;

      const editorHost = document.getElementById(`${pane.hostId}-editor`)!;
      pane.editor = new FileEditor(editorHost, result.content, path, {
        onDirtyChange: () => this.updateSaveButton(),
      });
      
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
      host.innerHTML = `<div style="padding: 24px; color: #ef4444;">Error: ${String(err)}</div>`;
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

  public close(): void {
    this.left.editor?.destroy();
    this.right.editor?.destroy();
    this.left.editor = null;
    this.right.editor = null;
    this.left.path = null;
    this.right.path = null;
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
    this.splitBtn.addEventListener("click", () => this.toggleSplit());

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

export const readerUI = new ReaderUI();
