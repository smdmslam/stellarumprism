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
import {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
  RangeSetBuilder,
  Extension,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  highlightActiveLine,
  keymap,
  lineNumbers,
  // WidgetType,
  // ViewPlugin,
  // ViewUpdate,
} from "@codemirror/view";
// import { marked } from "marked";
// import hljs from "highlight.js";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from "@codemirror/language";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { tags as t } from "@lezer/highlight";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { languages } from "@codemirror/language-data";

/** Severity tier for an inline diagnostic. Same vocabulary as audit findings. */
export type EditorDiagnosticSeverity = "error" | "warning" | "info";

/** One inline diagnostic to render in the editor's gutter + body. */
export interface EditorDiagnostic {
  /** 1-based line number. Out-of-range lines are clamped to the file's bounds. */
  line: number;
  severity: EditorDiagnosticSeverity;
  /** Human-readable message; surfaced as a `title` tooltip on hover. */
  message: string;
  /** Optional source label (e.g. "audit", "lsp") shown after the message in the tooltip. */
  source?: string;
}

/**
 * StateEffect carrying the next diagnostic set. Sent through the
 * editor's transaction stream so the StateField below recomputes its
 * decorations + gutter markers in lockstep with the document.
 */
const setDiagnosticsEffect = StateEffect.define<EditorDiagnostic[]>();

/** Per-line gutter marker. Uses CSS classes to color by severity. */
class DiagnosticGutterMarker extends GutterMarker {
  constructor(
    readonly severity: EditorDiagnosticSeverity,
    readonly title: string,
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `cm-diag-gutter cm-diag-${this.severity}`;
    el.title = this.title;
    el.textContent = this.severity === "error" ? "\u25CF" : this.severity === "warning" ? "\u25B2" : "\u25CB";
    return el;
  }
  eq(other: GutterMarker): boolean {
    return (
      other instanceof DiagnosticGutterMarker &&
      other.severity === this.severity &&
      other.title === this.title
    );
  }
}

/**
 * State field that holds the current diagnostic set as both:
 *   - the raw EditorDiagnostic[] (so consumers can re-derive whatever
 *     they want), and
 *   - a DecorationSet covering line backgrounds + wavy underlines.
 * The corresponding gutter is wired separately via `gutter()` and reads
 * the same field.
 */
const diagnosticsField = StateField.define<{
  list: EditorDiagnostic[];
  decos: DecorationSet;
}>({
  create: () => ({ list: [], decos: Decoration.none }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setDiagnosticsEffect)) {
        next = { list: e.value, decos: buildDecorations(tr.state, e.value) };
      }
    }
    if (next === value && tr.docChanged) {
      // Document mutated under us: rebuild decorations against the new
      // line count so we don't paint into deleted territory. List is
      // unchanged; the host can decide whether to re-fetch findings.
      next = { list: value.list, decos: buildDecorations(tr.state, value.list) };
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

function buildDecorations(
  state: EditorState,
  diagnostics: EditorDiagnostic[],
): DecorationSet {
  if (diagnostics.length === 0) return Decoration.none;
  // Sort ascending so the RangeSetBuilder receives positions in order;
  // CodeMirror requires this and throws otherwise.
  const sorted = diagnostics
    .map((d) => ({ ...d, line: clampLine(state, d.line) }))
    .sort((a, b) => a.line - b.line || severityRank(a.severity) - severityRank(b.severity));
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of sorted) {
    const lineInfo = state.doc.line(d.line);
    builder.add(
      lineInfo.from,
      lineInfo.from,
      Decoration.line({
        class: `cm-diag-line cm-diag-line-${d.severity}`,
        attributes: { title: tooltipText(d) },
      }),
    );
    // Mark decoration so the line text gets a wavy underline. Empty
    // lines have from === to which CodeMirror treats as a no-op,
    // so an audit pinned to a blank line produces only the gutter
    // marker + line tint — acceptable.
    if (lineInfo.from < lineInfo.to) {
      builder.add(
        lineInfo.from,
        lineInfo.to,
        Decoration.mark({
          class: `cm-diag-mark cm-diag-mark-${d.severity}`,
          attributes: { title: tooltipText(d) },
        }),
      );
    }
  }
  return builder.finish();
}

function tooltipText(d: EditorDiagnostic): string {
  const prefix = `[${d.severity}]`;
  const suffix = d.source ? ` (${d.source})` : "";
  return `${prefix} ${d.message}${suffix}`;
}

function clampLine(state: EditorState, line: number): number {
  const max = state.doc.lines;
  if (!Number.isFinite(line) || line < 1) return 1;
  return Math.min(max, Math.floor(line));
}

function severityRank(s: EditorDiagnosticSeverity): number {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}

/**
 * Gutter that renders one DiagnosticGutterMarker per affected line.
 * Reads the diagnostics field directly so updates flow through the
 * same transaction the decorations did.
 */
const diagnosticsGutter = gutter({
  class: "cm-diag-gutter-col",
  lineMarker(view, blockInfo) {
    const field = view.state.field(diagnosticsField, false);
    if (!field || field.list.length === 0) return null;
    const lineNum = view.state.doc.lineAt(blockInfo.from).number;
    // If multiple diagnostics share a line, pick the most severe one
    // for the gutter marker; the line tint + tooltip still merge them.
    let best: EditorDiagnostic | null = null;
    const sameLine: EditorDiagnostic[] = [];
    for (const d of field.list) {
      if (d.line !== lineNum) continue;
      sameLine.push(d);
      if (!best || severityRank(d.severity) < severityRank(best.severity)) {
        best = d;
      }
    }
    if (!best) return null;
    const title =
      sameLine.length === 1
        ? tooltipText(best)
        : sameLine.map(tooltipText).join("\n");
    return new DiagnosticGutterMarker(best.severity, title);
  },
  initialSpacer: () => new DiagnosticGutterMarker("info", ""),
});

/**
 * Widget that renders a rendered HTML preview of a markdown block (heading,
 * code block, etc.) directly in the editor flow.
 */
/*
class MarkdownPreviewWidget extends WidgetType {
  constructor(readonly html: string) {
    super();
  }

  toDOM() {
    const div = document.createElement("div");
    div.className = "markdown-preview-widget";
    div.innerHTML = this.html;
    return div;
  }

  ignoreEvent() {
    return true; // Let the editor handle clicks for editing
  }
}
*/

/**
 * View plugin that scans the document for markdown structures and injects
 * preview widgets. Dynamic: re-scans on edit or viewport change.
 */
// const markdownPreviewPlugin = ViewPlugin.fromClass(
//   class {
//     decorations: DecorationSet;
// 
//     constructor(view: EditorView) {
//       this.decorations = this.buildDecorations(view);
//     }
// 
//     update(update: ViewUpdate) {
//       if (update.docChanged || update.viewportChanged) {
//         this.decorations = this.buildDecorations(update.view);
//       }
//     }
// 
//     private buildDecorations(view: EditorView) {
//       const builder = new RangeSetBuilder<Decoration>();
//       const content = view.state.doc.toString();
//       const lines = content.split("\n");
//       let pos = 0;
// 
//       for (let i = 0; i < lines.length; i++) {
//         const line = lines[i];
//         const lineStart = pos;
// 
//         // Render headings (H1-H6)
//         if (line.match(/^#{1,6}\s/)) {
//           try {
//             const html = marked.parse(line) as string;
//             builder.add(
//               lineStart,
//               lineStart,
//               Decoration.widget({
//                 widget: new MarkdownPreviewWidget(html),
//                 side: -1,
//                 block: true,
//               }),
//             );
//           } catch (e) {
//             console.warn("Markdown preview error", e);
//           }
//         }
// 
//         // Render code block starts
//         if (line.trim().startsWith("```")) {
//           const lang = line.trim().slice(3);
//           let codeLines: string[] = [];
//           let j = i + 1;
//           while (j < lines.length && !lines[j].trim().startsWith("```")) {
//             codeLines.push(lines[j]);
//             j++;
//           }
//           if (j < lines.length) {
//             const code = codeLines.join("\n");
//             let highlighted = code;
//             try {
//               if (lang && hljs.getLanguage(lang)) {
//                 highlighted = hljs.highlight(code, { language: lang }).value;
//               } else {
//                 highlighted = hljs.highlightAuto(code).value;
//               }
//             } catch (e) {
//               /* fallback to raw */
//             }
//             const html = `<pre class="markdown-code-block"><code>${highlighted}</code></pre>`;
//             builder.add(
//               lineStart,
//               lineStart,
//               Decoration.widget({
//                 widget: new MarkdownPreviewWidget(html),
//                 side: -1,
//                 block: true,
//               }),
//             );
//             
//             // Skip the content of the code block in the main loop to avoid
//             // redundant scans, but we must update 'pos' and 'i' correctly.
//             // Actually, it's safer to just let the loop continue but we
//             // already have the logic to only trigger on '```' starts.
//           }
//         }
// 
//         pos += line.length + 1;
//       }
//       return builder.finish();
//     }
//   },
//   {
//     decorations: (v) => v.decorations,
//   },
// );

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

/**
 * Prism-palette overlay on top of `oneDarkHighlightStyle`. The base
 * theme paints markdown headings red and inline code green, which
 * fights with the agent pane's cyan/violet language. We layer this
 * style AFTER oneDark so its rules win for the tags we care about
 * while everything else (keywords, strings, comments) keeps the
 * familiar oneDark coloring.
 *
 *   tags.heading*           \u2192 cyan   (matches `.agent-turn-user`)
 *   tags.processingInstruction (the `#` glyphs)
 *                            \u2192 cyan, dimmed
 *   tags.monospace          \u2192 violet (matches the `agent` label)
 *   tags.url / tags.link    \u2192 cyan
 *   tags.emphasis           \u2192 italic, slate
 *   tags.strong             \u2192 bold, near-white
 */
const prismMarkdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: "#7dd3fc", fontWeight: "700" },
  { tag: t.heading1, color: "#7dd3fc", fontWeight: "800" },
  { tag: t.heading2, color: "#7dd3fc", fontWeight: "700" },
  { tag: t.heading3, color: "#7dd3fc", fontWeight: "700" },
  { tag: t.heading4, color: "#7dd3fc", fontWeight: "700" },
  { tag: t.heading5, color: "#7dd3fc", fontWeight: "600" },
  { tag: t.heading6, color: "#7dd3fc", fontWeight: "600" },
  { tag: t.processingInstruction, color: "rgba(125, 211, 252, 0.55)" },
  { tag: t.contentSeparator, color: "rgba(125, 211, 252, 0.45)" },
  { tag: t.monospace, color: "#c084fc" },
  { tag: t.url, color: "#7dd3fc", textDecoration: "underline" },
  { tag: t.link, color: "#7dd3fc" },
  { tag: t.emphasis, color: "#cbd5e1", fontStyle: "italic" },
  { tag: t.strong, color: "#f3f4f6", fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.quote, color: "#9ca3af", fontStyle: "italic" },
]);

/** Helper function to determine language extension from file path */
function getLanguageExtension(filePath: string): Extension {
  const ext = filePath.toLowerCase();
  if (ext.endsWith(".md") || ext.endsWith(".markdown")) {
    return markdown({ base: markdownLanguage, codeLanguages: languages });
  } else if (ext.endsWith(".js") || ext.endsWith(".jsx")) {
    return javascript({ jsx: true });
  } else if (ext.endsWith(".ts") || ext.endsWith(".tsx")) {
    return javascript({ jsx: true, typescript: true });
  } else if (ext.endsWith(".json")) {
    return json();
  } else if (ext.endsWith(".py")) {
    return python();
  } else if (ext.endsWith(".html")) {
    return html();
  } else if (ext.endsWith(".css")) {
    return css();
  } else if (ext.endsWith(".xml")) {
    return xml();
  } else if (ext.endsWith(".yml") || ext.endsWith(".yaml")) {
    return yaml();
  } else if (ext.endsWith(".sql")) {
    return sql();
  }
  return []; // Use plain text
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

  constructor(host: HTMLElement, content: string, filePath: string, cb: FileEditorCallbacks) {
    this.cb = cb;
    this.originalContent = content;

    const languageExt = getLanguageExtension(filePath);
    // const isMarkdown = filePath.toLowerCase().endsWith(".md") || filePath.toLowerCase().endsWith(".markdown");

    // Theme tweaks layered on top of oneDark. Color tokens mirror the
    // agent pane (`.agent-stage`, `.markdown-body`, `.input-row`):
    //   surface         #0d0f14   (matches .agent-stage)
    //   gutter surface  #0a0c11   (matches .input-bar)
    //   borders         #1f2937
    //   accent          --prism-cyan (#7dd3fc) at low opacity
    // so the file editor and the agent surface read as siblings.
    const editorTheme = EditorView.theme(
      {
        "&": {
          height: "100%",
          fontSize: "var(--editor-font-size, 14px)",
          lineHeight: "1.7",
          backgroundColor: "transparent",
          color: "#e5e7eb",
        },
        ".cm-content": {
          fontFamily:
            '"JetBrainsMono NF", "MesloLGS NF", "SF Mono", Menlo, Monaco, Consolas, monospace',
          padding: "12px 0",
          caretColor: "#7dd3fc",
        },
        ".cm-gutters": {
          backgroundColor: "#0a0c11",
          borderRight: "1px solid #1f2937",
          color: "#4b5563",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          padding: "0 10px 0 8px",
          color: "#4b5563",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "rgba(125, 211, 252, 0.10)",
          color: "#7dd3fc",
          fontWeight: "600",
        },
        ".cm-activeLine": {
          backgroundColor: "rgba(125, 211, 252, 0.06)",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "#7dd3fc",
          borderLeftWidth: "2px",
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: "rgba(125, 211, 252, 0.22) !important",
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
        diagnosticsField,
        diagnosticsGutter,
        lineNumbers(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        
        // Language support
        languageExt,
        
        // NOTE: Markdown preview plugin disabled - it was hiding text content.
        // The preview widgets were rendering but the source text disappeared.
        // Re-enable only if the widget rendering can be fixed to preserve
        // text visibility (e.g., use line-breaks or rendering mode that doesn't hide source).
        // ...(isMarkdown ? [markdownPreviewPlugin] : []),
        
        // Syntax highlighting. oneDark paints baseline colors; the
        // Prism overlay wins for markdown heading/code tags so the
        // source view speaks the same cyan/violet language as the
        // agent pane.
        syntaxHighlighting(oneDarkHighlightStyle),
        syntaxHighlighting(prismMarkdownHighlightStyle),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // WARP-like feature: Word wrapping so text never gets cut off
        EditorView.lineWrapping,
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

  /**
   * Replace the editor's diagnostic set. Pass [] to clear. The
   * decorations re-render in lockstep with the buffer, so calling
   * this with the same set in response to an edit is cheap.
   */
  setDiagnostics(diagnostics: EditorDiagnostic[]): void {
    this.view.dispatch({ effects: setDiagnosticsEffect.of(diagnostics) });
  }

  /** Tear down the underlying CodeMirror view. Idempotent. */
  destroy(): void {
    this.view.destroy();
  }
}
