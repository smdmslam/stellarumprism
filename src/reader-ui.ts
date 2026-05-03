/**
 * Controller for the Pop-out Reader Modal.
 * Supports Comparative Mode (two different files) and Split View.
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
  private lastFocusedPane: "left" | "right" = "left";

  constructor() {
    this.overlay = document.getElementById("reader-overlay")!;
    this.content = document.getElementById("reader-content")!;
    this.saveBtn = document.getElementById("reader-save") as HTMLButtonElement;
    this.splitBtn = document.getElementById("reader-split") as HTMLButtonElement;
    this.wireEvents();
  }

  public isVisible(): boolean {
    return this.overlay.getAttribute("aria-hidden") === "false";
  }

  public async open(cwd: string, path: string): Promise<void> {
    // If the reader is already open and in split mode, load into the "other" pane
    // than the last focused one, or just the right pane if it's empty.
    if (this.isVisible() && this.isSplit) {
      if (this.lastFocusedPane === "left") {
        await this.loadPane("right", cwd, path);
      } else {
        await this.loadPane("left", cwd, path);
      }
    } else {
      // First time opening or single pane mode
      this.overlay.setAttribute("aria-hidden", "false");
      this.renderGrid();
      await this.loadPane("left", cwd, path);
    }
  }

  private async loadPane(side: "left" | "right", cwd: string, path: string): Promise<void> {
    const pane = side === "left" ? this.left : this.right;
    pane.cwd = cwd;
    pane.path = path;
    
    const host = document.getElementById(pane.hostId);
    if (!host) return;

    // Clear existing
    pane.editor?.destroy();
    host.innerHTML = `<div style="padding: 24px; color: #6b7280;">Loading ${path}...</div>`;

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
      
      // Wire focus tracking
      editorHost.addEventListener("focusin", () => {
        this.lastFocusedPane = side;
      });

      this.updateSaveButton();
      pane.editor.focus();
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
  }

  private async toggleSplit(): Promise<void> {
    this.isSplit = !this.isSplit;
    this.splitBtn.classList.toggle("active", this.isSplit);
    
    this.renderGrid();

    // Re-mount editors into the new DOM
    if (this.left.path && this.left.cwd) {
      await this.loadPane("left", this.left.cwd, this.left.path);
    }
    
    if (this.isSplit) {
      if (this.right.path && this.right.cwd) {
        await this.loadPane("right", this.right.cwd, this.right.path);
      } else if (this.left.path && this.left.cwd) {
        // Default to same file on right if empty (Book Mode starter)
        await this.loadPane("right", this.left.cwd, this.left.path);
      }
    } else {
      this.right.editor?.destroy();
      this.right.editor = null;
    }
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
  }

  private async save(): Promise<void> {
    // Save the pane that is currently dirty (or both)
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

    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });

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
