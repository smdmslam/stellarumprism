/**
 * Controller for the Pop-out Reader Modal.
 */

import { FileEditor } from "./file-editor";
import { invoke } from "@tauri-apps/api/core";

export class ReaderUI {
  private readonly overlay: HTMLElement;
  private readonly content: HTMLElement;
  private readonly filenameEl: HTMLElement;
  private readonly pathEl: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly splitBtn: HTMLButtonElement;
  
  private leftEditor: FileEditor | null = null;
  private rightEditor: FileEditor | null = null;
  private isSplit = false;
  
  private currentPath: string | null = null;
  private currentCwd: string | null = null;

  constructor() {
    this.overlay = document.getElementById("reader-overlay")!;
    this.content = document.getElementById("reader-content")!;
    this.filenameEl = document.getElementById("reader-filename")!;
    this.pathEl = document.getElementById("reader-path")!;
    this.saveBtn = document.getElementById("reader-save") as HTMLButtonElement;
    this.splitBtn = document.getElementById("reader-split") as HTMLButtonElement;
    this.wireEvents();
  }

  public async open(cwd: string, path: string): Promise<void> {
    this.currentPath = path;
    this.currentCwd = cwd;
    this.isSplit = false;
    
    const parts = path.split("/");
    const name = parts[parts.length - 1] ?? "unknown";
    
    this.filenameEl.textContent = name;
    this.pathEl.textContent = path;
    this.overlay.setAttribute("aria-hidden", "false");
    this.content.innerHTML = `<div style="padding: 24px; color: #6b7280;">Loading...</div>`;
    this.saveBtn.style.display = "none";
    this.splitBtn.classList.remove("active");

    try {
      const result = await invoke<{ content: string }>("read_file_text", { cwd, path });
      this.initialContent = result.content;
      this.renderGrid();
      
      const leftHost = document.getElementById("reader-left")!;
      this.leftEditor = new FileEditor(leftHost, result.content, path, {
        onDirtyChange: () => this.updateSaveButton(),
      });
      
      this.leftEditor.focus();
    } catch (err) {
      this.content.innerHTML = `<div style="padding: 24px; color: #ef4444;">Failed to read file: ${String(err)}</div>`;
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

  private toggleSplit(): void {
    if (!this.leftEditor || !this.currentPath) return;
    
    this.isSplit = !this.isSplit;
    this.splitBtn.classList.toggle("active", this.isSplit);
    
    const grid = document.getElementById("reader-grid");
    const rightHost = document.getElementById("reader-right");
    
    if (this.isSplit) {
      grid?.classList.add("is-split");
      if (rightHost) {
        rightHost.style.display = "block";
        // Clone current content from left editor into right
        const content = this.leftEditor.getValue();
        this.rightEditor = new FileEditor(rightHost, content, this.currentPath, {
          onDirtyChange: () => this.updateSaveButton(),
        });
      }
    } else {
      grid?.classList.remove("is-split");
      if (rightHost) {
        rightHost.style.display = "none";
        if (this.rightEditor) {
          this.rightEditor.destroy();
          this.rightEditor = null;
        }
      }
    }
  }

  private updateSaveButton(): void {
    const isDirty = (this.leftEditor?.isDirty() || this.rightEditor?.isDirty());
    this.saveBtn.style.display = isDirty ? "block" : "none";
  }

  public close(): void {
    this.leftEditor?.destroy();
    this.rightEditor?.destroy();
    this.leftEditor = null;
    this.rightEditor = null;
    this.overlay.setAttribute("aria-hidden", "true");
    this.currentPath = null;
    this.currentCwd = null;
  }

  private async save(): Promise<void> {
    const editor = this.leftEditor || this.rightEditor;
    if (!editor || !this.currentPath || !this.currentCwd) return;
    
    // Use the content from whichever editor was last focused/edited
    // (In a split view, this is a bit ambiguous, but we take the first available)
    const content = editor.getValue();
    try {
      this.saveBtn.textContent = "Saving...";
      this.saveBtn.disabled = true;
      
      await invoke("write_file_text", {
        cwd: this.currentCwd,
        path: this.currentPath,
        content,
        expectedMtimeSecs: null,
      });
      
      this.leftEditor?.markClean(content);
      this.rightEditor?.markClean(content);
      this.saveBtn.textContent = "Save";
      this.saveBtn.disabled = false;
      this.saveBtn.style.display = "none";
    } catch (err) {
      alert(`Failed to save: ${String(err)}`);
      this.saveBtn.textContent = "Save";
      this.saveBtn.disabled = false;
    }
  }

  private wireEvents(): void {
    document.getElementById("reader-close")?.addEventListener("click", () => this.close());
    this.saveBtn.addEventListener("click", () => this.save());
    this.splitBtn.addEventListener("click", () => this.toggleSplit());

    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });

    window.addEventListener("keydown", (e) => {
      if (this.overlay.getAttribute("aria-hidden") === "false") {
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
