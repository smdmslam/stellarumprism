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
  private currentEditor: FileEditor | null = null;
  private currentPath: string | null = null;
  private currentCwd: string | null = null;

  constructor() {
    this.overlay = document.getElementById("reader-overlay")!;
    this.content = document.getElementById("reader-content")!;
    this.filenameEl = document.getElementById("reader-filename")!;
    this.pathEl = document.getElementById("reader-path")!;
    this.saveBtn = document.getElementById("reader-save") as HTMLButtonElement;
    this.wireEvents();
  }

  public async open(cwd: string, path: string): Promise<void> {
    this.currentPath = path;
    this.currentCwd = cwd;
    
    const parts = path.split("/");
    const name = parts[parts.length - 1] ?? "unknown";
    
    this.filenameEl.textContent = name;
    this.pathEl.textContent = path;
    this.overlay.setAttribute("aria-hidden", "false");
    this.content.innerHTML = `<div style="padding: 24px; color: #6b7280;">Loading...</div>`;
    this.saveBtn.style.display = "none";

    try {
      const result = await invoke<{ content: string }>("read_file_text", { cwd, path });
      this.content.innerHTML = "";
      
      this.currentEditor = new FileEditor(this.content, result.content, path, {
        onDirtyChange: (dirty) => {
          this.saveBtn.style.display = dirty ? "block" : "none";
        },
      });
      
      // Focus the editor so the user can search/read immediately
      this.currentEditor.focus();
    } catch (err) {
      this.content.innerHTML = `<div style="padding: 24px; color: #ef4444;">Failed to read file: ${String(err)}</div>`;
    }
  }

  public close(): void {
    if (this.currentEditor) {
      this.currentEditor.destroy();
      this.currentEditor = null;
    }
    this.overlay.setAttribute("aria-hidden", "true");
    this.currentPath = null;
    this.currentCwd = null;
  }

  private async save(): Promise<void> {
    if (!this.currentEditor || !this.currentPath || !this.currentCwd) return;
    
    const content = this.currentEditor.getValue();
    try {
      this.saveBtn.textContent = "Saving...";
      this.saveBtn.disabled = true;
      
      await invoke("write_file_text", {
        cwd: this.currentCwd,
        path: this.currentPath,
        content,
        expectedMtimeSecs: null,
      });
      
      this.currentEditor.markClean(content);
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

    // Close on background click
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Global keys
    window.addEventListener("keydown", (e) => {
      if (this.overlay.getAttribute("aria-hidden") === "false") {
        if (e.key === "Escape") {
          this.close();
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          this.save();
        }
      }
    });
  }
}

export const readerUI = new ReaderUI();
