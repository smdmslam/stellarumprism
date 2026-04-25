// A single tab's worth of state and DOM: one shell session, one chat session,
// one xterm, one block manager, one editor, one agent controller.
//
// The TabManager owns an array of these and swaps visibility.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import "@xterm/xterm/css/xterm.css";

import { BlockManager, type Block } from "./blocks";
import { PrismInput } from "./editor";
import type { IntentResult } from "./intent";
import { AgentController, type AgentImageContext } from "./agent";
import { resolveModel, renderModelListAnsi, modelSupportsVision } from "./models";
import { renderHelpAnsi } from "./slash-commands";
import { extractFileRefs, resolveFileRefs } from "./file-refs";
import { findMode, type Mode } from "./modes";
import {
  auditReportFilename,
  parseAuditTranscript,
  renderAnsiFindings,
  renderJsonReport,
  renderMarkdownReport,
  type AuditReport,
  type Confidence,
  type RuntimeProbe,
  type Severity,
  type SubstrateRun,
} from "./findings";
import { buildFixPrompt, filterFindings, parseFixArgs } from "./fix";
import { buildBuildPrompt, parseBuildArgs } from "./build";
import { buildRefactorPrompt, parseRefactorArgs } from "./refactor";
import { buildTestGenPrompt, parseTestGenArgs } from "./test-gen";
import { buildNewPrompt, parseNewArgs } from "./new";
import {
  defaultFilter as defaultProblemsFilter,
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

/**
 * Pixels of breathing room to reserve on the right of the terminal so the
 * xterm scrollbar never sits on top of glyphs. We translate this into a
 * column count in fitTerminalWithGutter() — CSS padding alone wouldn't
 * work because FitAddon would just re-fit more columns into the padded box.
 */
const SCROLLBAR_GUTTER_PX = 24;

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
}

export class Workspace {
  readonly id: string; // same as PTY session id + agent chat id
  readonly root: HTMLElement;

  private title = "New Tab";
  private cwd = ""; // populated by OSC 7 from the shell integration
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
   * Filter state for the Problems panel. Held on the workspace so a
   * user-toggled chip stays toggled across re-renders.
   */
  private problemsFilter: ProblemsFilter = defaultProblemsFilter();
  /** Whether the Problems panel is currently visible. */
  private problemsVisible = false;
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
  private activeSidebarTab: "blocks" | "files" = "blocks";
  /** True iff `refreshFileTreeRoot` has been called for this cwd. */
  private fileTreeRootLoaded = false;
  /** Last cwd we built the tree for, so we can detect cwd changes. */
  private fileTreeLastCwd = "";
  private readonly cb: WorkspaceCallbacks;

  private term!: Terminal;
  private fit!: FitAddon;
  private blocks!: BlockManager;
  private input!: PrismInput;
  private agent!: AgentController;
  private resizeObserver: ResizeObserver | null = null;

  private readonly disposers: UnlistenFn[] = [];
  private disposed = false;
  private initPromise: Promise<void>;

  constructor(parent: HTMLElement, cb: WorkspaceCallbacks) {
    this.id = cryptoRandomId();
    this.cb = cb;

    // Build DOM subtree for this workspace.
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.dataset.id = this.id;
    this.root.innerHTML = `
      <aside class="blocks-sidebar">
        <div class="sidebar-tabs" role="tablist" aria-label="Sidebar">
          <button class="sidebar-tab active" data-tab="blocks" role="tab" aria-selected="true">Blocks <span class="sidebar-tab-count blocks-count">0</span></button>
          <button class="sidebar-tab" data-tab="files" role="tab" aria-selected="false">Files</button>
        </div>
        <div class="sidebar-pane sidebar-pane-blocks" data-tab="blocks">
          <ul class="blocks-list"></ul>
        </div>
        <div class="sidebar-pane sidebar-pane-files" data-tab="files" hidden>
          <div class="file-tree" tabindex="0" role="tree" aria-label="Project files"></div>
        </div>
      </aside>
      <div class="content">
        <div class="file-preview" data-visible="false" aria-hidden="true"></div>
        <div class="terminal-host"></div>
        <div class="agent-actions"></div>
        <div class="attachments"></div>
        <div class="input-bar">
          <span class="input-prefix" data-intent="command">\u276f</span>
          <span class="cwd-badge" title="Current working directory"></span>
          <div class="editor-host"></div>
          <span class="model-badge" title="Agent model">\u2026</span>
          <button class="busy-pill" type="button" title="Cancel agent request" aria-label="cancel agent request"><span class="busy-dot"></span><span class="busy-label">cancel</span></button>
          <span class="intent-badge" data-intent="command">CMD</span>
        </div>
      </div>
      <aside class="problems-panel" data-visible="false" aria-hidden="true"></aside>
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
    this.fitTerminalWithGutter();
    queueMicrotask(() => this.input?.focus());
  }

  deactivate(): void {
    this.root.classList.remove("active");
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
    const host = this.root.querySelector<HTMLDivElement>(".terminal-host")!;

    this.term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: TERM_THEME,
      scrollback: 10000,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(host);
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
        // cwd changed \u2014 the file tree is now stale. We don't proactively
        // re-fetch (might be a transient `cd`); the next time the Files
        // tab is shown, it'll lazy-load.
        if (this.fileTreeLastCwd !== parsed) {
          this.fileTreeRootLoaded = false;
          if (this.activeSidebarTab === "files") {
            void this.refreshFileTreeRoot();
          }
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

    this.disposers.push(
      await listen<string>(`pty-output-${this.id}`, (e) => {
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
      // rAF so layout has settled before proposeDimensions() reads widths.
      requestAnimationFrame(() => this.fitTerminalWithGutter());
    });
    this.resizeObserver.observe(host);

    // Agent + editor.
    this.agent = new AgentController({
      term: this.term,
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
    });
    this.setupEditor();
    this.setupAttachments();
    this.setupSlashFocusHijack();
    this.setupBusyPill();
    this.setupProblemsPanel();
    this.updateModelBadge();
  }

  /**
   * Fit xterm to the host, then shave a few columns off the right so a real
   * breathing-room gutter exists between the last glyph and the scrollbar.
   * CSS padding alone can't achieve this: FitAddon just re-fits more columns
   * into whatever width you give it, so the last column always lands under
   * the scrollbar thumb.
   *
   * Strictly non-recursive: if the host isn't laid out yet (tab hidden,
   * window minimized, initial mount) we bail out and wait for the next
   * ResizeObserver tick.
   */
  private fitTerminalWithGutter(): void {
    if (!this.fit || !this.term) return;
    const host = this.root.querySelector<HTMLDivElement>(".terminal-host");
    if (!host) return;
    if (host.clientWidth <= 0 || host.clientHeight <= 0) return;

    const dims = this.fit.proposeDimensions();
    if (
      !dims ||
      !Number.isFinite(dims.cols) ||
      !Number.isFinite(dims.rows) ||
      dims.cols < 2 ||
      dims.rows < 2
    ) {
      return;
    }

    // Ratio math keeps us off xterm's internal _core / _renderService APIs.
    const pxPerCol = host.clientWidth / dims.cols;
    const gutterCols = pxPerCol > 0
      ? Math.max(1, Math.ceil(SCROLLBAR_GUTTER_PX / pxPerCol))
      : 3;
    const cols = Math.max(2, dims.cols - gutterCols);
    if (cols !== this.term.cols || dims.rows !== this.term.rows) {
      this.term.resize(cols, dims.rows);
    }
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
        if (key === "EOF" && !isShellBusy()) return false;
        const byte = key === "SIGINT" ? "\x03" : key === "EOF" ? "\x04" : "\x1a";
        void invoke("write_to_shell", { sessionId: this.id, data: byte });
        return true;
      },
      // Let the @path autocomplete source ask for our current cwd on demand.
      getCwd: () => this.cwd,
    });

    // Click anywhere in the input bar (but outside the badges) refocuses.
    this.root.querySelector(".input-bar")?.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("intent-badge") || t.classList.contains("model-badge")) return;
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
    if (/^\s*\/save\s*$/i.test(text)) {
      void this.saveChat();
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
      options,
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

  /** Show/hide the busy pill and refocus the editor when going idle
   * (so the next prompt is ready to type without clicking). */
  private setBusyState(busy: boolean): void {
    const pill = this.root.querySelector<HTMLButtonElement>(".busy-pill");
    if (!pill) return;
    if (busy) {
      pill.classList.add("visible");
      pill.classList.remove("stalled");
    } else {
      pill.classList.remove("visible");
      pill.classList.remove("stalled");
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
    this.renderProblemsPanelInto();
  }

  private hideProblemsPanel(): void {
    this.problemsVisible = false;
    const panel = this.root.querySelector<HTMLElement>(".problems-panel");
    if (!panel) return;
    panel.dataset.visible = "false";
    panel.setAttribute("aria-hidden", "true");
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
      }
    } catch (e) {
      this.term.write(
        `\r\n\x1b[1;31m[audit]\x1b[0m report write failed: ${sanitize(String(e))}\r\n`,
      );
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
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        ".sidebar-tab",
      );
      if (!btn) return;
      const tab = btn.dataset.tab as "blocks" | "files" | undefined;
      if (!tab) return;
      this.setSidebarTab(tab);
    });
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
        // Single click on a file = preview. Phase 2 will swap this
        // for a real editor tab.
        void this.openFilePreview(path);
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
          void this.openFilePreview(sel);
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
        showHidden: false,
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
          showHidden: false,
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

  // -- file preview overlay (phase 1; phase 2 replaces with editor) --------

  /**
   * Show a read-only preview of a file. Uses `read_file_snippet` with
   * a wide window so the user sees the top of the file. Phase 2 will
   * swap this for a real CodeMirror tab.
   */
  private async openFilePreview(path: string): Promise<void> {
    const overlay = this.root.querySelector<HTMLElement>(".file-preview");
    if (!overlay) return;
    overlay.dataset.visible = "true";
    overlay.setAttribute("aria-hidden", "false");
    overlay.innerHTML =
      `<div class="file-preview-header">` +
      `<span class="file-preview-path">${escapeHtml(path)}</span>` +
      `<button class="file-preview-close" type="button" aria-label="Close preview">\u00d7</button>` +
      `</div>` +
      `<div class="file-preview-body"><div class="file-tree-loading">loading\u2026</div></div>`;
    overlay.querySelector(".file-preview-close")?.addEventListener(
      "click",
      () => this.closeFilePreview(),
      { once: true },
    );
    try {
      const snippet = await invoke<FileSnippet>("read_file_snippet", {
        cwd: this.cwd,
        path,
        line: 1,
        before: 0,
        after: 80,
      });
      const body = overlay.querySelector<HTMLElement>(".file-preview-body");
      if (body) body.innerHTML = renderSnippet(snippet);
    } catch (err) {
      const body = overlay.querySelector<HTMLElement>(".file-preview-body");
      if (body) body.innerHTML = renderSnippetError(String(err), path);
    }
  }

  private closeFilePreview(): void {
    const overlay = this.root.querySelector<HTMLElement>(".file-preview");
    if (!overlay) return;
    overlay.dataset.visible = "false";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = "";
  }

  // -- save chat -----------------------------------------------------------

  async saveChat(): Promise<void> {
    const count = this.agent.getMessageCount();
    if (count === 0) {
      this.term.write(
        "\r\n\x1b[2m[save] nothing to save \u2014 no chat messages yet\x1b[0m\r\n",
      );
      return;
    }
    const slug = slugify(this.title) || "chat";
    const defaultPath = `~/Documents/Prism/Chats/${slug}-${shortStamp()}.md`;
    let target: string | null = null;
    try {
      target = await saveDialog({
        title: "Save chat",
        defaultPath: expandTilde(defaultPath),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
    } catch (e) {
      this.term.write(`\r\n\x1b[1;31m[save]\x1b[0m dialog failed: ${String(e)}\r\n`);
      return;
    }
    if (!target) return; // user cancelled

    try {
      const result = await invoke<{ path: string; message_count: number; bytes_written: number }>(
        "save_chat_markdown",
        {
          chatId: this.id,
          path: target,
          model: this.agent.getModel(),
          title: this.title,
        },
      );
      this.term.write(
        `\r\n\x1b[1;32m[save]\x1b[0m wrote ${result.message_count} messages \u2192 \x1b[36m${sanitize(result.path)}\x1b[0m\r\n`,
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
