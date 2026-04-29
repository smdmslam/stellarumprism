// CodeMirror 6 based input editor. Replaces raw xterm.js keystroke entry with
// a proper editor surface: multi-line, shell syntax highlighting, cursor and
// selection support, copy/paste, and a command-history ring.

import { EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder,
  tooltips,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { syntaxHighlighting } from "@codemirror/language";
import {
  autocompletion,
  completionKeymap,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { detectIntent, type Intent, type IntentResult } from "./intent";
import {
  SLASH_COMMANDS,
  modelCompletions,
  recipeCompletions,
} from "./slash-commands";
import { invoke } from "@tauri-apps/api/core";

// Lookup: completion label -> long description. Populated at module load from
// the slash-commands registry + model library. Used by the autocomplete
// row renderer to show the description as a second line, Discord-style.
const DESC_BY_LABEL = new Map<string, string>();
for (const c of SLASH_COMMANDS) {
  if (c.info) DESC_BY_LABEL.set(c.label, c.info);
}
for (const m of modelCompletions()) {
  DESC_BY_LABEL.set(m.label, m.info);
}
for (const r of recipeCompletions()) {
  DESC_BY_LABEL.set(r.label, r.info);
}

export interface PrismInputOptions {
  /** Called when the user submits the current input (Enter w/o modifiers). */
  onSubmit: (text: string, intent: IntentResult) => void;
  /** Called on every edit so the UI can update the intent badge, etc. */
  onChange?: (text: string, intent: IntentResult) => void;
  /** Called when the user toggles explicit agent mode (Ctrl+K). */
  onToggleAgent?: (agent: boolean) => void;
  /**
   * Called when the user presses a control key that should be forwarded to
   * the PTY rather than handled by the editor (e.g. Ctrl+C to interrupt a
   * running command). Return `true` if the key was forwarded.
   */
  onControlKey?: (key: "SIGINT" | "EOF" | "SIGTSTP") => boolean;
  /** Returns the shell's current working directory for @path autocomplete. */
  getCwd?: () => string;
}

/** A minimal, Prism-flavored editor for the active command line. */
/**
 * Latest registered PrismInput options lookup — lets the module-level
 * `slashCompletions` source reach into the active workspace's cwd. We keep
 * a WeakMap keyed by the EditorView so multiple tabs coexist cleanly.
 */
const OPTIONS_BY_VIEW = new WeakMap<EditorView, PrismInputOptions>();

export class PrismInput {
  private readonly view: EditorView;
  private readonly opts: PrismInputOptions;

  // Command history (most-recent last). Navigated with arrow keys.
  private readonly historyLog: string[] = [];
  private historyIndex: number | null = null;
  /** Cached current draft while browsing history so it can be restored. */
  private draft = "";

  /** When true, every submission is treated as an agent prompt. */
  private agentMode = false;

  constructor(host: HTMLElement, opts: PrismInputOptions) {
    this.opts = opts;

    // Theme tweaks on top of oneDark so the editor blends with the app chrome.
    const prismTheme = EditorView.theme(
      {
        "&": {
          backgroundColor: "transparent",
          color: "#e6e6e6",
          // Fallback matches `DEFAULT_SETTINGS.editorFontSize` in
          // `settings.ts` and `file-editor.ts`. The CSS var is set
          // by `SettingsManager.applyCssVariables()` at startup.
          fontSize: "var(--editor-font-size, 12px)",
        },
        ".cm-content": {
          caretColor: "#7dd3fc",
          fontFamily:
            '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace',
          padding: "8px 0",
          minHeight: "20px",
        },
        ".cm-line": { padding: "0 8px" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#7dd3fc" },
        "&.cm-focused .cm-cursor": { borderLeftColor: "#7dd3fc" },
        ".cm-gutters": { display: "none" },
        ".cm-scroller": { fontFamily: "inherit" },
        "&.cm-focused": { outline: "none" },
      },
      { dark: true },
    );

    // High-precedence keymap so Enter/Shift+Enter/history bindings override
    // CodeMirror defaults without us losing access to the rest of them.
    const submitKeymap = Prec.highest(
      keymap.of([
        {
          key: "Enter",
          run: () => {
            this.submit();
            return true;
          },
          shift: () => {
            // Shift+Enter: insert a real newline.
            const sel = this.view.state.selection.main;
            this.view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: "\n" },
              selection: { anchor: sel.from + 1 },
              scrollIntoView: true,
            });
            return true;
          },
        },
        {
          key: "Ctrl-k",
          mac: "Ctrl-k",
          run: () => {
            this.toggleAgent();
            return true;
          },
        },
        // Ctrl+C: if the consumer handles it (i.e. a command is running),
        // forward as SIGINT to the PTY. Otherwise fall through so CodeMirror's
        // default Copy behavior applies.
        {
          key: "Ctrl-c",
          mac: "Ctrl-c",
          run: () => this.opts.onControlKey?.("SIGINT") === true,
        },
        {
          key: "Ctrl-d",
          mac: "Ctrl-d",
          run: () => this.opts.onControlKey?.("EOF") === true,
        },
        {
          key: "Ctrl-z",
          mac: "Ctrl-z",
          run: () => this.opts.onControlKey?.("SIGTSTP") === true,
        },
        {
          key: "ArrowUp",
          run: () => this.tryHistoryPrev(),
        },
        {
          key: "ArrowDown",
          run: () => this.tryHistoryNext(),
        },
        // Cmd+Backspace (Mac) / Ctrl+Backspace (other): delete one path
        // segment when the user is mid-typing a `/cd` or `@` path. This
        // turns recovery from a bad autocomplete pick into a single
        // keystroke instead of N backspaces. Falls through to CodeMirror's
        // default word-delete when not in a path context.
        {
          key: "Mod-Backspace",
          run: () => this.deletePathSegment(),
        },
      ]),
    );

    const state = EditorState.create({
      doc: "",
      extensions: [
        history(),
        // Put the submit/shift-enter/history keymap at highest precedence.
        submitKeymap,
        // Autocomplete keymap (Enter accepts, Esc closes) needs precedence
        // just below that so Enter still submits when no popup is visible.
        keymap.of(completionKeymap),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // Render tooltips (including autocomplete) in a fixed-positioned
        // element attached to document.body so they escape the
        // overflow:auto on .editor-host that was clipping them.
        tooltips({
          position: "fixed",
          parent: document.body,
        }),
        autocompletion({
          override: [slashCompletions],
          activateOnTyping: true,
          closeOnBlur: true,
          icons: false,
          // Insert a second-line description element into each row so the
          // user can read what a command does without hovering — Discord/
          // Midjourney-style. Runs AFTER detail (position 80), hence 85.
          addToOptions: [
            {
              position: 85,
              render: (completion) => {
                const desc = DESC_BY_LABEL.get(completion.label);
                if (!desc) return null;
                const el = document.createElement("div");
                el.className = "cm-completionSubtitle";
                el.textContent = desc;
                return el;
              },
            },
          ],
        }),
        StreamLanguage.define(shell),
        syntaxHighlighting(oneDarkHighlightStyle),
        oneDark,
        prismTheme,
        // Soft-wrap is on. The input chrome (cwd badge, intent pill, model
        // badge) lives in a meta row BELOW the editor now, so wrapping the
        // text no longer shifts those elements around. The input bar grows
        // vertically up to its max-height cap, then scrolls inside itself.
        // Explicit newlines via Shift+Enter still work as before; multi-line
        // agent prompts use real \n characters, not soft-wrapped visual lines.
        EditorView.lineWrapping,
        placeholder("Type a command\u2026  (\u2318/ for commands, \u21e7\u23ce newline, \u2303K agent)"),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.notifyChange();
        }),
      ],
    });

    this.view = new EditorView({ parent: host, state });
    OPTIONS_BY_VIEW.set(this.view, opts);
  }

  // -- public API -----------------------------------------------------------

  focus(): void {
    this.view.focus();
  }

  getValue(): string {
    return this.view.state.doc.toString();
  }

  setValue(text: string, cursorAtEnd = true): void {
    const len = this.view.state.doc.length;
    this.view.dispatch({
      changes: { from: 0, to: len, insert: text },
      selection: { anchor: cursorAtEnd ? text.length : 0 },
      scrollIntoView: true,
    });
  }

  /**
   * Insert `text` at the current cursor position (replacing any active
   * selection). Cursor lands at the end of the inserted text. Used by
   * the file-tree context menu's "Add to Prompt" item so the user can
   * stage an @-reference without typing it manually.
   *
   * If a non-empty buffer doesn't already end with whitespace, a
   * leading space is prepended so the inserted token doesn't fuse to
   * the prior word ("foo" + "@bar" \u2192 "foo @bar"). A trailing space
   * is always appended for the same reason.
   */
  insertText(text: string): void {
    if (text.length === 0) return;
    const sel = this.view.state.selection.main;
    const doc = this.view.state.doc;
    const before = doc.sliceString(0, sel.from);
    const needsLeadingSpace =
      before.length > 0 && !/\s$/.test(before) && sel.from === sel.to;
    const composed = (needsLeadingSpace ? " " : "") + text + " ";
    this.view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: composed },
      selection: { anchor: sel.from + composed.length },
      scrollIntoView: true,
    });
  }

  isAgentMode(): boolean {
    return this.agentMode;
  }

  setAgentMode(on: boolean): void {
    if (this.agentMode === on) return;
    this.agentMode = on;
    this.opts.onToggleAgent?.(on);
    this.notifyChange();
  }

  toggleAgentMode(): void {
    this.toggleAgent();
  }

  /** Tear the editor down (for hot-reloads / dev cleanup). */
  destroy(): void {
    OPTIONS_BY_VIEW.delete(this.view);
    this.view.destroy();
  }

  // -- internals ------------------------------------------------------------

  private toggleAgent(): void {
    this.setAgentMode(!this.agentMode);
  }

  /**
   * Delete back to (and including) the previous `/` in a `/cd` or `@`
   * path. Returns true to consume the keystroke; false to fall through
   * to CodeMirror's default Cmd+Backspace (delete-word-backward).
   *
   * Triggers only when the doc starts with `/cd ` and the cursor is in
   * the path argument, OR when the current word starts with `@`. That
   * keeps Cmd+Backspace working as expected for shell command lines.
   */
  private deletePathSegment(): boolean {
    const sel = this.view.state.selection.main;
    if (!sel.empty) return false;
    const cursor = sel.head;
    const doc = this.view.state.doc.toString();
    const before = doc.slice(0, cursor);

    // /cd argument context: after "/cd " prefix.
    const cdMatch = /^\s*\/cd\s+(.*)$/.exec(before);
    if (cdMatch) {
      const partial = cdMatch[1];
      if (partial.length === 0) return false;
      // Find the previous `/` (excluding a trailing one if present).
      const trimmed = partial.endsWith("/")
        ? partial.slice(0, -1)
        : partial;
      const cutoff = trimmed.lastIndexOf("/");
      const argStart = cursor - partial.length;
      const newCursor = cutoff >= 0 ? argStart + cutoff + 1 : argStart;
      this.view.dispatch({
        changes: { from: newCursor, to: cursor, insert: "" },
        selection: { anchor: newCursor },
      });
      return true;
    }

    // @path context: most recent whitespace-or-start-delimited @-token.
    const atMatch = /(?:^|\s)@([^\s"]*)$/.exec(before);
    if (atMatch) {
      const partial = atMatch[1];
      if (partial.length === 0) return false;
      const trimmed = partial.endsWith("/")
        ? partial.slice(0, -1)
        : partial;
      const cutoff = trimmed.lastIndexOf("/");
      const partialStart = cursor - partial.length;
      const newCursor =
        cutoff >= 0 ? partialStart + cutoff + 1 : partialStart;
      this.view.dispatch({
        changes: { from: newCursor, to: cursor, insert: "" },
        selection: { anchor: newCursor },
      });
      return true;
    }

    return false;
  }

  private currentIntent(): IntentResult {
    const raw = this.getValue();
    const detected = detectIntent(raw);
    if (this.agentMode && !detected.explicit) {
      return { ...detected, intent: "agent" };
    }
    return detected;
  }

  private notifyChange(): void {
    this.opts.onChange?.(this.getValue(), this.currentIntent());
  }

  private submit(): void {
    const text = this.getValue();
    if (text.length === 0) return; // swallow empty submits
    const intent = this.currentIntent();

    // Push into history (dedupe consecutive duplicates).
    if (
      this.historyLog.length === 0 ||
      this.historyLog[this.historyLog.length - 1] !== text
    ) {
      this.historyLog.push(text);
      if (this.historyLog.length > 500) this.historyLog.shift();
    }
    this.historyIndex = null;
    this.draft = "";

    this.opts.onSubmit(text, intent);
    this.setValue("");
  }

  // Arrow-key history. Only triggers when the cursor is on the first/last line
  // so normal multi-line navigation still works.
  private tryHistoryPrev(): boolean {
    const { state } = this.view;
    const cursorLine = state.doc.lineAt(state.selection.main.head).number;
    if (cursorLine !== 1) return false; // let CodeMirror handle normal movement
    if (this.historyLog.length === 0) return false;

    if (this.historyIndex === null) {
      this.draft = this.getValue();
      this.historyIndex = this.historyLog.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return true; // already at oldest
    }
    this.setValue(this.historyLog[this.historyIndex]);
    return true;
  }

  private tryHistoryNext(): boolean {
    const { state } = this.view;
    const lastLine = state.doc.lines;
    const cursorLine = state.doc.lineAt(state.selection.main.head).number;
    if (cursorLine !== lastLine) return false;
    if (this.historyIndex === null) return false;

    if (this.historyIndex < this.historyLog.length - 1) {
      this.historyIndex += 1;
      this.setValue(this.historyLog[this.historyIndex]);
    } else {
      this.historyIndex = null;
      this.setValue(this.draft);
      this.draft = "";
    }
    return true;
  }
}

export type { Intent, IntentResult };

// ---------------------------------------------------------------------------
// Slash command autocomplete source
// ---------------------------------------------------------------------------

/**
 * CodeMirror completion source that fires when the user types `/` at the
 * start of the editor buffer. Offers the full list of slash commands with
 * descriptions. When the user has typed `/model `, it switches to the list
 * of known model aliases.
 */
function slashCompletions(
  context: CompletionContext,
): CompletionResult | Promise<CompletionResult | null> | null {
  const doc = context.state.doc.toString();
  const before = doc.slice(0, context.pos);

  // Sub-completer: after `/model <space>`, suggest model aliases.
  const modelMatch = /^\s*\/model\s+(\S*)$/.exec(before);
  if (modelMatch) {
    const from = context.pos - modelMatch[1].length;
    return {
      from,
      filter: true,
      options: modelCompletions().map((m) => ({
        label: m.label,
        detail: m.detail,
        type: "variable",
      })),
    };
  }

  // Sub-completer: after `/protocol <space>`, suggest recipe ids. Same
  // pattern as the model sub-completer above so the popup feels
  // consistent across slash commands that take a known-set argument.
  const protocolMatch = /^\s*\/protocol\s+(\S*)$/.exec(before);
  if (protocolMatch) {
    const from = context.pos - protocolMatch[1].length;
    return {
      from,
      filter: true,
      options: recipeCompletions().map((r) => ({
        label: r.label,
        detail: r.detail,
        type: "keyword",
      })),
    };
  }

  // Main slash menu. Activate when the buffer starts with `/` and the cursor
  // is within that first token. This avoids popping the menu over e.g. a
  // path typed later in a command line (`/tmp/foo`).
  const slashMatch = /^\s*(\/[A-Za-z]*)$/.exec(before);
  if (slashMatch) {
    const from = context.pos - slashMatch[1].length;
    return {
      from,
      filter: true,
      options: SLASH_COMMANDS.map((c) => ({
        label: c.label,
        detail: c.detail,
        apply: c.takesArg ? `${c.label} ` : c.label,
        type: "keyword",
      })),
    };
  }

  // /cd <folder> autocomplete — folders only. The capture is everything
  // after `/cd `, including spaces (folder names with spaces are valid;
  // we'll quote them when issuing the actual `cd` command at submit).
  const cdMatch = /^\s*\/cd\s+(.*)$/.exec(before);
  if (cdMatch) {
    const partial = cdMatch[1];
    const opts = OPTIONS_BY_VIEW.get(context.view!);
    const cwd = opts?.getCwd?.() ?? "";
    return (async () => {
      // Single helper: list `partial`. When that returns zero matches
      // and there's a typed prefix to blame, fall back to listing the
      // parent directory so the popup stays open with browsable
      // entries instead of dying — user can backspace into recovery
      // or pick a different folder without re-typing the whole path.
      const slashIdx = partial.lastIndexOf("/");
      const dirPart = slashIdx >= 0 ? partial.slice(0, slashIdx + 1) : "";
      const fetchListing = async (q: string) => {
        try {
          return await invoke<{
            dir: string;
            prefix: string;
            entries: Array<{ name: string; kind: string }>;
            truncated: boolean;
          }>("list_dir_entries", { cwd, partial: q });
        } catch {
          return null;
        }
      };
      let listing = await fetchListing(partial);
      let recoveredFrom = false;
      if (listing && listing.entries.filter((e) => e.kind === "dir").length === 0
        && partial !== dirPart) {
        // Bad trailing prefix — re-list the parent directory and replace
        // the failing prefix with whatever the user picks next.
        const parent = await fetchListing(dirPart);
        if (parent) {
          listing = parent;
          recoveredFrom = true;
        }
      }
      if (!listing) return null;
      // Insert/replace range: when we recovered, the replacement covers
      // the bad prefix; otherwise it just covers the prefix portion.
      const prefixLen = partial.length - dirPart.length;
      const from = context.pos - prefixLen;
      // Sentinel option keeps the popup mounted when there are no real
      // matches in the current directory either, so the user can
      // backspace once and recover instead of having to retype.
      const dirEntries = listing.entries.filter((e) => e.kind === "dir");
      if (dirEntries.length === 0) {
        return {
          from,
          filter: false,
          options: [
            {
              label: `(no folders in ${listing.dir})`,
              detail: "",
              type: "text",
              apply: () => {},
            },
          ],
        };
      }
      return {
        from,
        filter: false,
        options: dirEntries.map((e) => {
          const display = e.name + "/";
          return {
            label: display,
            detail: recoveredFrom ? "folder (recovered)" : "folder",
            type: "folder",
            apply: (
              view: EditorView,
              _completion: unknown,
              applyFrom: number,
              applyTo: number,
            ) => {
              view.dispatch({
                changes: { from: applyFrom, to: applyTo, insert: display },
                selection: { anchor: applyFrom + display.length },
              });
              // Drill in: re-open the popup to show this folder's children.
              setTimeout(() => startCompletion(view), 0);
            },
          };
        }),
      };
    })();
  }

  // @path file picker (bare paths only — no spaces). Match `@` at start of
  // line or after whitespace, then any non-whitespace path chars.
  const atMatch = /(?:^|\s)@([^\s"]*)$/.exec(before);
  if (atMatch) {
    const partial = atMatch[1];
    const from = context.pos - partial.length;
    const opts = OPTIONS_BY_VIEW.get(context.view!);
    const cwd = opts?.getCwd?.() ?? "";
    return (async () => {
      try {
        const listing = await invoke<{
          dir: string;
          prefix: string;
          entries: Array<{ name: string; kind: string }>;
          truncated: boolean;
        }>("list_dir_entries", { cwd, partial });

        // The dir portion that should stay in the insertion (everything up
        // to and including the last `/` in `partial`).
        const slashIdx = partial.lastIndexOf("/");
        const dirPart = slashIdx >= 0 ? partial.slice(0, slashIdx + 1) : "";

        return {
          from,
          filter: false, // Rust filtered server-side already.
          options: listing.entries.map((e) => {
            const isDir = e.kind === "dir";
            const display = e.name + (isDir ? "/" : "");
            const fullPath = dirPart + display;
            return {
              label: display,
              detail: isDir ? "folder" : e.kind,
              type: isDir ? "folder" : "file",
              apply: (
                view: EditorView,
                _completion: unknown,
                applyFrom: number,
                applyTo: number,
              ) => {
                view.dispatch({
                  changes: { from: applyFrom, to: applyTo, insert: fullPath },
                  selection: { anchor: applyFrom + fullPath.length },
                });
                // After picking a folder, immediately re-open the menu so
                // the user sees the next level without retyping.
                if (isDir) {
                  setTimeout(() => startCompletion(view), 0);
                }
              },
            };
          }),
        };
      } catch {
        return null;
      }
    })();
  }

  return null;
}
