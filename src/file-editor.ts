// CodeMirror-based file editor surface.
//
// Replaces the old read-only HTML preview overlay with a real editable
// buffer. Plain-text only for v1: no language-aware syntax highlighting,
// but we get line numbers, search-friendly keybindings (via the default
// keymap), copy/paste, undo/redo, and tab-as-spaces. Language packages
// can be added later without changing this surface's contract.
//
// The editor exposes a tiny imperative API (`getValue`, `isDirty`,
// `markClean`, `setContent`, `destroy`) plus a single `onDirtyChange`
// callback. The hosting workspace owns the chrome (header, save
// button, dirty indicator, close confirmation) so the editor stays
// purely about the buffer.
//
// We deliberately do NOT register a Cmd+S binding inside the editor.
// The workspace listens at the document level so the same shortcut
// works whether or not the buffer has focus, and so we don't fight the
// browser's native Save handler in surprising ways.
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";

/** Callbacks the FileEditor invokes back into its host. */
export interface FileEditorCallbacks {
  /**
   * Fired whenever the buffer's dirty state flips (clean -> dirty or
   * dirty -> clean). Idempotent; the host can use this to toggle a
   * dirty indicator and the Save button's enabled state without
   * polling.
   */
  onDirtyChange: (dirty: boolean) => void;
}

/** A managed CodeMirror buffer for one open file. */
export class FileEditor {
  private readonly view: EditorView;
  private readonly cb: FileEditorCallbacks;
  private readonly themeCompartment = new Compartment();
  /** The text the buffer was last synced with (load or save). */
  private originalContent: string;
  /** Cached dirty state so we only fire the callback on transitions. */
  private currentDirty = false;

  constructor(host: HTMLElement, content: string, cb: FileEditorCallbacks) {
    this.cb = cb;
    this.originalContent = content;

    // Theme tweaks layered on top of oneDark. The host lives inside an
    // overlay with its own background; we let the theme handle the
    // gutter + line-number colors so they stay legible.
    const editorTheme = EditorView.theme(
      {
        "&": {
          height: "100%",
          fontSize: "12px",
          backgroundColor: "transparent",
        },
        ".cm-content": {
          fontFamily:
            '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace',
          padding: "8px 0",
        },
        ".cm-gutters": {
          backgroundColor: "#0a0d13",
          borderRight: "1px solid #1f2937",
          color: "#4b5563",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "rgba(125, 211, 252, 0.08)",
          color: "#94a3b8",
        },
        ".cm-activeLine": {
          backgroundColor: "rgba(125, 211, 252, 0.04)",
        },
        ".cm-scroller": { fontFamily: "inherit" },
        "&.cm-focused": { outline: "none" },
      },
      { dark: true },
    );

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const nowDirty = this.view.state.doc.toString() !== this.originalContent;
      if (nowDirty !== this.currentDirty) {
        this.currentDirty = nowDirty;
        try {
          this.cb.onDirtyChange(nowDirty);
        } catch (e) {
          console.error("FileEditor onDirtyChange threw", e);
        }
      }
    });

    const state = EditorState.create({
      doc: content,
      extensions: [
        history(),
        lineNumbers(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // Syntax highlighting fallback so even without a language
        // extension we get a defensible look. oneDarkHighlightStyle
        // gives us oneDark colors; defaultHighlightStyle is the
        // baseline backstop. Both are no-ops without a language to
        // produce tagged tokens, but they're cheap to load.
        syntaxHighlighting(oneDarkHighlightStyle),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        this.themeCompartment.of([oneDark, editorTheme]),
        updateListener,
      ],
    });

    this.view = new EditorView({ state, parent: host });
  }

  /** Current buffer contents. */
  getValue(): string {
    return this.view.state.doc.toString();
  }

  /** True iff the buffer has unsaved edits. */
  isDirty(): boolean {
    return this.currentDirty;
  }

  /**
   * Mark the buffer as clean, anchoring the dirty comparison to
   * `content` (typically the bytes that just landed on disk via
   * write_file_text). Fires onDirtyChange(false) if we were dirty.
   */
  markClean(content: string): void {
    this.originalContent = content;
    if (this.currentDirty) {
      this.currentDirty = false;
      try {
        this.cb.onDirtyChange(false);
      } catch (e) {
        console.error("FileEditor onDirtyChange threw", e);
      }
    }
  }

  /**
   * Replace the buffer wholesale and treat the new content as the
   * clean baseline. Used when the file changed on disk and the user
   * picks "reload" rather than "overwrite".
   */
  setContent(content: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: content },
    });
    this.markClean(content);
  }

  /** Move keyboard focus to the buffer. */
  focus(): void {
    this.view.focus();
  }

  /** True iff the editor's DOM has focus. */
  hasFocus(): boolean {
    return this.view.hasFocus;
  }

  /** Tear down the underlying CodeMirror view. Idempotent. */
  destroy(): void {
    this.view.destroy();
  }
}
