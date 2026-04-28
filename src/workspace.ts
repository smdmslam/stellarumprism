// A single tab's worth of state and DOM: one shell session, one chat session,
// one xterm, one block manager, one editor, one agent controller.
//
// The TabManager owns an array of these and swaps visibility.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import "@xterm/xterm/css/xterm.css";

import { BlockManager, type Block } from "./blocks";
import { PrismInput } from "./editor";
import type { IntentResult } from "./intent";
import {
  AgentController,
  type AgentImageContext,
  type FullHistoryMessage,
} from "./agent";
import { AgentView } from "./agent-view";
import { resolveModel, renderModelListAnsi, modelSupportsVision } from "./models";
import { renderHelpAnsi } from "./slash-commands";
import { extractFileRefs, resolveFileRefs } from "./file-refs";
import { settings } from "./settings";
import { findMode, type Mode } from "./modes";
import {
  buildVerifiedSystemPrefix,
  detectVerifiedTrigger,
  verifiedKindLabel,
} from "./verified-mode";
import {
  auditReportFilename,
  parseAuditTranscript,
  renderAnsiFindings,
  renderJsonReport,
  renderMarkdownReport,
  type AuditReport,
  type Confidence,
  type Finding,
  type RuntimeProbe,
  type Severity,
  type SubstrateRun,
} from "./findings";
import {
  buildLastBuildIndex,
  buildReportFilename,
  parseBuildReportTranscript,
  renderAnsiBuildReport,
  renderBuildReportJson,
  renderBuildReportMarkdown,
  type BuildReport,
} from "./build-report";
import { buildFixPrompt, filterFindings, parseFixArgs } from "./fix";
import { buildBuildPrompt, parseBuildArgs } from "./build";
import { buildRefactorPrompt, parseRefactorArgs } from "./refactor";
import { buildTestGenPrompt, parseTestGenArgs } from "./test-gen";
import { buildNewPrompt, parseNewArgs } from "./new";
import {
  defaultFilter as defaultProblemsFilter,
  formatRelativeTime,
  parseProblemsArgs,
  renderProblemsPanel,
  toggleConfidence as toggleProblemsConfidence,
  toggleSeverity as toggleProblemsSeverity,
  type ProblemsFilter,
} from "./problems";
import {
  renderSnippet,
  renderSnippetError,
  type FileSnippet,
} from "./snippet";
import { FileEditor, type EditorDiagnostic } from "./file-editor";
import {
  emptyTreeState,
  flattenVisibleRows,
  formatBytes as formatTreeBytes,
  moveSelection,
  setChildren,
  setError as setTreeError,
  setLoading as setTreeLoading,
  setRoot as setTreeRoot,
  setSelected as setTreeSelected,
  toggleExpanded,
  type RawTreeListing,
  type TreeState,
  type VisibleRow,
} from "./file-tree";

const TERM_THEME = {
  background: "#0d0f14",
  foreground: "#e6e6e6",
  cursor: "#7dd3fc",
  cursorAccent: "#0d0f14",
  selectionBackground: "#264f78",
  black: "#1f2937",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e5e7eb",
  brightBlack: "#374151",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fde047",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#f9fafb",
};

export interface WorkspaceCallbacks {
  /** Fired when the auto-title changes (so the tab label can update). */
  onTitleChange: (id: string, title: string) => void;
  /** Fired when the user presses Cmd+W inside the editor. */
  onRequestClose: (id: string) => void;
  /** Fired when the user presses Cmd+T. */
  onRequestNewTab: () => void;
  /** Fired when the user presses Cmd+1..9. */
  onRequestSelectIndex: (index: number) => void;
  /**
   * Fired whenever OSC 7 reports a new shell cwd. Optional; the
   * TabManager subscribes so it can debounce-write the session
   * restore file. No back-pressure; callbacks must be cheap.
   */
  onCwdChange?: (id: string, cwd: string) => void;
}

/** Optional restore hints passed to the Workspace constructor when
 *  rehydrating a tab from `session.json` on app launch. */
export interface WorkspaceRestoreOptions {
  /** Pre-existing tab id from the persisted session. When provided,
   *  the workspace adopts it instead of minting a new uuid so the
   *  agent / pty session ids stay stable across launches. */
  id?: string;
  /** Path to cd into after spawning the shell. Empty / undefined =
   *  let the shell start in its default cwd ($HOME). */
  cwd?: string;
  /** Display title to seed the tab strip with at zero latency,
   *  before any cwd-derived auto-title catches up. */
  title?: string;
}

export class Workspace {
  readonly id: string; // same as PTY session id + agent chat id
  readonly root: HTMLElement;

  private title = "New Tab";
  private cwd = ""; // populated by OSC 7 from the shell integration

  public getId(): string { return this.id; }
  public getCwd(): string { return this.cwd; }
  /** Pending image attachments for the next agent query. */
  private pendingImages: PendingImage[] = [];
  /**
   * Scope string for the currently in-flight audit (e.g. "HEAD~3",
   * "@src/pages", or "" for working tree vs HEAD). Used by
   * handleAuditComplete to tag the generated report. Cleared on
   * completion or error.
   */
  private activeAuditScope: string | null = null;
  /**
   * Most recent audit report parsed in this tab. Drives the Problems
   * panel; null until the user runs `/audit` for the first time.
   * Persists across panel hide/show so toggling re-opens the same
   * findings instead of an empty state.
   */
  private lastAuditReport: AuditReport | null = null;
  /**
   * Feature description (or rename pair / project name / symbol) for
   * the currently in-flight /build, /new, /refactor, or /test-gen turn.
   * Used by handleBuildComplete to tag the persisted report. Cleared
   * on dispatch failure or completion.
   */
  private activeBuildFeature: string | null = null;
  /**
   * Most recent successfully parsed build/new/refactor/test-gen report.
   * Hydrated on first cwd resolution from `<cwd>/.prism/state.json`'s
   * `last_build` pointer; updated after every successful build-family
   * completion.
   */
  private lastBuildReport: BuildReport | null = null;
  /**
   * True once we've attempted to hydrate from `state.json` for the
   * current cwd, so we don't re-hydrate on every OSC 7 prompt tick.
   */
  private workspaceStateHydrated = false;
  /**
   * In-memory layout snapshot, mirrored from `state.json.layout` and
   * pushed back on every drag commit. Defaults match the CSS
   * fallbacks so a fresh workspace renders identically to v0.
   */
  private layout: LayoutPrefs = { ...DEFAULT_LAYOUT };
  /**
   * Tracks the most recently interacted-with divider so the
   * Cmd+Opt+[/] keyboard nudge knows what to move when no divider has
   * DOM focus (e.g. user just released the mouse).
   */
  private lastActiveDivider: DividerKind | null = null;
  /** The currently mounted file editor, if the preview overlay is open. */
  private fileEditor: FileEditor | null = null;
  /**
   * Path of the file the editor is currently bound to (cwd-relative or
   * absolute, exactly as passed to read_file_text). null when no file
   * is open.
   */
  private openFilePath: string | null = null;
  /**
   * On-disk mtime captured at open time, fed back into write_file_text
   * as the optimistic-concurrency token so we abort instead of
   * clobbering an external edit.
   */
  private openFileMtime = 0;
  /**
   * Filter state for the Problems panel. Held on the workspace so a
   * user-toggled chip stays toggled across re-renders.
   */
  private problemsFilter: ProblemsFilter = defaultProblemsFilter();
  /** Whether the Problems panel is currently visible. */
  private problemsVisible = false;
  /**
   * Per-tab session preference for \"render the loaded chat transcript\"
   * after a successful /load. Three states:
   *   null    \u2014 not yet asked this session; show the modal next time
   *   \"always\" \u2014 user ticked \"don't ask again\" with Yes; auto-render
   *   \"never\"  \u2014 user ticked \"don't ask again\" with No; auto-skip
   * Resets on tab close / app restart \u2014 it is intentionally NOT persisted
   * to state.json so the user is re-asked on a new session and isn't
   * surprised by silent re-rendering after a long gap.
   */
  private renderLoadedChatPref: "always" | "never" | null = null;
  /**
   * IDE-shape file-tree state. Owned by the workspace so the tree
   * persists across sidebar-tab switches; rebuilt from scratch only
   * when the cwd changes (rare).
   */
  private treeState: TreeState = emptyTreeState();
  /**
   * Which sidebar pane is visible. "blocks" matches the legacy view;
   * "files" shows the lazy-loaded file tree.
   */
  private activeSidebarTab: "blocks" | "files" = "files";
  /** True iff `refreshFileTreeRoot` has been called for this cwd. */
  private fileTreeRootLoaded = false;
  /** Last cwd we built the tree for, so we can detect cwd changes. */
  private fileTreeLastCwd = "";
  /**
   * Whether the file tree includes hidden dotfiles (`.git`,
   * `.gitignore`, etc.). Default false; toggled by the eye-icon
   * button next to the Files tab. `.prism/` is always shown
   * regardless of this flag (handled by the backend allowlist).
   */
  private showHiddenFiles = false;
  private sidebarVisible = true;
  private previewVisible = true;
  private terminalVisible = true;
  private consoleVisible = true;
  private agentVisible = true;
  private readonly cb: WorkspaceCallbacks;

  private term!: Terminal;
  private fit!: FitAddon;
  private blocks!: BlockManager;
  private input!: PrismInput;
  private agent!: AgentController;
  private agentView!: AgentView;
  private resizeObserver: ResizeObserver | null = null;

  private readonly disposers: UnlistenFn[] = [];
  private disposed = false;
  private initPromise: Promise<void>;

  /** Restore hints captured at construction. Empty {} for fresh tabs. */
  private readonly restore: WorkspaceRestoreOptions;

  constructor(
    parent: HTMLElement,
    cb: WorkspaceCallbacks,
    restore: WorkspaceRestoreOptions = {},
  ) {
    // Use the persisted id when restoring so backend session-keyed
    // resources (chat history, pty session) line up with frontend
    // ids without a remap. Mint a new id only on truly fresh tabs.
    this.id = restore.id ?? cryptoRandomId();
    this.restore = restore;
    this.cb = cb;
    if (restore.title && restore.title.trim().length > 0) {
      this.title = restore.title;
    }

    // Build DOM subtree for this workspace.
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.dataset.id = this.id;
    this.root.innerHTML = `
      <aside class="blocks-sidebar">
        <div class="sidebar-tabs" role="tablist" aria-label="Sidebar">
          <button class="sidebar-tab active" data-tab="files" role="tab" aria-selected="true">Files</button>
          <button class="sidebar-tab" data-tab="blocks" role="tab" aria-selected="false">Blocks <span class="sidebar-tab-count blocks-count">0</span></button>
          <span class="sidebar-tabs-spacer"></span>
          <button class="sidebar-tab-action" data-action="toggle-hidden" type="button" title="Show hidden files (.git, .env, \u2026)" aria-label="Show hidden files" aria-pressed="false">\u25cb</button>
        </div>
        <div class="sidebar-pane sidebar-pane-files" data-tab="files">
          <div class="file-tree" tabindex="0" role="tree" aria-label="Project files"></div>
        </div>
        <div class="sidebar-pane sidebar-pane-blocks" data-tab="blocks" hidden>
          <ul class="blocks-list"></ul>
        </div>
      </aside>
      <div class="layout-divider layout-divider-sidebar" data-divider="sidebar" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize sidebar"></div>
      <div class="content">
        <div class="center-pane">
          <div class="file-preview" data-visible="true" aria-hidden="false">
            <div class="file-preview-empty">No file open</div>
          </div>
          <div class="layout-divider layout-divider-preview" data-divider="preview" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="Resize terminal"></div>
          <div class="terminal-host">
            <div class="terminal-stage"></div>
          </div>
        </div>
        <div class="layout-divider layout-divider-pane" data-divider="pane" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize agent pane"></div>
        <div class="agent-pane">
          <div class="agent-stage" aria-label="Agent dialogue"></div>
          <div class="agent-actions"></div>
          <div class="attachments"></div>
          <div class="input-bar">
            <div class="input-row">
              <div class="editor-host"></div>
            </div>
            <div class="input-meta">
              <span class="input-prefix" data-intent="command">\u276f</span>
              <span class="cwd-badge" title="Current working directory"></span>
              <span class="input-meta-spacer"></span>
              <span class="model-badge" title="Agent model">\u2026</span>
              <button class="busy-pill" type="button" title="Cancel agent request" aria-label="cancel agent request"><span class="busy-dot"></span><span class="busy-label">cancel</span></button>
              <span class="intent-badge" data-intent="command">CMD</span>
            </div>
          </div>
        </div>
      </div>
      <div class="layout-divider layout-divider-problems" data-divider="problems" data-visible="false" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize problems panel"></div>
      <aside class="problems-panel" data-visible="false" aria-hidden="true"></aside>
      <div class="confirm-dialog" data-visible="false" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-hidden="true">
        <div class="confirm-dialog-card">
          <h2 class="confirm-dialog-title" id="confirm-dialog-title"></h2>
          <p class="confirm-dialog-body"></p>
          <label class="confirm-dialog-remember">
            <input type="checkbox" data-confirm-remember />
            <span>Don\u2019t ask again this session</span>
          </label>
          <div class="confirm-dialog-actions">
            <button class="confirm-dialog-btn confirm-dialog-btn-no" type="button" data-confirm="no">No</button>
            <button class="confirm-dialog-btn confirm-dialog-btn-yes" type="button" data-confirm="yes">Yes</button>
          </div>
        </div>
      </div>
    `;
    parent.appendChild(this.root);

    this.initPromise = this.init();
  }

  // -- lifecycle ------------------------------------------------------------

  get ready(): Promise<void> {
    return this.initPromise;
  }

  getTitle(): string {
    return this.title;
  }

  /** Has the user accumulated anything worth prompting to save? */
  hasContent(): boolean {
    return (this.agent?.getMessageCount() ?? 0) > 0;
  }

  activate(): void {
    this.root.classList.add("active");
    this.fitTerminal();
    queueMicrotask(() => this.input?.focus());
  }

  deactivate(): void {
    this.root.classList.remove("active");
  }

  /** Focus the input editor, optionally seeding it with text. */
  focusInput(initialValue?: string): void {
    if (initialValue !== undefined) {
      this.input.setValue(initialValue);
    }
    this.input.focus();
  }

  public getLayoutState(): { sidebar: boolean; preview: boolean; terminal: boolean; console: boolean; problems: boolean; agent: boolean } {
    return {
      sidebar: this.sidebarVisible,
      preview: this.previewVisible,
      terminal: this.terminalVisible,
      console: this.consoleVisible,
      problems: this.problemsVisible,
      agent: this.agentVisible,
    };
  }

  public toggleSidebar(): void {
    this.sidebarVisible = !this.sidebarVisible;
    this.root.classList.toggle("sidebar-hidden", !this.sidebarVisible);
    this.fitTerminal();
  }

  public togglePreview(): void {
    this.previewVisible = !this.previewVisible;
    this.root.classList.toggle("preview-hidden", !this.previewVisible);
    if (this.terminalVisible) this.fitTerminal();
  }

  public toggleTerminal(): void {
    this.terminalVisible = !this.terminalVisible;
    this.root.classList.toggle("terminal-hidden", !this.terminalVisible);
    if (this.terminalVisible) this.fitTerminal();
  }

  public toggleConsole(): void {
    this.consoleVisible = !this.consoleVisible;
    this.root.classList.toggle("console-hidden", !this.consoleVisible);
  }

  public toggleAgent(): void {
    this.agentVisible = !this.agentVisible;
    this.root.classList.toggle("agent-hidden", !this.agentVisible);
    this.fitTerminal();
  }

  public toggleProblems(): void {
    if (this.problemsVisible) {
      this.hideProblemsPanel();
    } else {
      this.showProblemsPanel();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.disposers) off();
    try {
      await invoke("kill_shell", { sessionId: this.id });
    } catch { /* best-effort */ }
    try {
      await invoke("agent_drop_session", { chatId: this.id });
    } catch { /* best-effort */ }
    this.agent?.destroy();
    this.input?.destroy();
    this.resizeObserver?.disconnect();
    this.term?.dispose();
    this.root.remove();
  }

  // -- init -----------------------------------------------------------------

  private async init(): Promise<void> {
    // xterm mounts into the inner `.terminal-stage`; the outer
    // `.terminal-host` is just chrome (background, left padding) and
    // never has anything queried off it during init.
    const stage = this.root.querySelector<HTMLDivElement>(".terminal-stage")!;

    this.term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: settings.getTerminalFontSize(),
      lineHeight: 1.2,
      cursorBlink: true,
      theme: TERM_THEME,
      scrollback: 10000,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    // xterm mounts into the inner `.terminal-stage` (not `.terminal-host`)
    // so its renderable width is the stage's width, which is narrower than
    // the host by a real `margin-right`. This makes FitAddon's column math
    // and xterm's cell rendering agree with a hard layout boundary, instead
    // of fighting macOS WebKit overlay-scrollbar geometry.
    this.term.open(stage);
    this.fit.fit();

    this.blocks = new BlockManager(this.term);
    this.wireBlockSidebar();
    this.wireSidebarTabs();
    this.wireFileTree();

    // OSC 7: the shell (via our zsh integration) tells us its cwd on every
    // prompt. We parse `file://host/path` and keep the last value.
    this.term.parser.registerOscHandler(7, (data) => {
      const parsed = parseOsc7(data);
      if (parsed && parsed !== this.cwd) {
        this.cwd = parsed;
        this.updateCwdBadge();
        // Notify the TabManager so it can debounce-persist the
        // session restore file. Wrapped in try/catch because a
        // single-tab cwd update must never take down the OSC handler.
        try {
          this.cb.onCwdChange?.(this.id, parsed);
        } catch (e) {
          console.error("onCwdChange threw", e);
        }
        // cwd changed \u2014 the file tree is now stale. We don't proactively
        // re-fetch (might be a transient `cd`); the next time the Files
        // tab is shown, it'll lazy-load.
        if (this.fileTreeLastCwd !== parsed) {
          this.fileTreeRootLoaded = false;
          if (this.activeSidebarTab === "files") {
            void this.refreshFileTreeRoot();
          }
        }
        // First time we know the cwd, try to rehydrate the workspace
        // spine (last audit + last build) from state.json. Subsequent
        // cwd changes (rare; user typed `cd`) re-trigger hydration so
        // the panel reflects the new project.
        if (!this.workspaceStateHydrated) {
          void this.hydrateWorkspaceState();
        }
      }
      return true;
    });

    // Spawn PTY sized to the current viewport. We pass our pre-generated id
    // so that Rust uses it rather than minting its own — keeps pty session id,
    // agent chat id, and workspace id in lockstep.
    try {
      await invoke<string>("spawn_shell", {
        sessionId: this.id,
        cols: this.term.cols,
        rows: this.term.rows,
      });
    } catch (err) {
      this.term.writeln(
        `\x1b[1;31mFailed to start shell:\x1b[0m ${String(err)}`,
      );
      return;
    }

    // Session restore: if this tab is being rehydrated from
    // session.json with a saved cwd, inject a `cd <path>` into the
    // freshly-spawned shell. The shell processes it as if the user
    // had typed it; OSC 7 fires naturally on the next prompt and
    // updates `this.cwd` via the handler above. Quoting handles
    // paths containing spaces or apostrophes via the standard
    // POSIX single-quote-with-escape pattern.
    //
    // We deliberately don't validate the path here \u2014 if the saved
    // project moved or was deleted, the shell prints `cd: no such
    // file or directory: ...` which is the correct, debuggable
    // signal. Forwarding to home would silently mask the problem.
    if (this.restore.cwd && this.restore.cwd.trim().length > 0) {
      const cwd = this.restore.cwd;
      const escaped = cwd.replace(/'/g, `'\\''`);
      void invoke("write_to_shell", {
        sessionId: this.id,
        data: `cd '${escaped}'\r`,
      });
    }

    this.disposers.push(
      await listen<string>(`pty-output-${this.id}`, (e) => {
        // After the agent / shell surface split, xterm only ever sees
        // shell traffic, so PTY output streams straight through with
        // no interleave-guard buffering.
        this.term.write(e.payload);
      }),
      await listen(`pty-exit-${this.id}`, () => {
        this.term.writeln("\r\n\x1b[2m[shell exited]\x1b[0m");
      }),
    );

    this.term.onData((data) => {
      void invoke("write_to_shell", { sessionId: this.id, data });
    });
    this.term.onResize(({ cols, rows }) => {
      void invoke("resize_shell", { sessionId: this.id, cols, rows });
    });

    this.resizeObserver = new ResizeObserver(() => {
      // fitTerminal() rAFs internally, so we don't double-defer here.
      this.fitTerminal();
    });
    // Observe the stage (xterm's actual mount node), not the outer host:
    // host width changes that don't change stage width (e.g. host padding
    // tweaks) shouldn't trigger refits, and stage width is what FitAddon
    // actually measures.
    this.resizeObserver.observe(stage);

    // Agent + editor.
    // xterm is now strictly for shell I/O. Agent dialogue (prose,
    // tool log, headers, footers, errors) renders into the DOM
    // panel via AgentView, which uses standard CSS for word-aware
    // wrap and resize-friendly layout.
    const agentStageEl = this.root.querySelector<HTMLElement>(".agent-stage");
    this.agentView = new AgentView(agentStageEl ?? this.root);
    this.agent = new AgentController({
      view: this.agentView,
      blocks: this.blocks,
      sessionId: this.id,
      chatId: this.id,
      scopeEl: this.root,
      getCwd: () => this.cwd,
      onModelChange: () => this.updateModelBadge(),
      onSessionChange: () => this.updateModelBadge(),
      onBusyChange: (busy) => this.setBusyState(busy),
      onStall: () => this.setStalledState(true),
      onAuditComplete: (info) => this.handleAuditComplete(info),
      onBuildComplete: (info) => this.handleBuildComplete(info),
    });
    this.setupEditor();
    this.setupAttachments();
    this.setupSlashFocusHijack();
    this.setupBusyPill();
    this.setupProblemsPanel();
    this.setupLayoutDividers();
    this.setupFileEditorKeybindings();
    this.updateModelBadge();

    const handleSettingsChange = () => {
      if (this.term) {
        if (this.term.options.fontSize !== settings.getTerminalFontSize()) {
          this.term.options.fontSize = settings.getTerminalFontSize();
          requestAnimationFrame(() => this.fitTerminal());
        }
      }
    };
    window.addEventListener("prism-settings-changed", handleSettingsChange);
    this.disposers.push(() => window.removeEventListener("prism-settings-changed", handleSettingsChange));
  }

  /**
   * Fit xterm to the current `.terminal-stage` content box. The right
   * gutter is enforced by the inner `.terminal-stage` width (a real
   * `margin-right` on the mount node), so FitAddon's measurement
   * reflects the actual renderable text area and xterm cells wrap
   * before the scrollbar. Defers to `requestAnimationFrame` so layout
   * has settled (post-resize, post-tab-switch, post-divider-drag)
   * before FitAddon reads widths.
   *
   * Replaces the older padding-on-host / column-shaving approaches
   * that fudged a gutter \u2014 those disagreed with macOS overlay
   * scrollbars and produced text-under-scrollbar bugs.
   */
  private fitTerminal(): void {
    if (!this.fit || !this.term) return;
    const host = this.root.querySelector<HTMLDivElement>(".terminal-stage");
    if (!host) return;
    if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
    requestAnimationFrame(() => {
      try {
        this.fit.fit();
      } catch {
        // FitAddon throws if the terminal is disposed mid-frame (tab
        // close while a resize is in flight). Best-effort; the next
        // ResizeObserver tick will retry against the live state.
      }
    });
  }

  // -- editor + slash commands ---------------------------------------------

  private setupEditor(): void {
    const editorHost = this.root.querySelector<HTMLDivElement>(".editor-host")!;
    const prefixEl = this.root.querySelector<HTMLElement>(".input-prefix")!;
    const badgeEl = this.root.querySelector<HTMLElement>(".intent-badge")!;

    const reflectIntent = (intent: IntentResult, agentMode: boolean) => {
      prefixEl.setAttribute("data-intent", intent.intent);
      badgeEl.setAttribute("data-intent", intent.intent);
      badgeEl.textContent =
        intent.intent === "agent" ? (agentMode ? "AGENT*" : "AGENT") : "CMD";
      prefixEl.textContent = intent.intent === "agent" ? "\u2732" : "\u276f";
    };

    const isShellBusy = () =>
      this.blocks
        .getBlocks()
        .some((b) => b.status === "running" && b.command.trim().length > 0);

    this.input = new PrismInput(editorHost, {
      onSubmit: (text, intent) => this.handleSubmit(text, intent),
      onChange: (_text, intent) =>
        reflectIntent(intent, this.input.isAgentMode()),
      onToggleAgent: (agentMode) => {
        reflectIntent(
          { intent: agentMode ? "agent" : "command", explicit: false, payload: "" },
          agentMode,
        );
      },
      onControlKey: (key) => {
        const hasDraft = this.input.getValue().length > 0;
        if (hasDraft) return false;
        // Agent gets first claim on Ctrl+C / Ctrl+D when a request is
        // in flight. Without this carve-out the user has no keyboard
        // way out of a model degeneracy loop ([PAD] streams, runaway
        // tool rounds, etc.) \u2014 they'd have to hit the busy-pill with
        // the mouse, which doesn't work if the pill stops repainting.
        if ((key === "SIGINT" || key === "EOF") && this.agent?.isBusy()) {
          this.agent.cancel();
          this.agentView?.appendError(
            `[agent] cancelled by ^${key === "SIGINT" ? "C" : "D"}`,
          );
          this.agentView?.endTurn();
          return true;
        }
        if (key === "EOF" && !isShellBusy()) return false;
        const byte = key === "SIGINT" ? "\x03" : key === "EOF" ? "\x04" : "\x1a";
        void invoke("write_to_shell", { sessionId: this.id, data: byte });
        return true;
      },
      // Let the @path autocomplete source ask for our current cwd on demand.
      getCwd: () => this.cwd,
    });

    // Click anywhere in the input bar (but outside the badges) refocuses.
    // Critical carve-out: skip the manual refocus when the click is
    // already inside the editor itself. CodeMirror handles its own
    // focus-on-click natively, and a focus() call landing mid-drag on
    // a contenteditable surface collapses any in-progress text
    // selection on WebKit/macOS \u2014 which broke drag-select inside the
    // prompt area. The manual refocus is still useful when the user
    // clicks the surrounding chrome (prefix glyph, cwd-badge area,
    // input-bar padding) so clicks 'near' the editor still land focus.
    this.root.querySelector(".input-bar")?.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("intent-badge") || t.classList.contains("model-badge")) return;
      if (t.closest(".editor-host")) return;
      queueMicrotask(() => this.input.focus());
    });

    // Global-feel keyboard shortcuts when the editor is focused.
    editorHost.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        this.cb.onRequestNewTab();
      } else if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        this.cb.onRequestClose(this.id);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        this.cb.onRequestSelectIndex(Number(e.key) - 1);
      }
    });
  }

  private handleSubmit(text: string, intent: IntentResult): void {
    // Slash commands (order matters).
    if (/^\s*\/models\s*$/i.test(text)) {
      this.term.write("\r\n" + renderModelListAnsi(this.agent.getModel()));
      return;
    }
    if (/^\s*\/(new|clear)\s*$/i.test(text)) {
      void this.agent.newSession().then(() => {
        this.term.write("\r\n\x1b[2m[agent] new session \u2014 history cleared\x1b[0m\r\n");
      });
      return;
    }
    if (/^\s*\/history\s*$/i.test(text)) {
      void this.agent.getHistory().then((msgs) => {
        this.term.write("\r\n" + renderHistoryAnsi(msgs));
      });
      return;
    }
    // /save [full] \u2014 write a markdown chat artifact. Default mode is
    // a clean human-readable transcript (user + assistant prose only).
    // `/save full` (or `/save --full`) writes the v2 tool-aware format
    // with assistant tool_calls + role=tool results preserved, so the
    // saved chat is replay-ready by another model.
    const saveMatch = /^\s*\/save(?:\s+(.*))?$/i.exec(text);
    if (saveMatch) {
      const arg = (saveMatch[1] ?? "").trim().toLowerCase();
      const full = arg === "full" || arg === "--full" || arg === "-f";
      void this.saveChat(full);
      return;
    }
    // /load \u2014 round-trip companion to /save. Opens a file picker,
    // parses the chosen Prism chat markdown, and seeds THIS tab's
    // session with the loaded messages. Existing in-memory history is
    // overwritten; user should /save first if they care.
    if (/^\s*\/load\s*$/i.test(text)) {
      void this.loadChat();
      return;
    }
    if (/^\s*\/help\s*$/i.test(text)) {
      this.term.write("\r\n" + renderHelpAnsi());
      return;
    }
    // /files \u2014 switch sidebar to the Files tab and focus the tree.
    if (/^\s*\/files\s*$/i.test(text)) {
      this.setSidebarTab("files");
      this.term.write(
        `\r\n\x1b[2m[files] sidebar \u2192 Files tab\x1b[0m\r\n`,
      );
      return;
    }
    // /last \u2014 print a compact summary of the persisted workspace
    // state (last audit + last build pointers).
    if (/^\s*\/last\s*$/i.test(text)) {
      this.term.write(this.renderLastAnsi());
      return;
    }
    // /verify on|off|<model> — control the reviewer pass.
    const verifyMatch = /^\s*\/verify(?:\s+(.*))?$/i.exec(text);
    if (verifyMatch) {
      const arg = (verifyMatch[1] ?? "").trim();
      void this.handleVerifyCommand(arg);
      return;
    }
    // /cd <path> — issue a real `cd` to the shell with shell-safe quoting.
    const cdSlash = /^\s*\/cd\s+(.+)$/i.exec(text);
    if (cdSlash) {
      const target = cdSlash[1].trim();
      // Single-quote the path; escape any embedded single quotes by closing
      // the quote, inserting an escaped quote, and re-opening.
      const quoted = `'${target.replace(/'/g, "'\\''")}'`;
      void invoke("write_to_shell", {
        sessionId: this.id,
        data: `cd ${quoted}\n`,
      });
      return;
    }
    const modelArg = /^\s*\/model\s+(\S.*)$/i.exec(text);
    if (modelArg) {
      const resolved = resolveModel(modelArg[1].trim());
      if (!resolved) {
        this.term.write(
          `\r\n\x1b[1;31m[agent]\x1b[0m unknown model "${sanitize(modelArg[1])}". \x1b[2m/models for list.\x1b[0m\r\n`,
        );
        return;
      }
      void this.agent.setModel(resolved);
      this.term.write(`\r\n\x1b[2m[agent] model set to ${sanitize(resolved)}\x1b[0m\r\n`);
      return;
    }

    // /build [--max-rounds=N] <feature description> — substrate-gated
    // generation. Drives plan → verify → iterate using the same agent
    // loop as /audit and /fix, with a higher round budget. Each edit
    // goes through the existing approval flow.
    const buildMatch = /^\s*\/build(?:\s+(.*))?$/i.exec(text);
    if (buildMatch) {
      const rawArgs = (buildMatch[1] ?? "").trim();
      const mode = findMode("/build");
      if (!mode) {
        this.term.write(
          `\r\n\x1b[1;31m[build]\x1b[0m mode registry misconfigured\r\n`,
        );
        return;
      }
      const parsed = parseBuildArgs(rawArgs);
      if (parsed.error) {
        this.term.write(
          `\r\n\x1b[1;31m[build]\x1b[0m ${sanitize(parsed.error)}\r\n`,
        );
        return;
      }
      const buildPrompt = buildBuildPrompt(parsed.feature);
      this.setTitleFromText(`build: ${parsed.feature}`);
      this.activeBuildFeature = parsed.feature;
      this.term.write(
        `\r\n\x1b[2m[build] starting substrate-gated build of \x1b[36m${sanitize(parsed.feature)}\x1b[0m\r\n`,
      );
      void this.dispatchAgentQuery(buildPrompt, {
        mode: mode.name,
        modelOverride: mode.preferredModel,
        maxToolRounds: parsed.maxToolRounds,
      });
      return;
    }

    // /fix [selector] [--max-rounds=N] [--report=path] — Second Pass Fix.
    // Reads the latest audit JSON sidecar (or the report at --report=path),
    // filters findings by selector ('all', '1,3', '1-5', '#F2'), and
    // dispatches a fix-mode agent that applies each one through the
    // existing edit_file approval flow.
    const fixMatch = /^\s*\/fix(?:\s+(.*))?$/i.exec(text);
    if (fixMatch) {
      const rawArgs = (fixMatch[1] ?? "").trim();
      const mode = findMode("/fix");
      if (!mode) {
        this.term.write(
          `\r\n\x1b[1;31m[fix]\x1b[0m mode registry misconfigured\r\n`,
        );
        return;
      }
      void this.handleFixCommand(rawArgs, mode);
      return;
    }

    // /audit [scope] [--max-rounds=N] — Second Pass mode. Scope (optional)
    // is appended to the user message as context the auditor can use to
    // narrow focus, e.g. '/audit HEAD~3' → 'Audit the diff HEAD~3..HEAD.'
    // --max-rounds=N raises the tool-call ceiling for THIS turn only,
    // without touching `agent.max_tool_rounds` in config.toml.
    const auditMatch = /^\s*\/(audit|second-pass)(?:\s+(.*))?$/i.exec(text);
    if (auditMatch) {
      const rawArgs = (auditMatch[2] ?? "").trim();
      const mode = findMode("/audit");
      if (!mode) {
        // Shouldn't happen — audit is in the registry. Defensive fallback.
        this.term.write(
          `\r\n\x1b[1;31m[audit]\x1b[0m mode registry misconfigured\r\n`,
        );
        return;
      }
      const { scope, maxToolRounds, error } = parseAuditArgs(rawArgs);
      if (error) {
        this.term.write(
          `\r\n\x1b[1;31m[audit]\x1b[0m ${sanitize(error)}\r\n`,
        );
        return;
      }
      const auditPrompt = buildAuditPrompt(scope);
      this.setTitleFromText(`audit ${scope || "(working tree)"}`);
      // Remember the scope so handleAuditComplete can tag the report.
      this.activeAuditScope = scope || null;
      void this.dispatchAgentQuery(auditPrompt, {
        mode: mode.name,
        modelOverride: mode.preferredModel,
        maxToolRounds,
      });
      return;
    }

    // /problems [show|hide|toggle|clear] — drive the Problems panel.
    const problemsMatch = /^\s*\/problems(?:\s+(.*))?$/i.exec(text);
    if (problemsMatch) {
      this.handleProblemsCommand((problemsMatch[1] ?? "").trim());
      return;
    }

    // /new <project-name> <stack description> [--into=<dir>] [--max-rounds=N]
    //   \u2014 substrate-gated project scaffolder. Bare `/new` (no args)
    //   was already handled above as 'clear conversation history', so
    //   this branch only fires when args are present (the regex requires
    //   at least one whitespace + non-empty tail).
    const newScaffoldMatch = /^\s*\/new\s+(\S.*)$/i.exec(text);
    if (newScaffoldMatch) {
      const rawArgs = newScaffoldMatch[1].trim();
      const mode = findMode("/new");
      if (!mode) {
        this.term.write(
          `\r\n\x1b[1;31m[new]\x1b[0m mode registry misconfigured\r\n`,
        );
        return;
      }
      const parsed = parseNewArgs(rawArgs);
      if (parsed.error) {
        this.term.write(
          `\r\n\x1b[1;31m[new]\x1b[0m ${sanitize(parsed.error)}\r\n`,
        );
        return;
      }
      const newPrompt = buildNewPrompt({
        projectName: parsed.projectName,
        description: parsed.description,
        into: parsed.into,
      });
      const target = parsed.into ?? `${parsed.projectName}/`;
      this.setTitleFromText(`new ${parsed.projectName}`);
      this.activeBuildFeature = parsed.description
        ? `${parsed.projectName} (${parsed.description})`
        : parsed.projectName;
      this.term.write(
        `\r\n\x1b[2m[new] scaffolding \x1b[36m${sanitize(parsed.projectName)}\x1b[0m\x1b[2m into \x1b[36m${sanitize(target)}\x1b[0m${parsed.description ? `\x1b[2m \u2014 \x1b[36m${sanitize(parsed.description)}\x1b[0m` : ""}\x1b[0m\r\n`,
      );
      void this.dispatchAgentQuery(newPrompt, {
        mode: mode.name,
        modelOverride: mode.preferredModel,
        maxToolRounds: parsed.maxToolRounds,
      });
      return;
    }

    // /test-gen <symbol> [--file=path] [--framework=name] [--max-rounds=N]
    const testGenMatch = /^\s*\/(?:test-gen|testgen)(?:\s+(.*))?$/i.exec(text);
    if (testGenMatch) {
      const rawArgs = (testGenMatch[1] ?? "").trim();
      const mode = findMode("/test-gen");
      if (!mode) {
        this.term.write(
          `\r\n\x1b[1;31m[test-gen]\x1b[0m mode registry misconfigured\r\n`,
        );
        return;
      }
      const parsed = parseTestGenArgs(rawArgs);
      if (parsed.error) {
        this.term.write(
          `\r\n\x1b[1;31m[test-gen]\x1b[0m ${sanitize(parsed.error)}\r\n`,
        );
        return;
      }
      const testGenPrompt = buildTestGenPrompt({
        symbol: parsed.symbol,
        file: parsed.file,
        framework: parsed.framework,
      });
      this.setTitleFromText(`test-gen ${parsed.symbol}`);
      this.activeBuildFeature = parsed.framework
        ? `${parsed.symbol} (${parsed.framework})`
        : parsed.symbol;
      this.term.write(
        `\r\n\x1b[2m[test-gen] generating tests for \x1b[36m${sanitize(parsed.symbol)}\x1b[0m\x1b[2m${parsed.file ? ` in \x1b[36m${sanitize(parsed.file)}\x1b[0m\x1b[2m` : ""}${parsed.framework ? ` (\x1b[36m${sanitize(parsed.framework)}\x1b[0m\x1b[2m)` : ""}\x1b[0m\r\n`,
      );
      void this.dispatchAgentQuery(testGenPrompt, {
        mode: mode.name,
        modelOverride: mode.preferredModel,
        maxToolRounds: parsed.maxToolRounds,
      });
      return;
    }

    // /refactor <oldName> <newName> [--scope=path] [--max-rounds=N]
    const refactorMatch = /^\s*\/refactor(?:\s+(.*))?$/i.exec(text);
    if (refactorMatch) {
      const rawArgs = (refactorMatch[1] ?? "").trim();
      const mode = findMode("/refactor");
      if (!mode) {
        this.term.write(
          `\r\n\x1b[1;31m[refactor]\x1b[0m mode registry misconfigured\r\n`,
        );
        return;
      }
      const parsed = parseRefactorArgs(rawArgs);
      if (parsed.error) {
        this.term.write(
          `\r\n\x1b[1;31m[refactor]\x1b[0m ${sanitize(parsed.error)}\r\n`,
        );
        return;
      }
      const refactorPrompt = buildRefactorPrompt({
        oldName: parsed.oldName,
        newName: parsed.newName,
        scope: parsed.scope,
      });
      this.setTitleFromText(
        `refactor ${parsed.oldName} \u2192 ${parsed.newName}`,
      );
      this.activeBuildFeature = `${parsed.oldName} \u2192 ${parsed.newName}${parsed.scope ? ` in ${parsed.scope}` : ""}`;
      this.term.write(
        `\r\n\x1b[2m[refactor] renaming \x1b[36m${sanitize(parsed.oldName)}\x1b[0m\x1b[2m \u2192 \x1b[36m${sanitize(parsed.newName)}\x1b[0m\x1b[2m${parsed.scope ? ` in \x1b[36m${sanitize(parsed.scope)}\x1b[0m\x1b[2m` : ""}\x1b[0m\r\n`,
      );
      void this.dispatchAgentQuery(refactorPrompt, {
        mode: mode.name,
        modelOverride: mode.preferredModel,
        maxToolRounds: parsed.maxToolRounds,
      });
      return;
    }

    if (intent.intent === "agent") {
      this.setTitleFromText(intent.payload);
      void this.dispatchAgentQuery(intent.payload);
      return;
    }

    // Shell command.
    this.setTitleFromText(intent.payload);
    void invoke("write_to_shell", {
      sessionId: this.id,
      data: intent.payload + "\n",
    });
  }

  private async handleVerifyCommand(arg: string): Promise<void> {
    const v = this.agent.getVerifier();
    if (arg === "" || arg === "status") {
      this.term.write(
        `\r\n\x1b[2m[verify]\x1b[0m ${v.enabled ? "\x1b[32mon\x1b[0m" : "\x1b[31moff\x1b[0m"}, model = \x1b[36m${sanitize(v.model)}\x1b[0m\r\n`,
      );
      return;
    }
    if (/^off|disable|disabled|no|0$/i.test(arg)) {
      await this.agent.setVerifierEnabled(false);
      this.term.write(`\r\n\x1b[2m[verify] off\x1b[0m\r\n`);
      return;
    }
    if (/^on|enable|enabled|yes|1$/i.test(arg)) {
      await this.agent.setVerifierEnabled(true);
      this.term.write(`\r\n\x1b[2m[verify] on\x1b[0m\r\n`);
      return;
    }
    // Anything else — treat as model alias or slug.
    const resolved = resolveModel(arg);
    if (!resolved) {
      this.term.write(
        `\r\n\x1b[1;31m[verify]\x1b[0m unknown arg "${sanitize(arg)}". Try on / off / <model alias>.\r\n`,
      );
      return;
    }
    await this.agent.setVerifierModel(resolved);
    this.term.write(
      `\r\n\x1b[2m[verify] reviewer model = ${sanitize(resolved)}\x1b[0m\r\n`,
    );
  }

  /**
   * Driver for `/fix [selector] [--max-rounds=N] [--report=path]`.
   *
   * Steps:
   *   1. Parse args (selector + flags).
   *   2. Load the audit JSON sidecar via the Rust side
   *      (`read_latest_audit_report`).
   *   3. Filter findings by selector. Bail out cleanly if the selector
   *      matches nothing.
   *   4. Build the fix-mode user prompt and dispatch with mode='fix'.
   *
   * The fix-mode system prompt + the existing `edit_file` approval flow
   * handle the actual edits; this function is purely the substrate-to-
   * consumer glue.
   */
  private async handleFixCommand(rawArgs: string, mode: Mode): Promise<void> {
    const parsed = parseFixArgs(rawArgs);
    if (parsed.error) {
      this.term.write(
        `\r\n\x1b[1;31m[fix]\x1b[0m ${sanitize(parsed.error)}\r\n`,
      );
      return;
    }
    if (!this.cwd) {
      this.term.write(
        `\r\n\x1b[1;33m[fix]\x1b[0m cwd unknown; cannot locate audit reports\r\n`,
      );
      return;
    }

    let lookup: { path: string; content: string; bytes: number };
    try {
      lookup = await invoke<{ path: string; content: string; bytes: number }>(
        "read_latest_audit_report",
        { cwd: this.cwd, path: parsed.reportPath ?? null },
      );
    } catch (e) {
      this.term.write(
        `\r\n\x1b[1;31m[fix]\x1b[0m ${sanitize(String(e))}\r\n`,
      );
      return;
    }

    let report: AuditReport;
    try {
      report = JSON.parse(lookup.content) as AuditReport;
    } catch (e) {
      this.term.write(
        `\r\n\x1b[1;31m[fix]\x1b[0m failed to parse ${sanitize(prettyPath(lookup.path))}: ${sanitize(String(e))}\r\n`,
      );
      return;
    }

    const filterResult = filterFindings(
      report.findings,
      parsed.selector,
      parsed.include,
    );
    if (filterResult.error) {
      this.term.write(
        `\r\n\x1b[1;31m[fix]\x1b[0m ${sanitize(filterResult.error)} (report: ${sanitize(prettyPath(lookup.path))})\r\n`,
      );
      return;
    }
    const selected = filterResult.findings;
    if (selected.length === 0) {
      this.term.write(
        `\r\n\x1b[2m[fix]\x1b[0m nothing to fix \u2014 ${sanitize(prettyPath(lookup.path))} has 0 findings\r\n`,
      );
      return;
    }

    const fixPrompt = buildFixPrompt(report, selected, lookup.path);
    this.setTitleFromText(
      `fix ${selected.length}/${report.findings.length} from latest audit`,
    );
    this.term.write(
      `\r\n\x1b[2m[fix] applying \x1b[36m${selected.length}\x1b[0m\x1b[2m of \x1b[36m${report.findings.length}\x1b[0m\x1b[2m findings from \x1b[36m${sanitize(prettyPath(lookup.path))}\x1b[0m\r\n`,
    );
    void this.dispatchAgentQuery(fixPrompt, {
      mode: mode.name,
      modelOverride: mode.preferredModel,
      maxToolRounds: parsed.maxToolRounds,
    });
  }

  /**
   * Resolve any `@path` file references in the prompt, print a status
   * summary in xterm, and hand the result to the agent along with any
   * pending image attachments.
   *
   * `options.mode` + `options.modelOverride` + `options.maxToolRounds`
   * are forwarded straight to agent.query() for mode-based turns
   * (e.g. /audit, optionally with --max-rounds).
   */
  private async dispatchAgentQuery(
    prompt: string,
    options: {
      mode?: string;
      modelOverride?: string;
      maxToolRounds?: number;
    } = {},
  ): Promise<void> {
    // Grounded-Chat protocol: when this is a regular chat turn (no
    // mode-specific persona like /audit, /fix, /build active) and the
    // prompt looks like an inspectable factual question, send the
    // rigor scaffold as a per-turn SYSTEM PREFIX so the model is
    // forced to source \u2192 evidence \u2192 rule \u2192 working \u2192 verified
    // label before answering. Mode-driven turns already carry their
    // own stricter protocols and are skipped to avoid double-wrapping.
    //
    // Earlier shape pre-pended the scaffold to the user message,
    // which then got persisted into session history every triggered
    // turn. Three grounded turns = three full copies of the ~150-line
    // scaffold in `messages[]`, which (a) bloated context, (b)
    // contaminated saved chats, and (c) on Kimi K2.5 specifically
    // produced silent empty completions on retry. The system-prefix
    // path sends the scaffold to the model on the wire only and never
    // writes it to history.
    let systemPrefix: string | undefined;
    if (!options.mode) {
      const trigger = detectVerifiedTrigger(prompt);
      if (trigger) {
        systemPrefix = buildVerifiedSystemPrefix(trigger);
        this.term.write(
          `\r\n\x1b[2m\u2192 [grounded-chat] ${verifiedKindLabel(trigger.kind)} protocol active (matched \u201c${sanitize(trigger.matched)}\u201d)\x1b[0m\r\n`,
        );
      }
    }

    const refs = extractFileRefs(prompt);
    const { resolved, errors } =
      refs.length > 0
        ? await resolveFileRefs(refs, this.cwd)
        : { resolved: [], errors: [] };

    // Pull pending images out of the workspace so they're scoped to this turn.
    const images = this.takePendingImages();
    if (images.length > 0 && !modelSupportsVision(this.agent.getModel())) {
      this.term.write(
        `\r\n\x1b[1;33m[images]\x1b[0m model \x1b[36m${sanitize(this.agent.getModel())}\x1b[0m doesn't support images \u2014 sending text only\r\n`,
      );
    }

    // Announce attachments in xterm so the user sees what's going out.
    const parts: string[] = [];
    if (resolved.length > 0) {
      const names = resolved
        .map((r) => `\x1b[36m${sanitize(r.original)}\x1b[0m${r.truncated ? " \x1b[33m(truncated)\x1b[0m" : ""}`)
        .join(", ");
      parts.push(`\x1b[2m[attached]\x1b[0m ${names}`);
    }
    if (images.length > 0 && modelSupportsVision(this.agent.getModel())) {
      parts.push(`\x1b[2m[images]\x1b[0m ${images.length} attached`);
    }
    for (const e of errors) {
      parts.push(
        `\x1b[1;31m[@${sanitize(e.original)}]\x1b[0m ${sanitize(e.error)}`,
      );
    }
    if (parts.length > 0) {
      this.term.write("\r\n" + parts.join("\r\n") + "\r\n");
    }

    const imagePayload: AgentImageContext[] = modelSupportsVision(
      this.agent.getModel(),
    )
      ? images.map((i) => ({ url: i.dataUrl }))
      : [];

    void this.agent.query(
      prompt,
      resolved.map((r) => ({
        path: r.path,
        content: r.content,
        truncated: r.truncated,
      })),
      imagePayload,
      { ...options, systemPrefix },
    );
  }

  // -- image attachments --------------------------------------------------

  /**
   * Document-level keydown capture that redirects `/` to the editor when
   * it would otherwise hit the shell. Heuristic: only hijack when
   *   • this workspace is the active one,
   *   • the editor is NOT currently focused,
   *   • no shell command is running (so we don't break vim's `/`-search etc).
   * Otherwise we let the key pass through unchanged.
   */
  private setupSlashFocusHijack(): void {
    const onKeydown = (e: KeyboardEvent) => {
      if (!this.root.classList.contains("active")) return;
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.isEditorFocused()) return; // CodeMirror already owns it.

      const busy = this.blocks
        .getBlocks()
        .some((b) => b.status === "running" && b.command.trim().length > 0);
      if (busy) return; // TUI app (vim, less, htop) may want the slash.

      e.preventDefault();
      e.stopPropagation();
      this.input.focus();
      // Seed the editor with `/` so the slash autocomplete popup opens
      // exactly like the user had typed it directly.
      this.input.setValue("/");
    };
    document.addEventListener("keydown", onKeydown, { capture: true });
    this.disposers.push(() =>
      document.removeEventListener("keydown", onKeydown, { capture: true }),
    );
  }

  /** True if the active element is inside this workspace's CodeMirror view. */
  private isEditorFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    const host = this.root.querySelector(".editor-host");
    return !!host && host.contains(active);
  }

  // -- busy pill (agent running indicator + cancel) ----------------------

  /** Wire the cancel click handler on the busy pill. Visibility is driven
   * by setBusyState() / setStalledState() via the agent's callbacks. */
  private setupBusyPill(): void {
    const pill = this.root.querySelector<HTMLButtonElement>(".busy-pill");
    if (!pill) return;
    pill.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Agent.cancel() is a no-op when nothing's in flight, so safe.
      this.agent?.cancel();
    });
  }

  /** Show/hide the busy pill. Was previously also responsible for
   * draining a suspended PTY buffer; that buffer is gone now that
   * agent and shell render to separate surfaces. */
  private setBusyState(busy: boolean): void {
    const pill = this.root.querySelector<HTMLButtonElement>(".busy-pill");
    if (pill) {
      if (busy) {
        pill.classList.add("visible");
        pill.classList.remove("stalled");
      } else {
        pill.classList.remove("visible");
        pill.classList.remove("stalled");
      }
    }
  }

  /** Switch the pill into its red "stalled" variant without changing
   * visibility. Triggered by the agent's 45s stall safety-net. */
  private setStalledState(stalled: boolean): void {
    const pill = this.root.querySelector<HTMLButtonElement>(".busy-pill");
    if (!pill) return;
    if (stalled) {
      pill.classList.add("stalled");
    } else {
      pill.classList.remove("stalled");
    }
  }

  // -- problems panel ------------------------------------------------------

  /**
   * Wire panel-level event delegation: chip toggles, finding-row clicks
   * (copy `path:line` to clipboard), close button, and Escape-to-close.
   * Visibility is driven separately by `showProblemsPanel` / `hide`.
   */
  private setupProblemsPanel(): void {
    const panel = this.root.querySelector<HTMLElement>(".problems-panel");
    if (!panel) return;
    panel.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const action = target
        .closest("[data-problems-action]")
        ?.getAttribute("data-problems-action");
      if (action === "close") {
        this.hideProblemsPanel();
        return;
      }
      const chip = target.closest<HTMLElement>("[data-filter-kind]");
      if (chip) {
        const kind = chip.getAttribute("data-filter-kind");
        const value = chip.getAttribute("data-filter-value") ?? "";
        if (kind === "severity") {
          this.problemsFilter = toggleProblemsSeverity(
            this.problemsFilter,
            value as Severity,
          );
          this.renderProblemsPanelInto();
        } else if (kind === "confidence") {
          this.problemsFilter = toggleProblemsConfidence(
            this.problemsFilter,
            value as Confidence,
          );
          this.renderProblemsPanelInto();
        }
        return;
      }
      // Explicit copy button on a row keeps the previous
      // click-to-clipboard affordance without making the whole row a
      // copy target. Stop propagation so the click doesn't also expand
      // the snippet.
      const copyBtn = target.closest<HTMLElement>(
        '.problems-row [data-row-action="copy"]',
      );
      if (copyBtn) {
        e.stopPropagation();
        const row = copyBtn.closest<HTMLElement>(".problems-row");
        const loc = row?.getAttribute("data-loc") ?? "";
        if (loc) {
          void navigator.clipboard.writeText(loc).catch(() => {});
          this.term.write(
            `\r\n\x1b[2m[problems] copied \x1b[36m${sanitize(loc)}\x1b[0m\x1b[2m to clipboard\x1b[0m\r\n`,
          );
        }
        return;
      }
      const row = target.closest<HTMLElement>(".problems-row");
      if (row) {
        void this.toggleProblemsRow(row);
      }
    });
    // Escape closes the panel when it's focused / hovered.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!this.root.classList.contains("active")) return;
      if (!this.problemsVisible) return;
      if (this.isEditorFocused()) return;
      this.hideProblemsPanel();
    };
    document.addEventListener("keydown", onEscape, { capture: true });
    this.disposers.push(() =>
      document.removeEventListener("keydown", onEscape, { capture: true }),
    );
  }

  private showProblemsPanel(): void {
    this.problemsVisible = true;
    const panel = this.root.querySelector<HTMLElement>(".problems-panel");
    if (!panel) return;
    panel.dataset.visible = "true";
    panel.setAttribute("aria-hidden", "false");
    this.setDividerVisible("problems", true);
    this.renderProblemsPanelInto();
  }

  private hideProblemsPanel(): void {
    this.problemsVisible = false;
    const panel = this.root.querySelector<HTMLElement>(".problems-panel");
    if (!panel) return;
    panel.dataset.visible = "false";
    panel.setAttribute("aria-hidden", "true");
    this.setDividerVisible("problems", false);
  }

  private renderProblemsPanelInto(): void {
    const panel = this.root.querySelector<HTMLElement>(".problems-panel");
    if (!panel) return;
    panel.innerHTML = renderProblemsPanel(
      this.lastAuditReport,
      this.problemsFilter,
    );
  }

  /**
   * Toggle a finding row's expanded state. On first expand, lazily
   * fetches the code snippet around the finding via the Rust
   * `read_file_snippet` command and renders it inline. Subsequent
   * toggles reuse the cached HTML to keep things snappy.
   */
  private async toggleProblemsRow(row: HTMLElement): Promise<void> {
    const expanded = row.getAttribute("data-expanded") === "true";
    const next = !expanded;
    row.setAttribute("data-expanded", next ? "true" : "false");
    if (!next) return;
    if (row.getAttribute("data-snippet-loaded") === "true") return;
    const host = row.querySelector<HTMLElement>("[data-snippet-host]");
    if (!host) return;
    const file = row.getAttribute("data-file") ?? "";
    const line = Number(row.getAttribute("data-line") ?? "0");
    if (!file) {
      host.innerHTML = renderSnippetError("finding has no file path");
      row.setAttribute("data-snippet-loaded", "true");
      return;
    }
    if (!this.cwd) {
      host.innerHTML = renderSnippetError(
        "cwd unknown; cannot resolve relative path",
        file,
      );
      row.setAttribute("data-snippet-loaded", "true");
      return;
    }
    host.innerHTML = `<div class="snippet snippet-loading">loading\u2026</div>`;
    try {
      const snippet = await invoke<FileSnippet>("read_file_snippet", {
        cwd: this.cwd,
        path: file,
        line: Math.max(0, Math.floor(line)),
      });
      host.innerHTML = renderSnippet(snippet);
    } catch (e) {
      host.innerHTML = renderSnippetError(String(e), file);
    }
    row.setAttribute("data-snippet-loaded", "true");
  }

  /** Driver for `/problems [show|hide|toggle|clear]`. */
  private handleProblemsCommand(rawArgs: string): void {
    const parsed = parseProblemsArgs(rawArgs);
    if (parsed.error) {
      this.term.write(
        `\r\n\x1b[1;31m[problems]\x1b[0m ${sanitize(parsed.error)}\r\n`,
      );
      return;
    }
    switch (parsed.action) {
      case "show":
        this.showProblemsPanel();
        break;
      case "hide":
        this.hideProblemsPanel();
        break;
      case "toggle":
        if (this.problemsVisible) this.hideProblemsPanel();
        else this.showProblemsPanel();
        break;
      case "clear":
        this.lastAuditReport = null;
        this.problemsFilter = defaultProblemsFilter();
        if (this.problemsVisible) this.renderProblemsPanelInto();
        this.term.write(
          `\r\n\x1b[2m[problems] cleared cached report\x1b[0m\r\n`,
        );
        break;
    }
  }

  // -- audit completion → structured findings + markdown report --------

  /**
   * Fired by the agent when a /audit turn finishes successfully. Parses
   * the raw transcript into structured findings, renders both an ANSI
   * summary (for xterm) and a full markdown report (for the durable
   * handoff), and asks the Rust side to persist the markdown under
   * `<cwd>/.prism/second-pass/`.
   */
  private async handleAuditComplete(info: {
    responseText: string;
    model: string;
    runtimeProbes: RuntimeProbe[];
    substrateRuns: SubstrateRun[];
  }): Promise<void> {
    const scope = this.activeAuditScope;
    this.activeAuditScope = null;

    const report = parseAuditTranscript(info.responseText, {
      model: info.model,
      scope,
      runtime_probes: info.runtimeProbes,
      substrate_runs: info.substrateRuns,
    });
    // Cache + auto-open the Problems panel so the user sees the
    // structured findings without running a separate command.
    this.lastAuditReport = report;
    this.refreshEditorDiagnostics();
    this.showProblemsPanel();

    // ANSI summary in xterm — even if we fail to write the file, the
    // user gets the parsed view inline. Pads the raw model output with
    // a structured list so copy/paste works cleanly.
    this.term.write(renderAnsiFindings(report));

    if (!this.cwd) {
      this.term.write(
        `\r\n\x1b[1;33m[audit]\x1b[0m \x1b[2mcwd unknown; skipping report write (markdown report only persists when a shell is started with OSC 7)\x1b[0m\r\n`,
      );
      return;
    }

    const markdown = renderMarkdownReport(report);
    const json = renderJsonReport(report);
    const filename = auditReportFilename(report.generated_at);

    try {
      const result = await invoke<{
        path: string;
        bytes_written: number;
        json_path?: string | null;
        json_bytes_written?: number | null;
      }>("write_audit_report", {
        cwd: this.cwd,
        filename,
        content: markdown,
        // The JSON sidecar is the machine-readable contract every future
        // consumer (`/fix`, problems panel, CI) reads. Markdown is for
        // humans; JSON is the API.
        jsonContent: json,
      });
      const pretty = prettyPath(result.path);
      this.term.write(
        `\r\n\x1b[1;32m[audit]\x1b[0m \x1b[2mreport saved \u2192 \x1b[36m${sanitize(pretty)}\x1b[0m\x1b[2m (${formatBytesShort(result.bytes_written)})\x1b[0m\r\n`,
      );
      if (result.json_path) {
        const prettyJson = prettyPath(result.json_path);
        this.term.write(
          `\x1b[2m[audit] sidecar     \u2192 \x1b[36m${sanitize(prettyJson)}\x1b[0m\x1b[2m (${formatBytesShort(result.json_bytes_written ?? 0)})\x1b[0m\r\n`,
        );
        // Update the workspace-state pointer so a future tab open
        // hydrates this audit without re-running it. Best-effort: a
        // failure here is logged but doesn't fail the audit turn.
        void this.updateLastAuditPointer(report, result.json_path);
      }
    } catch (e) {
      this.term.write(
        `\r\n\x1b[1;31m[audit]\x1b[0m report write failed: ${sanitize(String(e))}\r\n`,
      );
    }
  }

  // -- build/new/refactor/test-gen completion --------------------------------

  /**
   * Fired by the agent when a build-family turn (build / new / refactor /
   * test-gen) finishes successfully. Mirrors `handleAuditComplete`:
   *   1. Parse the BUILD/RENAME/SCAFFOLD/TEST GEN REPORT block.
   *   2. Render an ANSI summary into xterm.
   *   3. Persist markdown + JSON sidecar under `<cwd>/.prism/builds/`.
   *   4. Update `state.json.last_build` with a pointer + summary.
   *
   * `/fix` deliberately does NOT route through this hook — its output
   * contract (APPLIED/SKIPPED/VERIFIED) is different and warrants a
   * sibling parser if/when we want to track fix completions in the
   * spine.
   */
  private async handleBuildComplete(info: {
    responseText: string;
    model: string;
    mode: string;
  }): Promise<void> {
    // Capture + clear the active feature snapshot regardless of whether
    // the persistence path succeeds, so a follow-up dispatch isn't
    // misattributed to the wrong feature.
    const feature = this.activeBuildFeature ?? "";
    this.activeBuildFeature = null;

    const report = parseBuildReportTranscript(info.responseText, {
      mode: info.mode,
      model: info.model,
      feature,
    });
    this.lastBuildReport = report;

    // ANSI summary first so the user sees the parse outcome even if
    // the persistence step fails.
    this.term.write(renderAnsiBuildReport(report));

    if (!this.cwd) {
      this.term.write(
        `\r\n\x1b[1;33m[${sanitize(info.mode)}]\x1b[0m \x1b[2mcwd unknown; skipping report write\x1b[0m\r\n`,
      );
      return;
    }

    const markdown = renderBuildReportMarkdown(report);
    const json = renderBuildReportJson(report);
    const filename = buildReportFilename(report.generated_at);

    try {
      const result = await invoke<{
        path: string;
        bytes_written: number;
        json_path?: string | null;
        json_bytes_written?: number | null;
      }>("write_build_report", {
        cwd: this.cwd,
        filename,
        content: markdown,
        jsonContent: json,
      });
      const pretty = prettyPath(result.path);
      this.term.write(
        `\r\n\x1b[1;32m[${sanitize(info.mode)}]\x1b[0m \x1b[2mreport saved \u2192 \x1b[36m${sanitize(pretty)}\x1b[0m\x1b[2m (${formatBytesShort(result.bytes_written)})\x1b[0m\r\n`,
      );
      if (result.json_path) {
        const prettyJson = prettyPath(result.json_path);
        this.term.write(
          `\x1b[2m[${sanitize(info.mode)}] sidecar     \u2192 \x1b[36m${sanitize(prettyJson)}\x1b[0m\x1b[2m (${formatBytesShort(result.json_bytes_written ?? 0)})\x1b[0m\r\n`,
        );
        void this.updateLastBuildPointer(report, result.json_path);
      }
    } catch (e) {
      this.term.write(
        `\r\n\x1b[1;31m[${sanitize(info.mode)}]\x1b[0m report write failed: ${sanitize(String(e))}\r\n`,
      );
    }
  }

  // -- workspace state spine -------------------------------------------------

  /**
   * On first cwd resolution (or when the user `cd`s into a new project),
   * load `<cwd>/.prism/state.json` if it exists and rehydrate
   * `lastAuditReport` and `lastBuildReport` from the pointed-to JSON
   * sidecars. Best-effort: any failure logs and leaves in-memory state
   * empty so the next audit/build rewrites it cleanly.
   *
   * We deliberately do NOT auto-open the Problems panel here \u2014 a user
   * who reopens a tab to a clean slate may not want their last audit
   * shoved in their face. `/problems show` brings it back instantly.
   */
  private async hydrateWorkspaceState(): Promise<void> {
    if (this.workspaceStateHydrated) return;
    if (!this.cwd) return;
    this.workspaceStateHydrated = true;
    let state: PersistedWorkspaceState | null = null;
    try {
      state = await invoke<PersistedWorkspaceState | null>(
        "read_workspace_state",
        { cwd: this.cwd },
      );
    } catch (e) {
      // Corrupt state file. Surface dimly and continue with no spine.
      this.term.write(
        `\r\n\x1b[2m[workspace] could not load state: ${sanitize(String(e))}\x1b[0m\r\n`,
      );
      return;
    }
    if (!state) return;

    if (state.last_audit?.path) {
      try {
        const lookup = await invoke<{ path: string; content: string; bytes: number }>(
          "read_latest_audit_report",
          { cwd: this.cwd, path: state.last_audit.path },
        );
        const parsed = JSON.parse(lookup.content) as AuditReport;
        this.lastAuditReport = parsed;
      } catch (e) {
        // Pointer stale (file moved/deleted). Leave audit empty; the
        // pointer will be overwritten on the next /audit completion.
        console.warn("hydrate last_audit failed", e);
      }
    }
    if (state.last_build?.path) {
      try {
        const lookup = await invoke<{ path: string; content: string; bytes: number }>(
          "read_latest_build_report",
          { cwd: this.cwd, path: state.last_build.path },
        );
        const parsed = JSON.parse(lookup.content) as BuildReport;
        this.lastBuildReport = parsed;
      } catch (e) {
        console.warn("hydrate last_build failed", e);
      }
    }

    if (state.layout) {
      this.layout = clampLayout({
        sidebar_width: state.layout.sidebar_width ?? this.layout.sidebar_width,
        problems_width: state.layout.problems_width ?? this.layout.problems_width,
        preview_height: state.layout.preview_height ?? this.layout.preview_height,
        agent_pane_width:
          state.layout.agent_pane_width ?? this.layout.agent_pane_width,
      });
      this.applyLayoutToDOM();
    }
  }

  /**
   * Update `state.json.last_audit` with a pointer + summary. Reads the
   * current state, mutates the audit slot only, writes it back. We do
   * NOT touch `last_build` or `recent_files` here so two concurrent
   * completions can't trample each other's slots.
   */
  private async updateLastAuditPointer(
    report: AuditReport,
    absoluteJsonPath: string,
  ): Promise<void> {
    if (!this.cwd) return;
    const relative = relativeToCwd(absoluteJsonPath, this.cwd);
    const counts = countByConfidenceShim(report);
    const last_audit = {
      path: relative,
      generated_at: report.generated_at,
      scope: report.scope,
      counts: {
        error: report.summary.errors,
        warning: report.summary.warnings,
        info: report.summary.info,
        confirmed: counts.confirmed,
        probable: counts.probable,
        candidate: counts.candidate,
      },
    };
    await this.mergeWorkspaceState((s) => ({ ...s, last_audit }));
  }

  /** Update `state.json.last_build` with a pointer + summary. */
  private async updateLastBuildPointer(
    report: BuildReport,
    absoluteJsonPath: string,
  ): Promise<void> {
    if (!this.cwd) return;
    const relative = relativeToCwd(absoluteJsonPath, this.cwd);
    const last_build = buildLastBuildIndex(report, relative);
    await this.mergeWorkspaceState((s) => ({ ...s, last_build }));
  }

  /**
   * Render an ANSI summary of the in-memory workspace state — last
   * audit + last build, with the same shape `state.json` carries. Pure
   * (modulo wall clock for the relative-time labels). The xterm-bound
   * `/last` handler is the only caller today; tests can poke directly
   * at `lastAuditReport` / `lastBuildReport` to exercise this without
   * IPC.
   */
  private renderLastAnsi(): string {
    const RESET = "\x1b[0m";
    const DIM = "\x1b[2m";
    const BOLD = "\x1b[1m";
    const CYAN = "\x1b[36m";
    const GREEN = "\x1b[32m";
    const YELLOW = "\x1b[33m";
    const RED = "\x1b[31m";
    const out: string[] = ["\r\n"];
    if (!this.lastAuditReport && !this.lastBuildReport) {
      out.push(
        `${DIM}[last] no persisted state yet \u2014 run /audit or /build to populate ${CYAN}.prism/state.json${RESET}\r\n`,
      );
      return out.join("");
    }
    out.push(
      `${BOLD}Last activity${RESET} ${DIM}\u2014 from ${CYAN}.prism/state.json${RESET}\r\n`,
    );
    if (this.lastAuditReport) {
      const a = this.lastAuditReport;
      const rel = formatRelativeTime(a.generated_at);
      out.push(
        `  ${BOLD}audit${RESET} ${DIM}${rel}${RESET}` +
          ` ${RED}${a.summary.errors} err${RESET}` +
          ` ${YELLOW}${a.summary.warnings} warn${RESET}` +
          ` ${CYAN}${a.summary.info} info${RESET}` +
          (a.scope ? ` ${DIM}scope ${a.scope}${RESET}` : "") +
          `\r\n`,
      );
    } else {
      out.push(`  ${DIM}audit \u2014 (none yet; run /audit)${RESET}\r\n`);
    }
    if (this.lastBuildReport) {
      const b = this.lastBuildReport;
      const rel = formatRelativeTime(b.generated_at);
      const statusColor =
        b.status === "completed"
          ? GREEN
          : b.status === "incomplete"
            ? YELLOW
            : DIM;
      out.push(
        `  ${BOLD}build${RESET} ${DIM}${rel}${RESET}` +
          ` ${statusColor}${b.status}${RESET}` +
          ` ${DIM}\u00b7 ${CYAN}${b.mode}${RESET}` +
          (b.feature ? ` ${DIM}\u00b7 ${b.feature}${RESET}` : "") +
          `\r\n`,
      );
      const v = b.verification;
      if (v.typecheck || v.tests || v.http) {
        const parts: string[] = [];
        if (v.typecheck) parts.push(`typecheck ${v.typecheck}`);
        if (v.tests) parts.push(`tests ${v.tests}`);
        if (v.http) parts.push(`http ${v.http}`);
        out.push(`    ${DIM}${parts.join(" \u00b7 ")}${RESET}\r\n`);
      }
    } else {
      out.push(
        `  ${DIM}build \u2014 (none yet; run /build, /new, /refactor, /test-gen)${RESET}\r\n`,
      );
    }
    return out.join("");
  }

  /**
   * Read-modify-write the workspace state file. Encapsulates the
   * "version stays at 1, recent_files preserved, error best-effort"
   * pattern so callers can pass a single field-level mutator.
   */
  private async mergeWorkspaceState(
    mutate: (s: PersistedWorkspaceState) => PersistedWorkspaceState,
  ): Promise<void> {
    if (!this.cwd) return;
    let current: PersistedWorkspaceState | null = null;
    try {
      current = await invoke<PersistedWorkspaceState | null>(
        "read_workspace_state",
        { cwd: this.cwd },
      );
    } catch {
      // Treat a corrupt file the same as missing \u2014 the next write
      // overwrites the bad bytes with a clean spine.
      current = null;
    }
    const base: PersistedWorkspaceState = current ?? {
      version: 1,
      recent_files: [],
    };
    const next = mutate(base);
    if (next.version === 0 || next.version === undefined) next.version = 1;
    try {
      await invoke("write_workspace_state", {
        cwd: this.cwd,
        state: next,
      });
    } catch (e) {
      console.warn("write_workspace_state failed", e);
    }
  }

  private setupAttachments(): void {
    const inputBar = this.root.querySelector<HTMLElement>(".input-bar");
    if (!inputBar) return;

    // Paste handler — picks up ClipboardItems that contain images.
    inputBar.addEventListener("paste", (e) => {
      const items = (e as ClipboardEvent).clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            void this.addImageFile(f);
          }
        }
      }
    });

    // Drag & drop onto the workspace (anywhere inside .content).
    const dropZone = this.root.querySelector<HTMLElement>(".content") ?? this.root;
    dropZone.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        dropZone.classList.add("drop-target");
      }
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("drop-target");
    });
    dropZone.addEventListener("drop", (e) => {
      dropZone.classList.remove("drop-target");
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      for (const f of Array.from(files)) {
        if (f.type.startsWith("image/")) {
          void this.addImageFile(f);
        }
      }
    });
  }

  /** Convert a File to a DataURL and push onto pendingImages. */
  private async addImageFile(file: File): Promise<void> {
    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — vision APIs reject larger
    if (file.size > MAX_BYTES) {
      this.term.write(
        `\r\n\x1b[1;33m[images]\x1b[0m \x1b[36m${sanitize(file.name || "pasted")}\x1b[0m is ${Math.round(file.size / 1024)} KB \u2014 over the 5 MB cap\r\n`,
      );
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    if (!dataUrl) return;
    const img: PendingImage = {
      id: cryptoRandomId(),
      name: file.name || `image.${(file.type.split("/")[1] || "png")}`,
      dataUrl,
      sizeBytes: file.size,
    };
    this.pendingImages.push(img);
    this.renderAttachments();
  }

  private takePendingImages(): PendingImage[] {
    const taken = this.pendingImages;
    this.pendingImages = [];
    this.renderAttachments();
    return taken;
  }

  private renderAttachments(): void {
    const bar = this.root.querySelector<HTMLElement>(".attachments");
    if (!bar) return;
    if (this.pendingImages.length === 0) {
      bar.innerHTML = "";
      bar.classList.remove("visible");
      return;
    }
    bar.classList.add("visible");
    bar.innerHTML = this.pendingImages
      .map(
        (img) =>
          `<div class="thumb" data-id="${img.id}" title="${escapeAttr(img.name)}">` +
          `<img src="${img.dataUrl}" alt="${escapeAttr(img.name)}"/>` +
          `<button class="thumb-close" data-id="${img.id}" title="Remove">\u00d7</button>` +
          `</div>`,
      )
      .join("");
    bar.onclick = (ev) => {
      const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".thumb-close");
      if (!el) return;
      const id = el.dataset.id!;
      this.pendingImages = this.pendingImages.filter((i) => i.id !== id);
      this.renderAttachments();
    };
  }

  private setTitleFromText(text: string): void {
    if (this.title !== "New Tab") return; // only auto-title once
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (trimmed.length === 0) return;
    this.title = trimmed.length > 36 ? trimmed.slice(0, 33) + "\u2026" : trimmed;
    this.cb.onTitleChange(this.id, this.title);
  }

  private updateModelBadge(): void {
    const el = this.root.querySelector<HTMLElement>(".model-badge");
    if (!el) return;
    const short = shortModelName(this.agent.getModel());
    const count = this.agent.getMessageCount();
    el.textContent = count > 0 ? `${short} \u00b7 ${count}` : short;
  }

  private updateCwdBadge(): void {
    const el = this.root.querySelector<HTMLElement>(".cwd-badge");
    if (!el) return;
    if (!this.cwd) {
      el.textContent = "";
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    // Manually truncate from the LEFT so the deepest folder stays visible,
    // e.g. "~/Development/StellarumAtlas/src-tauri" → "…prism/src-tauri".
    el.textContent = truncateLeft(prettyPath(this.cwd), 34);
    el.title = this.cwd;
  }

  // -- blocks sidebar -------------------------------------------------------

  private wireBlockSidebar(): void {
    const listEl = this.root.querySelector<HTMLUListElement>(".blocks-list")!;
    const countEl = this.root.querySelector<HTMLElement>(".blocks-count")!;

    listEl.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement | null)?.closest("li[data-id]");
      if (li) this.blocks.scrollToBlock(li.getAttribute("data-id")!);
    });

    const render = (list: readonly Block[]) => {
      countEl.textContent = String(list.length);
      listEl.innerHTML = list
        .map((b) => {
          const cmd = b.command.trim() || "\u2014";
          const dur = formatDuration(b);
          const ecLabel = b.status === "running" ? "\u2026" : String(b.exitCode ?? "\u2014");
          return (
            `<li class="block-item status-${b.status}" data-id="${b.id}" title="${escapeAttr(cmd)}">` +
            `<span class="status-dot"></span>` +
            `<span class="cmd">${escapeHtml(cmd)}</span>` +
            `<span class="meta"><span class="ec">${escapeHtml(ecLabel)}</span><span class="dur">${escapeHtml(dur)}</span></span>` +
            `</li>`
          );
        })
        .join("");
      listEl.scrollTop = listEl.scrollHeight;
    };

    this.blocks.onChange(render);

    const interval = window.setInterval(() => {
      if (this.blocks.getBlocks().some((b) => b.status === "running")) {
        render(this.blocks.getBlocks());
      }
    }, 500);
    this.disposers.push(() => clearInterval(interval));
  }

  // -- sidebar tabs --------------------------------------------------------

  /**
   * Wire the [Blocks | Files] tab strip in the sidebar header. The two
   * panes (`.sidebar-pane-blocks`, `.sidebar-pane-files`) live side by
   * side; we toggle their `hidden` attribute to show one at a time.
   * Switching to Files lazy-loads the cwd's listing on first view.
   */
  private wireSidebarTabs(): void {
    const tabsEl = this.root.querySelector<HTMLElement>(".sidebar-tabs");
    if (!tabsEl) return;
    tabsEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const action = target?.closest<HTMLButtonElement>(
        ".sidebar-tab-action[data-action]",
      );
      if (action) {
        const a = action.dataset.action;
        if (a === "toggle-hidden") {
          this.toggleShowHiddenFiles();
        }
        return;
      }
      const btn = target?.closest<HTMLButtonElement>(".sidebar-tab");
      if (!btn) return;
      const tab = btn.dataset.tab as "blocks" | "files" | undefined;
      if (!tab) return;
      this.setSidebarTab(tab);
    });
  }

  /**
   * Flip the show-hidden-files flag. We reset the tree state (children
   * and load states) because expanded dirs were listed under the old
   * filter; preserving them would mix dotfile rows in inconsistently.
   * The expanded set is preserved so the user's navigation comes back
   * after the re-fetch.
   */
  private toggleShowHiddenFiles(): void {
    this.showHiddenFiles = !this.showHiddenFiles;
    // Force a fresh load on next view.
    this.fileTreeRootLoaded = false;
    // Drop cached children so re-expanded dirs re-fetch under the new filter.
    this.treeState = {
      ...this.treeState,
      childrenByPath: new Map(),
      loadStateByPath: new Map(),
    };
    this.updateHiddenToggleVisualState();
    void this.refreshFileTreeRoot();
  }

  /** Sync the toggle button's aria + glyph with the current state. */
  private updateHiddenToggleVisualState(): void {
    const btn = this.root.querySelector<HTMLButtonElement>(
      '.sidebar-tab-action[data-action="toggle-hidden"]',
    );
    if (!btn) return;
    btn.setAttribute("aria-pressed", this.showHiddenFiles ? "true" : "false");
    btn.classList.toggle("sidebar-tab-action-on", this.showHiddenFiles);
    // Filled circle when on; outlined when off. Compact glyph that
    // doesn't lean too "eye"-iconographic since the metaphor is
    // "include hidden" not "toggle visibility of the tree itself".
    btn.textContent = this.showHiddenFiles ? "\u25cf" : "\u25cb";
    btn.title = this.showHiddenFiles
      ? "Hide hidden files (.git, .env, \u2026 will be hidden again; .prism/ is always shown)"
      : "Show hidden files (.git, .env, \u2026; .prism/ is always shown)";
  }

  /**
   * Switch the visible sidebar pane. Public so the `/files` slash
   * command can call it directly.
   */
  setSidebarTab(tab: "blocks" | "files"): void {
    if (this.activeSidebarTab === tab) {
      // Re-focus on re-tap so /files quickly returns the user to the
      // tree even when it's already showing.
      if (tab === "files") this.focusFileTree();
      return;
    }
    this.activeSidebarTab = tab;
    const tabs = this.root.querySelectorAll<HTMLElement>(".sidebar-tab");
    tabs.forEach((t) => {
      const isActive = t.dataset.tab === tab;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    const panes = this.root.querySelectorAll<HTMLElement>(".sidebar-pane");
    panes.forEach((p) => {
      const isActive = p.dataset.tab === tab;
      if (isActive) {
        p.removeAttribute("hidden");
      } else {
        p.setAttribute("hidden", "");
      }
    });
    // The hidden-files toggle only makes sense in the Files tab.
    const hiddenBtn = this.root.querySelector<HTMLButtonElement>(
      '.sidebar-tab-action[data-action="toggle-hidden"]',
    );
    if (hiddenBtn) {
      if (tab === "files") {
        hiddenBtn.removeAttribute("hidden");
        this.updateHiddenToggleVisualState();
      } else {
        hiddenBtn.setAttribute("hidden", "");
      }
    }
    if (tab === "files") {
      // Lazy-load on first view (or when cwd changed since last view).
      if (!this.fileTreeRootLoaded || this.fileTreeLastCwd !== this.cwd) {
        void this.refreshFileTreeRoot();
      }
      this.focusFileTree();
    }
  }

  // -- file tree -----------------------------------------------------------

  /**
   * Wire click + keyboard handlers on the `.file-tree` element. Listeners
   * are attached once; the tree's contents are re-rendered on every
   * state change but the parent element is stable.
   */
  private wireFileTree(): void {
    const treeEl = this.root.querySelector<HTMLElement>(".file-tree");
    if (!treeEl) return;
    treeEl.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-path]",
      );
      if (!row) return;
      const path = row.dataset.path!;
      const kind = row.dataset.kind ?? "file";
      this.treeState = setTreeSelected(this.treeState, path);
      if (kind === "dir") {
        void this.handleTreeToggle(path);
      } else {
        // Single click opens the file in the editable buffer.
        void this.openFileInEditor(path);
      }
      this.renderFileTree();
    });
    treeEl.addEventListener("keydown", (e) => {
      const rows = flattenVisibleRows(this.treeState);
      if (rows.length === 0) return;
      const sel = this.treeState.selected;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = moveSelection(this.treeState, rows, 1);
        this.treeState = setTreeSelected(this.treeState, next);
        this.renderFileTree();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = moveSelection(this.treeState, rows, -1);
        this.treeState = setTreeSelected(this.treeState, next);
        this.renderFileTree();
        return;
      }
      if (e.key === "ArrowRight") {
        // Expand the focused dir; on a file, jump to next sibling.
        if (!sel) return;
        const row = rows.find((r) => r.entry.path === sel);
        if (!row) return;
        if (row.entry.kind === "dir" && !row.expanded) {
          e.preventDefault();
          void this.handleTreeToggle(sel);
        }
        return;
      }
      if (e.key === "ArrowLeft") {
        if (!sel) return;
        const row = rows.find((r) => r.entry.path === sel);
        if (!row) return;
        if (row.entry.kind === "dir" && row.expanded) {
          e.preventDefault();
          void this.handleTreeToggle(sel);
        }
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        if (!sel) return;
        const row = rows.find((r) => r.entry.path === sel);
        if (!row) return;
        e.preventDefault();
        if (row.entry.kind === "dir") {
          void this.handleTreeToggle(sel);
        } else {
          void this.openFileInEditor(sel);
        }
      }
    });
  }

  /** Move keyboard focus to the file tree (used by `/files` re-tap). */
  private focusFileTree(): void {
    const treeEl = this.root.querySelector<HTMLElement>(".file-tree");
    treeEl?.focus();
  }

  /**
   * Fetch the cwd's listing and seed the tree. Called on first view
   * and on cwd change. Errors are surfaced inline in the tree pane.
   */
  private async refreshFileTreeRoot(): Promise<void> {
    const treeEl = this.root.querySelector<HTMLElement>(".file-tree");
    if (!treeEl) return;
    if (!this.cwd) {
      treeEl.innerHTML =
        `<div class="file-tree-empty">cwd unknown \u2014 wait for the shell prompt</div>`;
      return;
    }
    treeEl.innerHTML = `<div class="file-tree-loading">loading\u2026</div>`;
    try {
      const listing = await invoke<RawTreeListing>("list_directory_tree", {
        cwd: this.cwd,
        path: null,
        showHidden: this.showHiddenFiles,
      });
      this.treeState = setTreeRoot(this.treeState, listing);
      this.fileTreeRootLoaded = true;
      this.fileTreeLastCwd = this.cwd;
      this.renderFileTree();
    } catch (err) {
      treeEl.innerHTML =
        `<div class="file-tree-error">failed to list cwd: ${escapeHtml(String(err))}</div>`;
    }
  }

  /**
   * Toggle a directory's expanded state. When opening for the first
   * time, fetch its children and feed them into the tree state.
   */
  private async handleTreeToggle(path: string): Promise<void> {
    const isDir =
      flattenVisibleRows(this.treeState).find((r) => r.entry.path === path)
        ?.entry.kind === "dir";
    if (!isDir) return;
    const r = toggleExpanded(this.treeState, path, true);
    this.treeState = r.state;
    if (r.needsLoad) {
      this.treeState = setTreeLoading(this.treeState, path);
      this.renderFileTree();
      try {
        const listing = await invoke<RawTreeListing>("list_directory_tree", {
          cwd: this.cwd,
          path,
          showHidden: this.showHiddenFiles,
        });
        this.treeState = setChildren(this.treeState, path, listing);
      } catch (err) {
        this.treeState = setTreeError(this.treeState, path, String(err));
      }
    }
    this.renderFileTree();
  }

  /** Re-render the file tree pane from the current state. */
  private renderFileTree(): void {
    const treeEl = this.root.querySelector<HTMLElement>(".file-tree");
    if (!treeEl) return;
    if (!this.treeState.root) {
      // Either pre-load or the cwd was empty. Show a tiny note unless
      // the load is in flight (loading shows its own spinner).
      if (treeEl.querySelector(".file-tree-loading")) return;
      treeEl.innerHTML =
        `<div class="file-tree-empty">no files \u2014 cwd is empty or all entries are gitignored</div>`;
      return;
    }
    const rows = flattenVisibleRows(this.treeState);
    if (rows.length === 0) {
      treeEl.innerHTML =
        `<div class="file-tree-empty">no files \u2014 cwd is empty or all entries are gitignored</div>`;
      return;
    }
    treeEl.innerHTML = rows.map((r) => this.renderTreeRow(r)).join("");
  }

  private renderTreeRow(row: VisibleRow): string {
    const e = row.entry;
    const indentPx = 8 + row.depth * 14;
    const selected =
      this.treeState.selected === e.path ? " file-tree-row-selected" : "";
    const kindClass = `file-tree-row-${e.kind}`;
    let icon = "";
    if (e.kind === "dir") {
      // Caret + folder glyph; rotated via CSS when expanded.
      icon = `<span class="file-tree-caret">${row.expanded ? "\u25be" : "\u25b8"}</span>`;
    } else {
      icon = `<span class="file-tree-caret file-tree-caret-spacer">\u00a0</span>`;
    }
    const detail =
      e.kind === "file" && typeof e.size === "number"
        ? `<span class="file-tree-detail">${formatTreeBytes(e.size)}</span>`
        : "";
    let trailing = "";
    if (row.loadState.kind === "loading") {
      trailing = `<span class="file-tree-detail file-tree-detail-loading">\u2026</span>`;
    } else if (row.loadState.kind === "error") {
      trailing = `<span class="file-tree-detail file-tree-detail-error" title="${escapeAttr(row.loadState.message)}">!</span>`;
    }
    return (
      `<div class="file-tree-row ${kindClass}${selected}" ` +
      `data-path="${escapeAttr(e.path)}" data-kind="${e.kind}" ` +
      `style="padding-left:${indentPx}px" role="treeitem" ` +
      `aria-level="${row.depth + 1}" ` +
      `aria-expanded="${e.kind === "dir" ? (row.expanded ? "true" : "false") : ""}">` +
      `${icon}<span class="file-tree-name">${escapeHtml(e.name)}</span>` +
      detail +
      trailing +
      `</div>`
    );
  }

  // -- file editor surface ------------------------------------------------

  /**
   * Open `path` in the editable file overlay. Reads the full file via
   * `read_file_text` (binary-safe, capped at 256 KB), mounts a fresh
   * `FileEditor` in the overlay body, and wires the header chrome
   * (path label, dirty indicator, Save button, close).
   *
   * If a file is already open and dirty, prompts before swapping; the
   * user can keep editing the current file by cancelling.
   */
  private async openFileInEditor(path: string): Promise<void> {
    const overlay = this.root.querySelector<HTMLElement>(".file-preview");
    if (!overlay) return;

    // Discard-confirmation when the user opens a different file with
    // unsaved edits. Same file: re-opening is a no-op.
    if (this.openFilePath === path) {
      this.fileEditor?.focus();
      return;
    }
    if (this.fileEditor?.isDirty()) {
      const ok = window.confirm(
        `Discard unsaved changes to ${this.openFilePath}?`,
      );
      if (!ok) return;
    }
    this.disposeFileEditor();

    // The file preview is permanently mounted in the center pane;
    // opening just swaps the placeholder for the editor surface.
    overlay.innerHTML =
      `<div class="file-preview-header">` +
      `<span class="file-preview-dirty" data-dirty="false" aria-hidden="true">\u25cf</span>` +
      `<span class="file-preview-path" title="${escapeAttr(path)}">${escapeHtml(path)}</span>` +
      `<button class="file-preview-save" type="button" disabled aria-label="Save (\u2318S)" title="Save (\u2318S)">Save</button>` +
      `<button class="file-preview-close" type="button" aria-label="Close (Esc)" title="Close (Esc)">\u00d7</button>` +
      `</div>` +
      `<div class="file-preview-body"><div class="file-tree-loading">loading\u2026</div></div>`;

    overlay.querySelector(".file-preview-close")?.addEventListener(
      "click",
      () => this.closeFileEditor(),
    );
    overlay.querySelector(".file-preview-save")?.addEventListener(
      "click",
      () => void this.saveOpenFile(),
    );

    let loaded: { path: string; content: string; mtime_secs: number };
    try {
      loaded = await invoke<{
        path: string;
        original: string;
        content: string;
        size: number;
        mtime_secs: number;
      }>("read_file_text", { cwd: this.cwd, path });
    } catch (err) {
      const body = overlay.querySelector<HTMLElement>(".file-preview-body");
      if (body) body.innerHTML = renderSnippetError(String(err), path);
      this.openFilePath = null;
      this.openFileMtime = 0;
      return;
    }

    const body = overlay.querySelector<HTMLElement>(".file-preview-body");
    if (!body) return;
    body.innerHTML = "";
    this.openFilePath = path;
    this.openFileMtime = loaded.mtime_secs;
    this.fileEditor = new FileEditor(body, loaded.content, {
      onDirtyChange: (dirty) => this.reflectDirty(dirty),
    });
    // If we already have an audit report cached, push the matching
    // findings into the buffer so squiggles render immediately instead
    // of waiting for the next /audit run.
    this.refreshEditorDiagnostics();
    // Cmd+S only fires when the workspace is active AND the editor is
    // mounted; wired once in setupFileEditorKeybindings (called once
    // per workspace). Focus the buffer so the user can start typing
    // immediately.
    this.fileEditor.focus();
  }

  /**
   * Push the relevant slice of `lastAuditReport` into the open editor
   * as inline diagnostics. Findings are matched to the open file by
   * suffix — the audit may emit relative or absolute paths, the editor
   * may be holding a cwd-relative path, and we want both to line up
   * without forcing the model to canonicalize.
   */
  private refreshEditorDiagnostics(): void {
    if (!this.fileEditor || !this.openFilePath) return;
    const report = this.lastAuditReport;
    if (!report || report.findings.length === 0) {
      this.fileEditor.setDiagnostics([]);
      return;
    }
    const matches = findingsForOpenFile(this.openFilePath, report.findings);
    this.fileEditor.setDiagnostics(matches);
  }

  /**
   * Persist the currently open buffer to disk. No-op when nothing is
   * open or when the buffer is clean. Echoes the result into xterm so
   * the action is visible.
   */
  private async saveOpenFile(): Promise<void> {
    if (!this.fileEditor || !this.openFilePath) return;
    if (!this.fileEditor.isDirty()) return;
    const path = this.openFilePath;
    const content = this.fileEditor.getValue();
    try {
      const result = await invoke<{
        path: string;
        bytes_written: number;
        mtime_secs: number;
      }>("write_file_text", {
        cwd: this.cwd,
        path,
        content,
        expectedMtimeSecs: this.openFileMtime || null,
      });
      this.openFileMtime = result.mtime_secs;
      this.fileEditor.markClean(content);
      this.term.write(
        `\r\n\x1b[1;32m[edit]\x1b[0m \x1b[2msaved \x1b[36m${sanitize(prettyPath(result.path))}\x1b[0m\x1b[2m (${formatBytesShort(result.bytes_written)})\x1b[0m\r\n`,
      );
    } catch (err) {
      this.term.write(
        `\r\n\x1b[1;31m[edit]\x1b[0m save failed: ${sanitize(String(err))}\r\n`,
      );
    }
  }

  /**
   * Close the open file. Confirms before discarding unsaved changes.
   * Idempotent. The preview surface itself stays mounted \u2014 we just
   * swap back to the empty-state placeholder.
   */
  private closeFileEditor(): void {
    if (this.fileEditor?.isDirty()) {
      const ok = window.confirm(
        `Discard unsaved changes to ${this.openFilePath}?`,
      );
      if (!ok) return;
    }
    this.disposeFileEditor();
    const overlay = this.root.querySelector<HTMLElement>(".file-preview");
    if (!overlay) return;
    overlay.innerHTML = `<div class="file-preview-empty">No file open</div>`;
  }

  private disposeFileEditor(): void {
    this.fileEditor?.destroy();
    this.fileEditor = null;
    this.openFilePath = null;
    this.openFileMtime = 0;
  }

  /**
   * Update the dirty indicator + Save button state when the editor
   * tells us the buffer's dirty status flipped.
   */
  private reflectDirty(dirty: boolean): void {
    const dot = this.root.querySelector<HTMLElement>(".file-preview-dirty");
    if (dot) dot.dataset.dirty = dirty ? "true" : "false";
    const save = this.root.querySelector<HTMLButtonElement>(
      ".file-preview-save",
    );
    if (save) save.disabled = !dirty;
  }

  /**
   * Document-level Cmd/Ctrl+S handler that triggers a save when this
   * workspace is active and a file is open. Lives at the document
   * level so the shortcut works even when focus is in the terminal,
   * the input bar, or any other surface inside the workspace.
   */
  private setupFileEditorKeybindings(): void {
    const onKey = (e: KeyboardEvent) => {
      if (!this.root.classList.contains("active")) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "s" && e.key !== "S") return;
      if (!this.fileEditor || !this.openFilePath) return;
      e.preventDefault();
      void this.saveOpenFile();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    this.disposers.push(() =>
      document.removeEventListener("keydown", onKey, { capture: true }),
    );
  }

  // -- layout dividers -----------------------------------------------------

  /**
   * Wire pointer-drag, double-click-to-snap, and keyboard nudge
   * handlers on the three layout dividers (sidebar / problems-panel /
   * file-preview). Dividers write CSS custom properties on the
   * workspace root and persist on commit; visibility is driven
   * separately by `setDividerVisible` so a hidden panel never
   * exposes a draggable handle.
   */
  private setupLayoutDividers(): void {
    this.applyLayoutToDOM();
    const dividers = this.root.querySelectorAll<HTMLElement>(
      ".layout-divider[data-divider]",
    );
    for (const el of Array.from(dividers)) {
      const kind = (el.dataset.divider ?? "") as DividerKind;
      if (!isDividerKind(kind)) continue;
      this.wireDivider(el, kind);
    }

    // Global Cmd+Opt+[ / Cmd+Opt+] handler. The per-divider handler
    // already covers the case where a divider has DOM focus; this
    // catches the much more common case where the user just released
    // a drag and wants to keep nudging without re-focusing the 4px
    // handle. Falls back to the sidebar divider as a safe default
    // when nothing has been touched yet.
    const onGlobalKey = (e: KeyboardEvent) => {
      if (!this.root.classList.contains("active")) return;
      if (!(e.metaKey || e.ctrlKey) || !e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      // If a divider is already focused, its own listener handles it.
      const active = document.activeElement as HTMLElement | null;
      if (active && active.classList.contains("layout-divider")) return;
      const kind = this.lastActiveDivider ?? "sidebar";
      e.preventDefault();
      this.nudgeDivider(kind, e.key === "]" ? +KEYBOARD_NUDGE_PX : -KEYBOARD_NUDGE_PX);
    };
    document.addEventListener("keydown", onGlobalKey, { capture: true });
    this.disposers.push(() =>
      document.removeEventListener("keydown", onGlobalKey, { capture: true }),
    );
  }

  private wireDivider(el: HTMLElement, kind: DividerKind): void {
    const onPointerDown = (ev: PointerEvent) => {
      // Ignore non-primary pointers (right-click, middle-click) so a
      // user inspecting the divider with devtools doesn't start a drag.
      if (ev.button !== 0) return;
      ev.preventDefault();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const startSidebar = this.layout.sidebar_width;
      const startProblems = this.layout.problems_width;
      const startPreview = this.layout.preview_height;
      const startAgentPane = this.layout.agent_pane_width;
      el.setPointerCapture(ev.pointerId);
      el.classList.add("dragging");
      this.lastActiveDivider = kind;
      this.root.classList.add("layout-dragging");
      this.root.classList.add(
        kind === "preview" ? "layout-dragging-row" : "layout-dragging-col",
      );

      const onMove = (e: PointerEvent) => {
        if (kind === "sidebar") {
          // Drag right → wider sidebar.
          this.layout.sidebar_width = clampSidebar(startSidebar + (e.clientX - startX));
        } else if (kind === "problems") {
          // Drag left → wider problems panel.
          this.layout.problems_width = clampProblems(startProblems - (e.clientX - startX));
        } else if (kind === "preview") {
          // The divider sits BELOW the preview; drag down → taller preview.
          this.layout.preview_height = clampPreview(startPreview + (e.clientY - startY));
        } else if (kind === "pane") {
          // The divider sits to the LEFT of the agent pane; drag left
          // → wider agent pane (the center pane shrinks).
          this.layout.agent_pane_width = clampAgentPane(
            startAgentPane - (e.clientX - startX),
          );
        }
        this.applyLayoutToDOM();
        // Refit xterm during the drag so the terminal reflows in real
        // time \u2014 otherwise the user sees the gutter shrink/expand only
        // after release. Cheap; xterm internally rAFs.
        this.fitTerminal();
      };
      const onUp = (e: PointerEvent) => {
        el.releasePointerCapture(e.pointerId);
        el.classList.remove("dragging");
        this.root.classList.remove(
          "layout-dragging",
          "layout-dragging-row",
          "layout-dragging-col",
        );
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        void this.persistLayout();
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    };

    const onDblClick = (ev: MouseEvent) => {
      ev.preventDefault();
      // Snap to the default for this divider only — leave the others
      // where the user has them.
      if (kind === "sidebar") this.layout.sidebar_width = DEFAULT_LAYOUT.sidebar_width;
      else if (kind === "problems") this.layout.problems_width = DEFAULT_LAYOUT.problems_width;
      else if (kind === "preview") this.layout.preview_height = DEFAULT_LAYOUT.preview_height;
      else if (kind === "pane") this.layout.agent_pane_width = DEFAULT_LAYOUT.agent_pane_width;
      this.applyLayoutToDOM();
      this.fitTerminal();
      void this.persistLayout();
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || !ev.altKey) return;
      if (ev.key !== "[" && ev.key !== "]") return;
      ev.preventDefault();
      this.nudgeDivider(kind, ev.key === "]" ? +KEYBOARD_NUDGE_PX : -KEYBOARD_NUDGE_PX);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("dblclick", onDblClick);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("focus", () => {
      this.lastActiveDivider = kind;
    });
  }

  /**
   * Move the named divider by `delta` pixels in its primary axis.
   * Positive delta grows the visible adjacent pane (sidebar wider,
   * problems wider, preview taller).
   */
  private nudgeDivider(kind: DividerKind, delta: number): void {
    if (kind === "sidebar") {
      this.layout.sidebar_width = clampSidebar(this.layout.sidebar_width + delta);
    } else if (kind === "problems") {
      this.layout.problems_width = clampProblems(this.layout.problems_width + delta);
    } else if (kind === "preview") {
      this.layout.preview_height = clampPreview(this.layout.preview_height + delta);
    } else if (kind === "pane") {
      this.layout.agent_pane_width = clampAgentPane(
        this.layout.agent_pane_width + delta,
      );
    }
    this.applyLayoutToDOM();
    this.fitTerminal();
    void this.persistLayout();
  }

  /**
   * Toggle the visibility of a divider in tandem with its sibling pane.
   * Used when the file preview opens/closes and when the problems panel
   * is shown/hidden.
   */
  private setDividerVisible(kind: DividerKind, visible: boolean): void {
    const el = this.root.querySelector<HTMLElement>(
      `.layout-divider[data-divider="${kind}"]`,
    );
    if (!el) return;
    el.dataset.visible = visible ? "true" : "false";
  }

  /** Push the in-memory layout snapshot onto the workspace root as CSS vars. */
  private applyLayoutToDOM(): void {
    this.root.style.setProperty("--sidebar-width", `${this.layout.sidebar_width}px`);
    this.root.style.setProperty("--problems-width", `${this.layout.problems_width}px`);
    this.root.style.setProperty("--preview-height", `${this.layout.preview_height}px`);
    this.root.style.setProperty(
      "--agent-pane-width",
      `${this.layout.agent_pane_width}px`,
    );
  }

  /**
   * Persist the current layout into `state.json` via the merge helper.
   * Best-effort: a write failure is logged, never surfaced to the user
   * — a layout that fails to persist still works for the active session.
   */
  private async persistLayout(): Promise<void> {
    if (!this.cwd) return;
    const layout = { ...this.layout };
    await this.mergeWorkspaceState((s) => ({ ...s, layout }));
  }

  // -- save chat -----------------------------------------------------------

  /**
   * Open a file dialog and load a previously-saved Prism chat into this
   * tab. The Rust side parses the markdown frontmatter + sections and
   * seeds the session vector; the frontend then refreshes the model
   * badge and adopts the saved title.
   *
   * No "are you sure?" prompt for v1 — if the user cared about the
   * current chat they'd have hit /save first. We do log the prior
   * message count so the action is at least visible in xterm.
   */
  async loadChat(): Promise<void> {
    let target: string | null = null;
    try {
      const picked = await openDialog({
        title: "Load chat",
        // Project-local first so chats live alongside audit reports and
        // travel with the repo. Home Documents/Prism/Chats stays as a
        // fallback for users mid-tab who haven't established a cwd yet
        // and for legacy chats saved before this change.
        defaultPath: this.cwd
          ? `${this.cwd}/.prism/chats/`
          : expandTilde("~/Documents/Prism/Chats/"),
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      target = Array.isArray(picked) ? (picked[0] ?? null) : picked;
    } catch (e) {
      this.term.write(
        `\r\n\x1b[1;31m[load]\x1b[0m dialog failed: ${sanitize(String(e))}\r\n`,
      );
      return;
    }
    if (!target) return; // user cancelled
    await this.loadSavedChat(target);
  }

  /**
   * Load a chat from a known path WITHOUT opening the file dialog.
   * Same post-load behavior as `loadChat()`: refreshes the agent
   * session, adopts the saved title, prints the [load] confirmation,
   * and offers transcript replay. Public so callers like the Settings
   * UI history tab can reuse the workspace-refresh flow without
   * duplicating it.
   */
  async loadSavedChat(target: string): Promise<void> {
    const priorCount = this.agent.getMessageCount();
    let result: {
      message_count: number;
      title?: string | null;
      model?: string | null;
      source_chat_id?: string | null;
      created?: string | null;
    };
    try {
      result = await invoke("load_chat_markdown", {
        chatId: this.id,
        path: target,
      });
    } catch (e) {
      this.term.write(
        `\r\n\x1b[1;31m[load]\x1b[0m ${sanitize(String(e))}\r\n`,
      );
      return;
    }

    // Adopt the saved title if there is one and the tab is still
    // "New Tab" (don't clobber a deliberate title set later in this
    // session).
    if (result.title) {
      this.title = result.title.length > 36
        ? result.title.slice(0, 33) + "\u2026"
        : result.title;
      this.cb.onTitleChange(this.id, this.title);
    }
    await this.agent.refreshSession();

    const pretty = prettyPath(target);
    const overwroteNote =
      priorCount > 0
        ? ` \x1b[2m(replaced ${priorCount} prior message${priorCount === 1 ? "" : "s"})\x1b[0m`
        : "";
    // Leading blank line so the [load] block has clear visual
    // separation from whatever shell output preceded it.
    this.term.write(
      `\r\n\r\n\x1b[1;32m[load]\x1b[0m \x1b[2mloaded \x1b[36m${result.message_count}\x1b[0m\x1b[2m message${result.message_count === 1 ? "" : "s"} from \x1b[36m${sanitize(pretty)}\x1b[0m${overwroteNote}\r\n`,
    );
    if (result.model) {
      this.term.write(
        `\x1b[2m[load] saved model was \x1b[36m${sanitize(result.model)}\x1b[0m\x1b[2m \u2014 current tab uses \x1b[36m${sanitize(this.agent.getModel())}\x1b[0m\x1b[2m. Use /model to switch if desired.\x1b[0m\r\n`,
      );
    }
    // Trailing blank line so the next shell-emitted prompt (or the
    // user's first follow-up) doesn't sit flush against the [load]
    // body \u2014 same reasoning as the leading buffer above.
    this.term.write("\r\n");

    // Decide whether to render the transcript visually. A loaded chat
    // by default only seeds the model's context \u2014 the user sees only
    // the [load] confirmation and a fresh shell prompt. That can feel
    // like \"nothing happened\" on a chat with substantial history.
    // Offer to replay the messages into xterm so the user sees the
    // conversation they just loaded.
    if (this.renderLoadedChatPref === "always") {
      await this.renderLoadedTranscript();
    } else if (this.renderLoadedChatPref !== "never") {
      const decision = await this.askConfirm({
        title: "Render loaded transcript?",
        body: `${result.message_count} message${
          result.message_count === 1 ? "" : "s"
        } were loaded into this tab\u2019s context. Would you like to also replay the conversation visually in the terminal so you can re-read it?`,
      });
      if (decision.remember) {
        this.renderLoadedChatPref = decision.choice ? "always" : "never";
      }
      if (decision.choice) {
        await this.renderLoadedTranscript();
      }
    }
  }

  /**
   * Decision returned by the confirm modal.
   *   choice   \u2014 true = user picked Yes, false = user picked No
   *   remember \u2014 whether the user ticked the session-scoped
   *              \"don\u2019t ask again\" checkbox
   */
  private askConfirm(opts: {
    title: string;
    body: string;
  }): Promise<{ choice: boolean; remember: boolean }> {
    const dialog = this.root.querySelector<HTMLElement>(".confirm-dialog");
    if (!dialog) {
      // No DOM \u2014 default to No so we don't surprise the user.
      return Promise.resolve({ choice: false, remember: false });
    }
    const titleEl = dialog.querySelector<HTMLElement>(".confirm-dialog-title");
    const bodyEl = dialog.querySelector<HTMLElement>(".confirm-dialog-body");
    const remember = dialog.querySelector<HTMLInputElement>(
      "input[data-confirm-remember]",
    );
    if (titleEl) titleEl.textContent = opts.title;
    if (bodyEl) bodyEl.textContent = opts.body;
    if (remember) remember.checked = false;
    dialog.dataset.visible = "true";
    dialog.setAttribute("aria-hidden", "false");
    // Focus Yes by default so Enter accepts the friendlier outcome
    // (rendering is reversible \u2014 a /clear wipes the screen).
    queueMicrotask(() => {
      const yes = dialog.querySelector<HTMLButtonElement>(
        "[data-confirm='yes']",
      );
      yes?.focus();
    });
    return new Promise((resolve) => {
      const finish = (choice: boolean) => {
        dialog.dataset.visible = "false";
        dialog.setAttribute("aria-hidden", "true");
        const rememberValue = !!(remember && remember.checked);
        cleanup();
        resolve({ choice, remember: rememberValue });
      };
      const onClick = (e: Event) => {
        const t = e.target as HTMLElement | null;
        const decision = t?.getAttribute("data-confirm");
        if (decision === "yes") finish(true);
        else if (decision === "no") finish(false);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        } else if (e.key === "Enter") {
          // If focus is on the No button, Enter should mean No; otherwise Yes.
          const active = document.activeElement as HTMLElement | null;
          const decision = active?.getAttribute?.("data-confirm");
          finish(decision !== "no");
        }
      };
      const cleanup = () => {
        dialog.removeEventListener("click", onClick);
        document.removeEventListener("keydown", onKey, true);
      };
      dialog.addEventListener("click", onClick);
      document.addEventListener("keydown", onKey, true);
    });
  }

  /**
   * Replay the just-loaded conversation into xterm so the user can
   * re-read it. Walks the full history (including assistant tool_calls
   * + tool results when the chat was a v2 export) and writes each
   * message in the same style live conversation uses:
   *   user      \u2192 cyan `you \u203a` prefix + prose
   *   assistant \u2192 magenta `\u2732 assistant` header + prose
   *   tool-call \u2192 dim `\u2192 <tool>(<summary>)` log line
   *   tool      \u2192 dim `  \u2713 <preview>` line under the call
   * v1 chats produce only user + assistant turns (the format already
   * lacks tool messages); v2 chats produce the full chrome.
   */
  private async renderLoadedTranscript(): Promise<void> {
    let history: FullHistoryMessage[] = [];
    try {
      history = await this.agent.getHistoryFull();
    } catch (e) {
      this.term.write(
        `\r\n\x1b[1;31m[load]\x1b[0m render failed: ${sanitize(String(e))}\r\n`,
      );
      return;
    }
    if (history.length === 0) return;
    this.term.write(
      `\r\n\x1b[2m\u2500\u2500\u2500 transcript \u2500\u2500\u2500\x1b[0m\r\n`,
    );
    for (const m of history) {
      const content = (m.content ?? "").replace(/\r?\n/g, "\r\n");
      if (m.role === "user") {
        this.term.write(
          `\r\n\x1b[1;36myou\x1b[0m \x1b[2m\u203a\x1b[0m ${content}\r\n`,
        );
      } else if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length > 0) {
          // Dim header + per-call \u2192 line, mirroring agent.ts onToolCall.
          if (content.length > 0) {
            this.term.write(`\r\n${content}\r\n`);
          }
          for (const c of m.tool_calls) {
            const argPreview = c.function.arguments
              .replace(/\s+/g, " ")
              .slice(0, 80);
            this.term.write(
              `\r\n\x1b[2m\u2192\x1b[0m \x1b[2m\x1b[36m${c.function.name}\x1b[0m \x1b[2m${argPreview}\x1b[0m\r\n`,
            );
          }
        } else {
          this.term.write(
            `\r\n\x1b[1;35m\u2732 assistant\x1b[0m\r\n${content}\r\n`,
          );
        }
      } else if (m.role === "tool") {
        // Truncate large tool payloads so the transcript stays readable.
        const flat = content.replace(/\r\n/g, " ").trim();
        const preview =
          flat.length > 200 ? flat.slice(0, 197) + "\u2026" : flat;
        this.term.write(
          `  \x1b[32m\u2713\x1b[0m \x1b[2m${preview}\x1b[0m\r\n`,
        );
      }
    }
    this.term.write(
      `\r\n\x1b[2m\u2500\u2500\u2500 end transcript \u2500\u2500\u2500\x1b[0m\r\n\r\n`,
    );
  }

  async saveChat(full: boolean = false): Promise<void> {
    const count = this.agent.getMessageCount();
    if (count === 0) {
      this.term.write(
        "\r\n\x1b[2m[save] nothing to save \u2014 no chat messages yet\x1b[0m\r\n",
      );
      return;
    }
    const slug = slugify(this.title) || "chat";
    // Tag the filename with `.full.md` in v2 mode so the user can tell
    // a tool-aware export from a clean transcript at a glance in the
    // file dialog or finder.
    const ext = full ? "full.md" : "md";
    // Project-local default keeps chats next to the codebase they're
    // about, alongside audit reports under .prism/. Home fallback keeps
    // /save working before a cwd is established (e.g. a fresh tab where
    // the user runs /save before issuing any shell command). The save
    // dialog itself runs `mkdir -p` on the chosen directory at write
    // time, so neither path needs to pre-exist.
    const defaultPath = this.cwd
      ? `${this.cwd}/.prism/chats/${slug}-${shortStamp()}.${ext}`
      : expandTilde(`~/Documents/Prism/Chats/${slug}-${shortStamp()}.${ext}`);
    let target: string | null = null;
    try {
      target = await saveDialog({
        title: full ? "Save chat (full \u2014 includes tool history)" : "Save chat",
        defaultPath,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
    } catch (e) {
      this.term.write(`\r\n\x1b[1;31m[save]\x1b[0m dialog failed: ${String(e)}\r\n`);
      return;
    }
    if (!target) return; // user cancelled

    try {
      const result = await invoke<{
        path: string;
        message_count: number;
        bytes_written: number;
        format: string;
      }>("save_chat_markdown", {
        chatId: this.id,
        path: target,
        model: this.agent.getModel(),
        title: this.title,
        full,
      });
      const modeTag = result.format === "prism-chat-v2" ? " \x1b[2m(full)\x1b[0m" : "";
      this.term.write(
        `\r\n\x1b[1;32m[save]\x1b[0m wrote ${result.message_count} messages \u2192 \x1b[36m${sanitize(result.path)}\x1b[0m${modeTag}\r\n`,
      );
    } catch (e) {
      this.term.write(`\r\n\x1b[1;31m[save error]\x1b[0m ${String(e)}\r\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cryptoRandomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Turn an optional scope string (from `/audit <scope>`) into a user-role
 * prompt the Second Pass system prompt can work with. Scope can be:
 *   - empty         → audit the working tree against HEAD
 *   - a single ref  → audit that commit against its parent (e.g. HEAD~3)
 *   - a range       → audit the explicit range (e.g. HEAD~3..HEAD)
 *   - a @-path      → audit scoped to a particular file or directory
 * The actual interpretation is left to the audit persona — we just tell
 * it what the user asked for.
 */
function buildAuditPrompt(scope: string): string {
  if (!scope) {
    return "Audit the current working tree against HEAD. Look for refactor incompleteness and wiring gaps. Use git_diff, git_log, grep, find, and bulk_read to investigate before reporting. Output only the findings list.";
  }
  if (scope.startsWith("@")) {
    return `Audit ${scope} for refactor incompleteness and wiring gaps. Start by reading the file, then grep the repo for references to every symbol it exports or consumes. Output only the findings list.`;
  }
  if (scope.includes("..")) {
    return `Audit the git range ${scope} for refactor incompleteness. Start with git_diff on that range, then cross-reference touched symbols across the repo. Output only the findings list.`;
  }
  // Single ref — treat as "this commit vs its parent."
  return `Audit commit ${scope} (diff against ${scope}~1) for refactor incompleteness and wiring gaps. Start with git_diff on that range, then cross-reference touched symbols across the repo. Output only the findings list.`;
}

/**
 * Parse the argument tail of `/audit ...`. Supports an optional
 * `--max-rounds=N` (or `--max-rounds N`) flag that raises the tool-call
 * cap for this turn only; everything else is treated as the audit scope.
 *
 * Returns one of:
 *   - { scope, maxToolRounds }            — success; either or both may be empty
 *   - { scope: "", error: "…" }           — malformed flag value (NaN, < 1)
 *
 * The flag form is intentionally narrow: we don't try to cover every
 * possible CLI-style permutation. If users want a specific rounds value
 * they pass `--max-rounds=80` and we honor it; everything else is scope.
 */
function parseAuditArgs(raw: string): {
  scope: string;
  maxToolRounds?: number;
  error?: string;
} {
  if (!raw) return { scope: "" };
  const tokens = raw.split(/\s+/).filter(Boolean);
  let maxToolRounds: number | undefined;
  const scopeTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // --max-rounds=N
    const eqMatch = /^--max-rounds=(.+)$/.exec(t);
    if (eqMatch) {
      const n = Number(eqMatch[1]);
      if (!Number.isFinite(n) || n < 1) {
        return { scope: "", error: `--max-rounds expects a positive integer, got "${eqMatch[1]}"` };
      }
      maxToolRounds = Math.floor(n);
      continue;
    }
    // --max-rounds N (space-separated)
    if (t === "--max-rounds") {
      const next = tokens[i + 1];
      if (next === undefined) {
        return { scope: "", error: "--max-rounds expects a value (e.g. --max-rounds=80)" };
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        return { scope: "", error: `--max-rounds expects a positive integer, got "${next}"` };
      }
      maxToolRounds = Math.floor(n);
      i++; // consume the value token
      continue;
    }
    scopeTokens.push(t);
  }

  return { scope: scopeTokens.join(" "), maxToolRounds };
}

function shortModelName(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * Mirror of the Rust `WorkspaceState` struct in
 * `src-tauri/src/workspace_state.rs`. Kept in lockstep with that file;
 * additive changes don't need a version bump but renames or removals
 * do (see the `version` field).
 */
interface PersistedWorkspaceState {
  version: number;
  last_audit?: {
    path: string;
    generated_at: string;
    scope?: string | null;
    counts: {
      error: number;
      warning: number;
      info: number;
      confirmed: number;
      probable: number;
      candidate: number;
    };
  };
  last_build?: {
    path: string;
    generated_at: string;
    feature: string;
    status: "completed" | "incomplete" | "unknown";
    verification?: {
      typecheck?: string;
      tests?: string;
      http?: string;
    };
  };
  recent_files: { path: string; opened_at: string }[];
  layout?: {
    sidebar_width?: number;
    problems_width?: number;
    preview_height?: number;
    agent_pane_width?: number;
  };
}

/** Identifier for one of the resizable dividers. */
type DividerKind = "sidebar" | "problems" | "preview" | "pane";

function isDividerKind(s: string): s is DividerKind {
  return (
    s === "sidebar" ||
    s === "problems" ||
    s === "preview" ||
    s === "pane"
  );
}

/** In-memory representation of the persisted layout (no optional fields). */
interface LayoutPrefs {
  sidebar_width: number;
  problems_width: number;
  preview_height: number;
  /** Width of the right-hand agent pane (HTML chat surface). The
   *  center pane (file viewer + xterm) gets the remaining horizontal
   *  space. Resized via the vertical `.layout-divider-pane`. */
  agent_pane_width: number;
}

/** Defaults used when state.json carries no layout. */
const DEFAULT_LAYOUT: LayoutPrefs = {
  sidebar_width: 240,
  problems_width: 360,
  preview_height: 340,
  // The agent dialogue is the primary surface; the file viewer / xterm
  // strip in the center pane reads more like a workshop drawer that
  // opens when you need it. Default the agent pane to something
  // generous so prose has breathing room out of the box.
  agent_pane_width: 640,
};

/** Step size for Cmd+Opt+[/] keyboard nudges. */
const KEYBOARD_NUDGE_PX = 16;

/**
 * Min/max bounds for each axis. Min values keep the panes usable; max
 * values prevent a paranoid drag from taking over more than half the
 * viewport. The frontend clamps on every apply, so a corrupt
 * `state.json.layout` can't make panes unreachable.
 */
function clampSidebar(px: number): number {
  const max = Math.max(280, Math.floor(window.innerWidth * 0.5));
  return clampInt(px, 180, max);
}
function clampProblems(px: number): number {
  const max = Math.max(280, Math.floor(window.innerWidth * 0.5));
  return clampInt(px, 280, max);
}
function clampPreview(px: number): number {
  const max = Math.max(120, Math.floor(window.innerHeight * 0.7));
  return clampInt(px, 80, max);
}
function clampAgentPane(px: number): number {
  // Min keeps prose readable; max stops the user from zeroing out the
  // file viewer / xterm strip on the left.
  const max = Math.max(360, Math.floor(window.innerWidth * 0.8));
  return clampInt(px, 320, max);
}
function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function clampLayout(p: LayoutPrefs): LayoutPrefs {
  return {
    sidebar_width: clampSidebar(p.sidebar_width),
    problems_width: clampProblems(p.problems_width),
    preview_height: clampPreview(p.preview_height),
    agent_pane_width: clampAgentPane(p.agent_pane_width),
  };
}

/**
 * Sidestep the unexported `countByConfidence` in `findings.ts` so the
 * workspace can compute the same triple for `state.json.last_audit`
 * without a circular import. This duplicates a tiny amount of logic;
 * if findings.ts ever exports this directly, swap the call sites.
 */
function countByConfidenceShim(
  report: AuditReport,
): { confirmed: number; probable: number; candidate: number } {
  let confirmed = 0;
  let probable = 0;
  let candidate = 0;
  for (const f of report.findings) {
    if (f.confidence === "confirmed") confirmed++;
    else if (f.confidence === "probable") probable++;
    else candidate++;
  }
  return { confirmed, probable, candidate };
}

/**
 * Project an audit report's findings down to the editor-diagnostic
 * shape, restricted to those matching the file the editor currently
 * has open. Match is suffix-based: the audit may emit absolute or
 * cwd-relative paths and the editor may hold either form, so as long
 * as one path ends with the other (after stripping leading slashes)
 * we treat it as the same file. Basename equality is the floor so a
 * model that drops the directory prefix still produces useful
 * squiggles.
 */
function findingsForOpenFile(
  openPath: string,
  findings: Finding[],
): EditorDiagnostic[] {
  const open = stripLeadingSlash(openPath);
  const openBase = basename(open);
  const out: EditorDiagnostic[] = [];
  for (const f of findings) {
    if (!f.file) continue;
    const file = stripLeadingSlash(f.file);
    const fileBase = basename(file);
    const matches =
      file === open ||
      open.endsWith("/" + file) ||
      file.endsWith("/" + open) ||
      (fileBase.length > 0 && fileBase === openBase);
    if (!matches) continue;
    out.push({
      line: f.line > 0 ? f.line : 1,
      severity: f.severity,
      message:
        f.description +
        (f.suggested_fix ? `  \u2014 fix: ${f.suggested_fix}` : ""),
      source: "audit",
    });
  }
  return out;
}

function stripLeadingSlash(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Convert an absolute path under cwd to a cwd-relative path. The
 * fallback (return the absolute path) preserves correctness if the
 * artifact happens to live outside cwd, e.g. when the user passes a
 * symlinked workspace; consumers will accept either form.
 */
function relativeToCwd(absolute: string, cwd: string): string {
  if (!cwd) return absolute;
  const cwdNormalized = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return absolute.startsWith(cwdNormalized)
    ? absolute.slice(cwdNormalized.length)
    : absolute;
}

function sanitize(s: string): string {
  return s.replace(/\x1b|\x07/g, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, " ");
}

function formatDuration(b: Block): string {
  const end = b.finishedAt ?? Date.now();
  const ms = Math.max(0, end - b.startedAt);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem}s`;
}

function renderHistoryAnsi(msgs: { role: string; content: string }[]): string {
  if (msgs.length === 0) {
    return "\x1b[2m[agent] no conversation yet.\x1b[0m\r\n";
  }
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const CYAN = "\x1b[36m";
  const MAGENTA = "\x1b[35m";
  const out: string[] = [];
  out.push(`${BOLD}Conversation${RESET} ${DIM}(${msgs.length} msgs)${RESET}`);
  for (const m of msgs) {
    const label =
      m.role === "user"
        ? `${CYAN}${BOLD}you${RESET}`
        : m.role === "assistant"
          ? `${MAGENTA}${BOLD}agent${RESET}`
          : `${DIM}${m.role}${RESET}`;
    const content = m.content.replace(/\r?\n/g, "\r\n");
    out.push(`\r\n\u2500\u2500 ${label} \u2500\u2500\r\n${content}`);
  }
  return out.join("") + "\r\n";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function shortStamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Compact byte formatter for status lines. */
function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parse an OSC 7 data payload ("file://HOST/PATH") into a plain absolute
 *  path. Returns null if malformed. */
function parseOsc7(data: string): string | null {
  // Strip optional "file://" scheme.
  let s = data.trim();
  const fileIdx = s.toLowerCase().indexOf("file://");
  if (fileIdx === 0) s = s.slice("file://".length);
  // Drop host portion up to the first "/".
  const slashIdx = s.indexOf("/");
  if (slashIdx < 0) return null;
  const rawPath = s.slice(slashIdx);
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

/** Abbreviate `/Users/stevenmorales/...` -> `~/...` for display. */
function prettyPath(p: string): string {
  // We don't have $HOME directly in the webview, but we can recover it from
  // the path structure: macOS home dirs live under /Users/<name>/. If the
  // path matches, replace that prefix with `~`.
  const m = /^(\/Users\/[^/]+)(?=\/|$)/.exec(p);
  if (m) return "~" + p.slice(m[1].length);
  return p;
}

/** Truncate a string from the LEFT with a leading "…" when over `max`. */
function truncateLeft(s: string, max: number): string {
  if (s.length <= max) return s;
  return "\u2026" + s.slice(-(max - 1));
}

/** One queued image attachment waiting to be included with the next query. */
interface PendingImage {
  id: string;
  name: string;
  dataUrl: string;
  sizeBytes: number;
}

/** Read a File as a base64-encoded data URL (data:image/png;base64,...). */
function fileToDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Expand a leading `~` to the user's home dir. Best-effort: we use the HOME
 *  env var via Tauri's expand later; here we just leave it for the dialog. */
function expandTilde(p: string): string {
  // The save dialog on macOS supports absolute paths. We keep tilde and let
  // Tauri/AppKit resolve it, but as a defensive fallback rewrite it.
  if (!p.startsWith("~/")) return p;
  // Best we can do without a dedicated command \u2014 defer to dialog behavior.
  return p;
}
