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
import { openPath } from "@tauri-apps/plugin-opener";
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
import {
  modelCompletions,
  renderHelpAnsi,
  renderHelpMarkdown,
  renderModelsMarkdown,
} from "./slash-commands";
import { listSkills, readSkill, renderSkillsMarkdown, type SkillBody, type SkillSummary } from "./skills";
import { decideEngagement, formatKB, SESSION_SKILL_BUDGET_BYTES } from "./skill-limits";
import { extractFileRefs, resolveFileRefs } from "./file-refs";
import { settings } from "./settings";
import { findMode, type Mode } from "./modes";
import { RECIPES, findRecipe } from "./recipes";
import { runRecipe } from "./recipes/runner";
import type { StepResult } from "./recipes/types";
import {
  ProtocolReportCard,
  summaryFromSteps,
} from "./protocol-report-card";
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
  removePathsFromTree,
  renamePathInTree,
  setChildren,
  setError as setTreeError,
  setLoading as setTreeLoading,
  setRoot as setTreeRoot,
  updateSelection,
  toggleExpanded,
  type RawTreeListing,
  type TreeState,
  type VisibleRow,
} from "./file-tree";
import { readerUI } from "./reader-ui";

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
  /**
   * Fired whenever a layout toggle (sidebar, terminal, etc.) changes.
   * TabManager subscribes to trigger a debounced session write.
   */
  onLayoutChange?: (id: string) => void;
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
  /** Transient internal hint to load a specific MD file on boot. Used
   *  by Duplicate Session to rehydrate the copied history. */
  loadChatPath?: string;
  sidebarVisible?: boolean;
  previewVisible?: boolean;
  terminalVisible?: boolean;
  consoleVisible?: boolean;
  agentVisible?: boolean;
}

export class Workspace {
  readonly id: string; // same as PTY session id + agent chat id
  readonly root: HTMLElement;

  private title = "New Tab";
  /** True if we have already auto-titled this tab based on user input. */
  private autoTitleDone = false;
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
  /** Keywords from the previous plain-chat user prompt (topic-shift nudge heuristic). */
  private lastChatTopicKeywords: string[] = [];
  /** Prevent repeated "topic changed" nudges in one conversation. */
  private topicShiftNudged = false;
  /** Prevent repeated "long thread" nudges in one conversation. */
  private longThreadNudged = false;
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
   * Per-tab engaged-skills state (Track A intentional engagement, see
   * `MASTER-Plan-II#7.2` and `docs/skills.md`). Map keys are slugs;
   * values are the full body + metadata so we don't re-read from disk
   * on every agent turn. Engagement is intentionally NOT persisted to
   * `state.json` or `localStorage` \u2014 ephemeral per `docs/skills.md`.
   */
  private engagedSkills: Map<string, SkillBody> = new Map();
  /**
   * Track B awareness state (`MASTER-Plan-II#7.3`). When true, the
   * agent's system prompt gets a manifest of available skills (slug +
   * description, excluding already-engaged ones) plus the `read_skill`
   * tool is meaningful in context. When false, the LLM has no idea
   * skills exist \u2014 acts as a pure agent.
   *
   * Per-tab + ephemeral by design; not persisted across restarts.
   * Default OFF so first-launch users aren't silently paying manifest
   * tokens until they discover the feature.
   */
  private skillsAware = false;
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
  private showFileSizes = true;
  private showFileModified = false;
  private sidebarVisible = true;
  private previewVisible = true;
  private terminalVisible = true;
  private consoleVisible = true;
  private agentVisible = true;
  /** True if visibility was explicitly set by restore options (session.json). */
  private visibilityRestored = false;
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
      // If we have a real title from a restored session, don't auto-title
      // over it unless it's just the generic "New Tab".
      if (this.title !== "New Tab") {
        this.autoTitleDone = true;
      }
    }

    if (restore.sidebarVisible !== undefined) { this.sidebarVisible = restore.sidebarVisible; this.visibilityRestored = true; }
    if (restore.previewVisible !== undefined) { this.previewVisible = restore.previewVisible; this.visibilityRestored = true; }
    if (restore.terminalVisible !== undefined) { this.terminalVisible = restore.terminalVisible; this.visibilityRestored = true; }
    if (restore.consoleVisible !== undefined) { this.consoleVisible = restore.consoleVisible; this.visibilityRestored = true; }
    if (restore.agentVisible !== undefined) { this.agentVisible = restore.agentVisible; this.visibilityRestored = true; }

    // Build DOM subtree for this workspace.
    this.root = document.createElement("div");
    this.root.className = "workspace";
    this.root.dataset.id = this.id;
    this.root.classList.toggle("sidebar-hidden", !this.sidebarVisible);
    this.root.classList.toggle("preview-hidden", !this.previewVisible);
    this.root.classList.toggle("terminal-hidden", !this.terminalVisible);
    this.root.classList.toggle("console-hidden", !this.consoleVisible);
    this.root.classList.toggle("agent-hidden", !this.agentVisible);

    this.root.innerHTML = `
      <aside class="blocks-sidebar">
        <div class="sidebar-tabs" role="tablist" aria-label="Sidebar">
          <button class="sidebar-tab active" data-tab="files" role="tab" aria-selected="true">Files</button>
          <button class="sidebar-tab" data-tab="blocks" role="tab" aria-selected="false">Blocks <span class="sidebar-tab-count blocks-count">0</span></button>
          <span class="sidebar-tabs-spacer"></span>
          <button class="sidebar-tab-action" data-action="refresh-files" type="button" title="Refresh file tree" aria-label="Refresh files">\u21bb</button>
          <button class="sidebar-tab-action" data-action="toggle-hidden" type="button" title="Show hidden files (.git, .env, \u2026)" aria-label="Show hidden files" aria-pressed="false">\u25cb</button>
          <button class="sidebar-tab-action" data-action="toggle-file-view-options" type="button" title="File options" aria-label="File options" aria-haspopup="menu" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-.33-1A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1-.33H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1-.33A1.65 1.65 0 0 0 4.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 .33 1 1.65 1.65 0 0 0 1 .6 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 8c0 .39.14.76.4 1 .26.26.62.4 1 .4H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1 .33c-.26.24-.4.61-.51 1.27z"/></svg>
          </button>
          <div class="file-view-options-menu" role="menu" hidden>
            <div class="file-menu-section-label">Create</div>
            <button class="file-menu-item" data-action="new-file" type="button" role="menuitem">
              <svg class="file-menu-item-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6"/><path d="M9 15h6"/></svg>
              <span class="file-menu-item-label">New file</span>
            </button>
            <button class="file-menu-item" data-action="new-folder" type="button" role="menuitem">
              <svg class="file-menu-item-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 11v6"/><path d="M9 14h6"/></svg>
              <span class="file-menu-item-label">New folder</span>
            </button>
            <div class="file-menu-divider" role="separator"></div>
            <div class="file-menu-section-label">View</div>
            <label class="file-menu-item file-menu-item-toggle">
              <input type="checkbox" data-view-option="size" />
              <span class="file-menu-item-label">Show file sizes</span>
            </label>
            <label class="file-menu-item file-menu-item-toggle">
              <input type="checkbox" data-view-option="modified" />
              <span class="file-menu-item-label">Show modified dates</span>
            </label>
          </div>
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
          <div class="layout-divider layout-divider-preview" data-divider="preview" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="Resize file viewer and terminal"></div>
          <div class="terminal-host">
            <div class="terminal-stage"></div>
          </div>
        </div>
        <div class="layout-divider layout-divider-pane" data-divider="pane" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize agent pane"></div>
        <div class="agent-pane">
          <div class="agent-toolbar" aria-label="Agent controls">
            <div class="agent-toolbar-title">
              <span class="agent-toolbar-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </span>
              <span>Agent</span>
            </div>
            <div class="agent-toolbar-actions">
              <button class="strict-toggle" type="button" data-strict="true" title="Always Verify: force grounded instructions and the verifier pass on every agent turn. Auto Verify: Prism still auto-grounds inspectable factual prompts, with less latency." aria-label="Verification mode" aria-pressed="true">
                <span class="strict-toggle-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>
                </span>
                <span class="strict-toggle-label">Always Verify</span>
              </button>
              <button class="skills-toggle" type="button" data-aware="false" title="Toggle skills awareness — when on, the agent can request user-curated skills via the read_skill tool (each request is approved). Off by default." aria-label="Skills awareness" aria-pressed="false">skills off</button>
            </div>
          </div>
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
              <div class="pill-group">
                <span class="model-badge" title="Agent model" role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Active model">...</span>
                <div class="model-selector-menu" role="menu" hidden></div>
              </div>

              <button class="busy-pill" type="button" title="Cancel agent request" aria-label="Cancel agent request"><span class="busy-dot"></span><span class="busy-label">cancel</span></button>

              <div class="pill-group">
                <span class="intent-badge" data-intent="command" role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Input mode">CMD</span>
                <div class="intent-selector-menu" role="menu" hidden>
                  <div class="intent-selector-item" data-intent="command">
                    <span class="intent-item-label">CMD</span>
                    <span class="intent-item-detail">Run shell commands</span>
                  </div>
                  <div class="intent-selector-item" data-intent="agent">
                    <span class="intent-item-label">ASK</span>
                    <span class="intent-item-detail">Talk to the AI agent</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="skill-chips-row" aria-label="Engaged skills" hidden></div>
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
    this.cb.onLayoutChange?.(this.id);
  }

  public togglePreview(): void {
    this.previewVisible = !this.previewVisible;
    if (this.layout) this.layout.preview_visible = this.previewVisible;
    this.root.classList.toggle("preview-hidden", !this.previewVisible);
    if (this.terminalVisible) this.fitTerminal();
    void this.persistLayout();
    this.syncPreviewDividerAccessibility();
    this.cb.onLayoutChange?.(this.id);
  }

  public toggleTerminal(): void {
    this.terminalVisible = !this.terminalVisible;
    if (this.layout) this.layout.terminal_visible = this.terminalVisible;
    this.root.classList.toggle("terminal-hidden", !this.terminalVisible);
    if (this.terminalVisible) this.fitTerminal();
    void this.persistLayout();
    this.syncPreviewDividerAccessibility();
    this.cb.onLayoutChange?.(this.id);
  }

  public toggleConsole(): void {
    this.consoleVisible = !this.consoleVisible;
    this.root.classList.toggle("console-hidden", !this.consoleVisible);
    this.cb.onLayoutChange?.(this.id);
  }

  public toggleAgent(): void {
    this.agentVisible = !this.agentVisible;
    if (this.layout) this.layout.agent_visible = this.agentVisible;
    this.root.classList.toggle("agent-hidden", !this.agentVisible);
    this.fitTerminal();
    void this.persistLayout();
    this.cb.onLayoutChange?.(this.id);
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

    // Sync with Reader UI (Star indicators)
    readerUI.setOnChange(() => {
      this.renderFileTree();
    });

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
      await listen<string>("billing-alert", (e) => {
        this.notifyError(`[billing] ${e.payload}`);
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
      onToolExecuted: (info) => {
        void this.handleToolExecuted(info);
      },
      // Track B: lets the read_skill approval card filter already-
      // engaged skills out of the "consider also" list.
      getEngagedSkillSlugs: () => Array.from(this.engagedSkills.keys()),
      // Track B: when the user picks additional skills from the
      // approval card, engage them directly (the LLM only requested
      // the primary; alternatives don't round-trip the LLM tool).
      onAdditionalSkillsEngage: (slugs) => {
        for (const slug of slugs) {
          void this.engageSkill(slug);
        }
      },
    });
    this.setupEditor();
    this.setupAttachments();
    this.setupSlashFocusHijack();
    this.setupBusyPill();
    this.setupProblemsPanel();
    this.setupLayoutDividers();
    this.setupFileEditorKeybindings();
    this.setupBadges();
    this.updateModelBadge();
    this.updateSkillsToggleUI();
    this.updateStrictToggleUI();

    const handleSettingsChange = () => {
      if (this.term) {
        if (this.term.options.fontSize !== settings.getTerminalFontSize()) {
          this.term.options.fontSize = settings.getTerminalFontSize();
          requestAnimationFrame(() => this.fitTerminal());
        }
      }
      this.updateStrictToggleUI();
    };
    window.addEventListener("prism-settings-changed", handleSettingsChange);
    this.disposers.push(() => window.removeEventListener("prism-settings-changed", handleSettingsChange));

    // Duplicate Full Session: when a tab is opened with a `loadChatPath`
    // restore hint, the prior tab serialized its history to a temp
    // markdown file and is asking us to seed this new tab with it.
    // Suppress the \"render loaded transcript?\" modal \u2014 the user
    // already chose to duplicate, a second confirmation is noise. Best-
    // effort delete the temp file after, regardless of load success;
    // leaving the temp behind has no value once we've taken our shot.
    if (this.restore.loadChatPath) {
      const tempPath = this.restore.loadChatPath;
      this.renderLoadedChatPref = "never";
      try {
        await this.loadSavedChat(tempPath);
        this.agentView?.appendNotice(
          "router",
          "Duplicated session from prior tab",
        );
      } catch (e) {
        console.warn("[duplicate] load failed", e);
      }
      void invoke("remove_file", { cwd: "", path: tempPath }).catch(() => {});
    }
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
  }

  private setupBadges(): void {
    const modelBadge = this.root.querySelector<HTMLElement>(".model-badge")!;
    const intentBadge = this.root.querySelector<HTMLElement>(".intent-badge")!;
    const skillsToggle = this.root.querySelector<HTMLButtonElement>(".skills-toggle");
    const strictToggle = this.root.querySelector<HTMLButtonElement>(".strict-toggle");

    intentBadge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleIntentMenu();
    });

    modelBadge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleModelMenu();
    });
    skillsToggle?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleSkillsAwareness();
    });
    strictToggle?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleStrictMode();
    });

    // Delegate menu item clicks.
    this.root.querySelector(".input-meta")?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      
      const modelItem = target?.closest<HTMLElement>(".model-selector-item");
      if (modelItem) {
        const slug = modelItem.dataset.slug;
        if (slug) {
          // Route through handleSubmit so the `/model <slug>` branch in
          // the slash-command dispatcher is the single source of truth
          // (resolveModel + agent.setModel + notify). Mirrors how the
          // recipe runner dispatches slashes via handleSubmit.
          const cmd = `/model ${slug}`;
          this.handleSubmit(cmd, { intent: "command", explicit: true, payload: cmd });
          this.hidePillMenus();
        }
        return;
      }

      const intentItem = target?.closest<HTMLElement>(".intent-selector-item");
      if (intentItem) {
        const intent = intentItem.dataset.intent as "command" | "agent";
        const isAgent = intent === "agent";
        if (this.input.isAgentMode() !== isAgent) {
          this.input.toggleAgentMode();
        }
        this.hidePillMenus();
        return;
      }
    });
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

    const editorHost = this.root.querySelector<HTMLElement>(".editor-host")!;

    // Tab-management shortcuts when the prompt editor is focused. The
    // window-level handler in tabs.ts is the canonical owner of all of
    // these (plus the layout-toggle shortcuts \u2318B/J/L/\u2318\u21e7P), so
    // the layout shortcuts intentionally do NOT live here \u2014 having them
    // in both places caused the toggle to double-fire when the editor
    // happened to be focused. We keep tab-management bindings here so
    // CodeMirror doesn't get a chance to claim \u2318T / \u2318W / \u23181-9 for
    // its own commands before the user's intent is honored.
    editorHost.addEventListener("keydown", (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      const key = e.key.toLowerCase();

      if (key === "t") {
        e.preventDefault();
        e.stopPropagation();
        this.cb.onRequestNewTab();
      } else if (key === "w") {
        e.preventDefault();
        e.stopPropagation();
        this.cb.onRequestClose(this.id);
      } else if (/^[1-9]$/.test(key)) {
        e.preventDefault();
        e.stopPropagation();
        this.cb.onRequestSelectIndex(Number(key) - 1);
      }
    });
  }

  public handleSubmit(text: string, intent: IntentResult): void {
    // Slash commands (order matters).
    if (/^\s*\/models\s*$/i.test(text)) {
      if (this.agentView) {
        this.agentView.appendReport(
          renderModelsMarkdown(this.agent.getModel()),
        );
      } else {
        this.notify(renderModelListAnsi(this.agent.getModel()));
      }
      return;
    }
    if (/^\s*\/(new|clear)\s*$/i.test(text)) {
      this.startNewConversation();
      return;
    }
    if (/^\s*\/history\s*$/i.test(text)) {
      void this.agent.getHistory().then((msgs) => {
        if (this.agentView) {
          this.agentView.appendReport(renderHistoryMarkdown(msgs));
        } else {
          this.notify(renderHistoryAnsi(msgs));
        }
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
      if (this.agentView) {
        this.agentView.appendReport(renderHelpMarkdown());
      } else {
        this.notify(renderHelpAnsi());
      }
      return;
    }
    // /files \u2014 switch sidebar to the Files tab and focus the tree.
    if (/^\s*\/files\s*$/i.test(text)) {
      this.setSidebarTab("files");
      this.notify("[files] sidebar \u2192 Files tab");
      return;
    }
    // /skills \u2014 list everything under `.prism/skills/` as a markdown
    // table. Subcommands:
    //   /skills                 list the corpus
    //   /skills load <slug>     engage a skill for this tab (chip + body in systemPrefix)
    //   /skills unload <slug>   disengage an engaged skill
    //
    // Engagement is intentionally per-tab and ephemeral; closing the
    // tab discards the engaged set. See `docs/skills.md`.
    const skillsMatch = /^\s*\/skills(?:\s+(.+))?\s*$/i.exec(text);
    if (skillsMatch) {
      const args = (skillsMatch[1] ?? "").trim();
      if (args.length === 0) {
        // Bare /skills \u2014 list the corpus.
        void listSkills(this.cwd)
          .then((skills) => {
            if (this.agentView) {
              this.agentView.appendReport(renderSkillsMarkdown(skills));
            } else {
              this.notify(`[skills] ${skills.length} skill(s) in .prism/skills/`);
            }
          })
          .catch((err) => {
            this.notifyError(`[skills] ${String(err)}`);
          });
        return;
      }
      const loadMatch = /^load\s+(\S.*)$/i.exec(args);
      if (loadMatch) {
        void this.engageSkill(loadMatch[1].trim());
        return;
      }
      const unloadMatch = /^unload\s+(\S.*)$/i.exec(args);
      if (unloadMatch) {
        this.disengageSkill(unloadMatch[1].trim());
        return;
      }
      this.notifyError(
        `[skills] unknown subcommand \"${stripAnsi(args)}\". Use /skills, /skills load <slug>, or /skills unload <slug>.`,
      );
      return;
    }
    // /last \u2014 print a compact summary of the persisted workspace
    // state (last audit + last build pointers).
    if (/^\s*\/last\s*$/i.test(text)) {
      if (this.agentView) {
        this.agentView.appendReport(this.renderLastMarkdown());
      } else {
        this.notify(this.renderLastAnsi());
      }
      return;
    }
    // /verify on|off|<model> — control the reviewer pass.
    const verifyMatch = /^\s*\/verify(?:\s+(.*))?$/i.exec(text);
    if (verifyMatch) {
      const arg = (verifyMatch[1] ?? "").trim();
      void this.handleVerifyCommand(arg);
      return;
    }
    // /usage — print AI consumption summary.
    const usageMatch = /^\s*\/usage\s*$/i.exec(text);
    if (usageMatch) {
      void this.handleUsageCommand();
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
        this.notifyError(
          `[agent] unknown model "${stripAnsi(modelArg[1])}". /models for list.`,
        );
        return;
      }
      void this.agent.setModel(resolved);
      this.notify(`[agent] model set to ${stripAnsi(resolved)}`);
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
        this.notifyError(`[build] mode registry misconfigured`);
        return;
      }
      const parsed = parseBuildArgs(rawArgs);
      if (parsed.error) {
        this.notifyError(`[build] ${stripAnsi(parsed.error)}`);
        return;
      }
      const buildPrompt = buildBuildPrompt(parsed.feature);
      this.setTitleFromText(`build: ${parsed.feature}`);
      this.activeBuildFeature = parsed.feature;
      this.notify(
        `[build] starting substrate-gated build of ${stripAnsi(parsed.feature)}`,
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
        this.notifyError(`[fix] mode registry misconfigured`);
        return;
      }
      void this.handleFixCommand(rawArgs, mode);
      return;
    }

    // /protocol <id> — hidden test harness for the Phase B recipe runner.
    // Runs an ordered recipe (slash + shell steps), notifies progress
    // through the agent panel, and persists a consolidated markdown
    // report under ~/Documents/Prism/Reports/. Bare /protocol with no
    // id lists the available recipes. The toolbar UI (Phase D) will
    // surface these without requiring users to know the slash command.
    const protocolMatch = /^\s*\/protocol(?:\s+(\S+))?\s*$/i.exec(text);
    if (protocolMatch) {
      const id = (protocolMatch[1] ?? "").trim();
      void this.handleProtocolCommand(id);
      return;
    }

    // /review [scope] [--max-rounds=N] — Cohesion Review mode. Scope
    // (optional) accepts the same shapes as /audit plus a bare integer
    // 'last N commits' form; default scope is the last 20 commits.
    const reviewMatch = /^\s*\/review(?:\s+(.*))?$/i.exec(text);
    if (reviewMatch) {
      const rawArgs = (reviewMatch[1] ?? "").trim();
      const mode = findMode("/review");
      if (!mode) {
        this.notifyError(`[review] mode registry misconfigured`);
        return;
      }
      const { scope, maxToolRounds, error } = parseReviewArgs(rawArgs);
      if (error) {
        this.notifyError(`[review] ${stripAnsi(error)}`);
        return;
      }
      const reviewPrompt = buildReviewPrompt(scope);
      this.setTitleFromText(`review ${scope || "(last 20 commits)"}`);
      this.notify(
        `[review] cohesion review of ${stripAnsi(scope || "last 20 commits")}`,
      );
      void this.dispatchAgentQuery(reviewPrompt, {
        mode: mode.name,
        modelOverride: mode.preferredModel,
        maxToolRounds,
      });
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
        this.notifyError(`[audit] mode registry misconfigured`);
        return;
      }
      const { scope, maxToolRounds, error } = parseAuditArgs(rawArgs);
      if (error) {
        this.notifyError(`[audit] ${stripAnsi(error)}`);
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
        this.notifyError(`[new] mode registry misconfigured`);
        return;
      }
      const parsed = parseNewArgs(rawArgs);
      if (parsed.error) {
        this.notifyError(`[new] ${stripAnsi(parsed.error)}`);
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
      this.notify(
        `[new] scaffolding ${stripAnsi(parsed.projectName)} into ${stripAnsi(target)}${parsed.description ? ` \u2014 ${stripAnsi(parsed.description)}` : ""}`,
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
        this.notifyError(`[test-gen] mode registry misconfigured`);
        return;
      }
      const parsed = parseTestGenArgs(rawArgs);
      if (parsed.error) {
        this.notifyError(`[test-gen] ${stripAnsi(parsed.error)}`);
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
      this.notify(
        `[test-gen] generating tests for ${stripAnsi(parsed.symbol)}${parsed.file ? ` in ${stripAnsi(parsed.file)}` : ""}${parsed.framework ? ` (${stripAnsi(parsed.framework)})` : ""}`,
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
        this.notifyError(`[refactor] mode registry misconfigured`);
        return;
      }
      const parsed = parseRefactorArgs(rawArgs);
      if (parsed.error) {
        this.notifyError(`[refactor] ${stripAnsi(parsed.error)}`);
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
      this.notify(
        `[refactor] renaming ${stripAnsi(parsed.oldName)} \u2192 ${stripAnsi(parsed.newName)}${parsed.scope ? ` in ${stripAnsi(parsed.scope)}` : ""}`,
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

  async handleVerifyCommand(arg: string): Promise<void> {
    const v = this.agent.getVerifier();
    if (arg === "" || arg === "status") {
      this.notify(
        `[verify] ${v.enabled ? "on" : "off"}, model = ${stripAnsi(v.model)}`,
      );
      return;
    }
    if (/^off|disable|disabled|no|0$/i.test(arg)) {
      await this.agent.setVerifierEnabled(false);
      this.notify(`[verify] off`);
      return;
    }
    if (/^on|enable|enabled|yes|1$/i.test(arg)) {
      await this.agent.setVerifierEnabled(true);
      this.notify(`[verify] on`);
      return;
    }
    // Anything else — treat as model alias or slug.
    const resolved = resolveModel(arg);
    if (!resolved) {
      this.notifyError(
        `[verify] unknown arg "${stripAnsi(arg)}". Try on / off / <model alias>.`,
      );
      return;
    }
    await this.agent.setVerifierModel(resolved);
    this.notify(`[verify] reviewer model = ${stripAnsi(resolved)}`);
  }

  private async handleUsageCommand(): Promise<void> {
    try {
      const summary = await invoke<{
        session_tokens: number;
        session_cost_usd: number;
        today_tokens: number;
        today_cost_usd: number;
        by_model: { model: string; tokens: number; cost_usd: number }[];
      }>("get_usage_summary", { chat_id: this.id });

      const RESET = "\x1b[0m";
      const BOLD = "\x1b[1m";
      const DIM = "\x1b[2m";
      const GREEN = "\x1b[32m";
      const CYAN = "\x1b[36m";

      const formatCost = (c: number) => `$${c.toFixed(3)}`;
      const formatTokens = (t: number) =>
        t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t.toString();

      const out: string[] = [];
      out.push(`${BOLD}AI Usage Summary${RESET}`);
      out.push(`${DIM}Session: ${RESET}${BOLD}${formatTokens(summary.session_tokens)}${RESET} tokens, ${GREEN}${formatCost(summary.session_cost_usd)}${RESET}`);
      out.push(`${DIM}Today:   ${RESET}${BOLD}${formatTokens(summary.today_tokens)}${RESET} tokens, ${GREEN}${formatCost(summary.today_cost_usd)}${RESET}`);
      
      if (summary.by_model.length > 0) {
        out.push("");
        out.push(`${BOLD}By Model${RESET} ${DIM}(all time)${RESET}`);
        for (const m of summary.by_model) {
          const modelName = m.model.split("/").pop() || m.model;
          out.push(`  ${CYAN}${modelName.padEnd(24)}${RESET} ${BOLD}${formatTokens(m.tokens).padStart(6)}${RESET} tokens  ${GREEN}${formatCost(m.cost_usd)}${RESET}`);
        }
      }

      this.notify(out.join("\r\n") + "\r\n");
    } catch (e) {
      this.notifyError(`[usage] failed to load summary: ${stripAnsi(String(e))}`);
    }
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
      this.notifyError(`[fix] ${stripAnsi(parsed.error)}`);
      return;
    }
    if (!this.cwd) {
      this.notifyError(`[fix] cwd unknown; cannot locate audit reports`);
      return;
    }

    let lookup: { path: string; content: string; bytes: number };
    try {
      lookup = await invoke<{ path: string; content: string; bytes: number }>(
        "read_latest_audit_report",
        { cwd: this.cwd, path: parsed.reportPath ?? null },
      );
    } catch (e) {
      this.notifyError(`[fix] ${stripAnsi(String(e))}`);
      return;
    }

    let report: AuditReport;
    try {
      report = JSON.parse(lookup.content) as AuditReport;
    } catch (e) {
      this.notifyError(
        `[fix] failed to parse ${stripAnsi(prettyPath(lookup.path))}: ${stripAnsi(String(e))}`,
      );
      return;
    }

    const filterResult = filterFindings(
      report.findings,
      parsed.selector,
      parsed.include,
    );
    if (filterResult.error) {
      this.notifyError(
        `[fix] ${stripAnsi(filterResult.error)} (report: ${stripAnsi(prettyPath(lookup.path))})`,
      );
      return;
    }
    const selected = filterResult.findings;
    if (selected.length === 0) {
      this.notify(
        `[fix] nothing to fix \u2014 ${stripAnsi(prettyPath(lookup.path))} has 0 findings`,
      );
      return;
    }

    const fixPrompt = buildFixPrompt(report, selected, lookup.path);
    this.setTitleFromText(
      `fix ${selected.length}/${report.findings.length} from latest audit`,
    );
    this.notify(
      `[fix] applying ${selected.length} of ${report.findings.length} findings from ${stripAnsi(prettyPath(lookup.path))}`,
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
    // Contextual nudge: if a plain chat prompt looks like a topic pivot in a
    // long thread, suggest starting a fresh chat.
    if (!options.mode) {
      this.maybeNudgeLongThread();
      this.maybeNudgeTopicShift(prompt);
    }
    // Grounded-Chat protocol. In Always Verify mode, every agent turn
    // gets a rigor scaffold and verifier override. In Auto Verify mode,
    // plain chat only gets the scaffold when the prompt looks like an
    // inspectable factual question; mode-driven turns rely on their
    // own stricter personas.
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
    const strictMode = settings.getStrictMode();
    const trigger = detectVerifiedTrigger(prompt);
    if (strictMode) {
      const strictTrigger =
        trigger ?? ({ kind: "repo-fact", matched: "always verify" } as const);
      systemPrefix = buildVerifiedSystemPrefix(strictTrigger);
      this.notify(
        `\u2192 [always verify] ${verifiedKindLabel(strictTrigger.kind)} protocol active (matched \u201c${stripAnsi(strictTrigger.matched)}\u201d)`,
      );
    } else if (!options.mode && trigger) {
      systemPrefix = buildVerifiedSystemPrefix(trigger);
      this.notify(
        `\u2192 [grounded-chat] ${verifiedKindLabel(trigger.kind)} protocol active (matched \u201c${stripAnsi(trigger.matched)}\u201d)`,
      );
    }
    // Engaged skills apply to EVERY turn (including mode-driven ones
    // like /audit and /build) per `docs/skills.md`. Prepend before the
    // grounded-chat block so the skills frame the protocol rather than
    // the other way around.
    const skillsBlock = this.composeEngagedSkillsBlock();
    if (skillsBlock.length > 0) {
      systemPrefix = systemPrefix
        ? `${skillsBlock}\n\n${systemPrefix}`
        : skillsBlock;
    }
    // Track B awareness manifest. Append AFTER any other prefix so the
    // available-skills line is the last thing the model sees before the
    // user query \u2014 closer to the conversational floor improves the odds
    // it gets considered. Excludes already-engaged skills (their bodies
    // are above; no need to re-advertise).
    if (this.skillsAware) {
      const manifest = await this.composeSkillsAwarenessManifest();
      if (manifest.length > 0) {
        systemPrefix = systemPrefix
          ? `${systemPrefix}\n\n${manifest}`
          : manifest;
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
      this.notify(
        `[images] model ${stripAnsi(this.agent.getModel())} doesn't support images \u2014 sending text only`,
      );
    }

    // Announce attachments in the agent panel so the user sees what's going out.
    const parts: string[] = [];
    if (resolved.length > 0) {
      const names = resolved
        .map((r) => `${stripAnsi(r.original)}${r.truncated ? " (truncated)" : ""}`)
        .join(", ");
      parts.push(`[attached] ${names}`);
    }
    if (images.length > 0 && modelSupportsVision(this.agent.getModel())) {
      parts.push(`[images] ${images.length} attached`);
    }
    for (const e of errors) {
      parts.push(`[@${stripAnsi(e.original)}] ${stripAnsi(e.error)}`);
    }
    if (parts.length > 0) {
      this.notify(parts.join("\n"));
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
      {
        ...options,
        systemPrefix,
        verifierEnabledOverride: strictMode ? true : undefined,
      },
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
      // If the keystroke originated from an editable control within this
      // workspace (prompt editor, file editor, input/textarea/contenteditable),
      // never hijack it for slash-command focus.
      if (this.isEditorFocused(e.target)) return;

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

  /**
   * True if the active element is inside any editable surface in this
   * workspace — the prompt CodeMirror (.editor-host) OR the file-editor
   * CodeMirror (.file-preview-body). This prevents the slash-focus hijack
   * from stealing `/` while the user is typing inside an open file.
   */
  private isEditorFocused(target?: EventTarget | null): boolean {
    const active = document.activeElement;
    const eventTarget =
      target instanceof Node && this.root.contains(target) ? target : null;
    const candidate = (eventTarget ?? active) as Element | null;
    if (!candidate) return false;

    // 1. Check if focus is in any CodeMirror editor instance (prompt or file editor)
    // within this workspace. CM6 wrapper uses .cm-editor.
    if (candidate.closest(".cm-editor") && this.root.contains(candidate)) return true;

    // 1b. Native editable controls inside the workspace should also opt out.
    if (
      candidate instanceof HTMLElement &&
      this.root.contains(candidate) &&
      (candidate.isContentEditable ||
        candidate.closest("input, textarea, [contenteditable='true']"))
    ) {
      return true;
    }

    // 2. Check if focus is in the terminal (xterm.js uses a hidden textarea).
    const termHost = this.root.querySelector(".terminal-host");
    if (termHost && termHost.contains(candidate)) return true;

    return false;
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
          this.notify(`[problems] copied ${stripAnsi(loc)} to clipboard`);
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
      this.notifyError(`[problems] ${stripAnsi(parsed.error)}`);
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
        this.notify(`[problems] cleared cached report`);
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

    // ANSI summary in the agent panel — even if we fail to write the
    // file, the user gets the parsed view inline. The renderer emits
    // ANSI for legacy reasons; appendNotice strips the escapes and the
    // structure (headings, bullets, indentation) survives via
    // .agent-notice's pre-wrap whitespace rule.
    this.notify(renderAnsiFindings(report));

    if (!this.cwd) {
      this.notify(
        `[audit] cwd unknown; skipping report write (markdown report only persists when a shell is started with OSC 7)`,
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
      const lines = [
        `[audit] report saved \u2192 ${stripAnsi(pretty)} (${formatBytesShort(result.bytes_written)})`,
      ];
      if (result.json_path) {
        const prettyJson = prettyPath(result.json_path);
        lines.push(
          `[audit] sidecar     \u2192 ${stripAnsi(prettyJson)} (${formatBytesShort(result.json_bytes_written ?? 0)})`,
        );
        // Update the workspace-state pointer so a future tab open
        // hydrates this audit without re-running it. Best-effort: a
        // failure here is logged but doesn't fail the audit turn.
        void this.updateLastAuditPointer(report, result.json_path);
      }
      this.notify(lines.join("\n"));
    } catch (e) {
      this.notifyError(`[audit] report write failed: ${stripAnsi(String(e))}`);
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
    // the persistence step fails. appendNotice strips ANSI; structure
    // (headings, bullets, indentation) survives.
    this.notify(renderAnsiBuildReport(report));

    if (!this.cwd) {
      this.notify(`[${stripAnsi(info.mode)}] cwd unknown; skipping report write`);
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
      const lines = [
        `[${stripAnsi(info.mode)}] report saved \u2192 ${stripAnsi(pretty)} (${formatBytesShort(result.bytes_written)})`,
      ];
      if (result.json_path) {
        const prettyJson = prettyPath(result.json_path);
        lines.push(
          `[${stripAnsi(info.mode)}] sidecar     \u2192 ${stripAnsi(prettyJson)} (${formatBytesShort(result.json_bytes_written ?? 0)})`,
        );
        void this.updateLastBuildPointer(report, result.json_path);
      }
      this.notify(lines.join("\n"));
    } catch (e) {
      this.notifyError(
        `[${stripAnsi(info.mode)}] report write failed: ${stripAnsi(String(e))}`,
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
      this.notify(`[workspace] could not load state: ${stripAnsi(String(e))}`);
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
        preview_visible: this.visibilityRestored
          ? this.previewVisible
          : state.layout.preview_visible ?? this.previewVisible,
        terminal_visible: this.visibilityRestored
          ? this.terminalVisible
          : state.layout.terminal_visible ?? this.terminalVisible,
        agent_visible: this.visibilityRestored
          ? this.agentVisible
          : state.layout.agent_visible ?? this.agentVisible,
      });
      this.applyLayoutToDOM();
      // Sync the runtime visibility fields from the hydrated layout
      // and apply the corresponding `*-hidden` classes so a tab
      // restored with a hidden agent pane / terminal / preview shows
      // up that way on launch instead of snapping back to all-visible.
      this.previewVisible = this.layout.preview_visible;
      this.terminalVisible = this.layout.terminal_visible;
      this.agentVisible = this.layout.agent_visible;
      this.root.classList.toggle("preview-hidden", !this.previewVisible);
      this.root.classList.toggle("terminal-hidden", !this.terminalVisible);
      this.root.classList.toggle("agent-hidden", !this.agentVisible);
      this.syncPreviewDividerAccessibility();
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
  private renderLastMarkdown(): string {
    const out: string[] = [];
    if (!this.lastAuditReport && !this.lastBuildReport) {
      return "_No persisted state yet — run `/audit` or `/build` to populate `.prism/state.json`._";
    }

    out.push("### Last Activity\n\n");
    out.push("| Command | When | Status / Summary | Scope |\n");
    out.push("| :--- | :--- | :--- | :--- |\n");

    if (this.lastAuditReport) {
      const a = this.lastAuditReport;
      const rel = formatRelativeTime(a.generated_at);
      const summary = `❌ ${a.summary.errors} ⚠️ ${a.summary.warnings} ℹ️ ${a.summary.info}`;
      out.push(
        `| **audit** | ${rel} | ${summary} | ${a.scope ? `\`${a.scope}\`` : "-"} |`,
      );
    } else {
      out.push("| audit | - | _none_ | - |");
    }

    if (this.lastBuildReport) {
      const b = this.lastBuildReport;
      const rel = formatRelativeTime(b.generated_at);
      const statusIcon = b.status === "completed" ? "✅" : "⚠️";
      out.push(
        `| **build** | ${rel} | ${statusIcon} ${b.status} | \`${b.feature}\` |`,
      );
    } else {
      out.push("| build | - | _none_ | - |");
    }

    return out.join("\n");
  }

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
      this.notify(
        `[images] ${stripAnsi(file.name || "pasted")} is ${Math.round(file.size / 1024)} KB \u2014 over the 5 MB cap`,
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

  /**
   * Append a status / notice line to the agent panel. Drop-in replacement
   * for the legacy `this.term.write("...")` pattern that wrote agent-
   * flavored content into xterm. AgentView.appendNotice strips ANSI so
   * existing color escapes in the message are harmless; structure (newlines,
   * indentation) survives via the `white-space: pre-wrap` rule on
   * `.agent-notice` in styles.css.
   *
   * xterm is reserved for shell I/O after the panel-split rebuild
   * (commit db5c9d8). The only legitimate `term.write` callers left in
   * this file are the PTY-output passthrough and the two shell-lifecycle
   * lines (start failure + `[shell exited]`).
   */
  private notify(message: string): void {
    this.agentView?.appendNotice("router", message);
  }

  /** Append an error line (red, with left bar) to the agent panel. */
  private notifyError(message: string): void {
    this.agentView?.appendError(message);
  }

  /**
   * Driver for the hidden `/protocol <id>` slash command. Lists
   * available recipes when called bare; otherwise dispatches the
   * named recipe through the runner. Phase B test harness for the
   * orchestrator before the toolbar UI lands.
   */
  private async handleProtocolCommand(id: string): Promise<void> {
    if (id.length === 0) {
      // Render the listing as Markdown via appendReport so headings,
      // recipe ids (inline code), labels (bold), and category labels
      // (italic) get proper visual weight via the existing
      // `.markdown-body` styles. The plain-text appendNotice path is
      // too dim for a structured listing \u2014 see the notify-overcorrection
      // follow-up doc for the broader migration this seeds.
      const md: string[] = ["## Available recipes", ""];
      for (const r of RECIPES) {
        md.push(
          `- **\`${r.id}\`** \u2014 ${r.label} \u00b7 *${r.category}*  `,
        );
        md.push(`  ${r.blurb}`);
      }
      md.push("");
      md.push("Usage: `/protocol <id>`");
      this.agentView?.appendReport(md.join("\n"));
      return;
    }

    // Card path: mount a ProtocolReportCard inline in the agent panel
    // and let the runner drive its lifecycle via onProgress. The card
    // replaces the per-step notify() chatter from Phase B with one
    // self-mutating element (planning \u2192 running \u2192 done) modeled on
    // the Approval card pattern.
    const recipe = findRecipe(id);
    if (!recipe) {
      this.notifyError(
        `[protocol] unknown recipe "${stripAnsi(id)}". Try /protocol bare to list.`,
      );
      return;
    }
    const controller = new AbortController();
    const card = new ProtocolReportCard(recipe, {
      onCancel: () => {
        controller.abort();
        this.notify(`[protocol] "${recipe.label}" cancelled by user`);
      },
      onRerun: () => {
        // Fire-and-forget re-run; the new card mounts in a fresh slot
        // below the current one. Existing card stays visible so the
        // user can compare runs.
        void this.handleProtocolCommand(id);
      },
      onOpenReport: (path) => {
        // Open the report in the user's default Markdown handler via
        // tauri-plugin-opener (already registered in capabilities/
        // default.json). Falls back to copying the path to clipboard
        // when the open call fails (e.g. no default handler) so the
        // user can paste it into a terminal or Finder manually.
        void openPath(path)
          .then(() => {
            this.notify(`[protocol] opened report \u2192 ${path}`);
          })
          .catch((err) => {
            void navigator.clipboard.writeText(path).catch(() => {});
            this.notifyError(
              `[protocol] could not open report (${String(err)}); path copied to clipboard: ${path}`,
            );
          });
      },
    });
    this.agentView?.appendCard(card.el);
    try {
      await runRecipe(
        id,
        {
          getCwd: () => this.cwd,
          notify: (m) => this.notify(m),
          notifyError: (m) => this.notifyError(m),
          runSlashCommand: (cmd) => this.runAgentSlashCommand(cmd),
        },
        {
          signal: controller.signal,
          onProgress: (ev) => {
            switch (ev.kind) {
              case "planning":
                // Card already in planning state from constructor;
                // event is informational here but useful for future
                // listeners (e.g. analytics).
                break;
              case "step:active":
                card.setStepActive(ev.index);
                break;
              case "step:result": {
                const detail =
                  ev.result.state === "failed"
                    ? composeStepFailureDetail(ev.result)
                    : ev.result.state === "skipped"
                      ? ev.result.error
                      : undefined;
                card.setStepResult(
                  ev.index,
                  ev.result.state === "ok"
                    ? "ok"
                    : ev.result.state === "failed"
                      ? "failed"
                      : "skipped",
                  ev.result.durationMs,
                  detail,
                );
                break;
              }
              case "done": {
                if (ev.aborted) card.cascadeSkipRemaining("cancelled");
                const counts = summaryFromSteps(ev.report.steps);
                card.setDone({
                  ...counts,
                  durationMs: ev.report.durationMs,
                  reportPath: ev.report.reportPath,
                  aborted: ev.aborted,
                });
                break;
              }
            }
          },
        },
      );
    } catch (err) {
      this.notifyError(`[protocol] ${String(err)}`);
    }
  }

  /**
   * Dispatch a slash command on behalf of the recipe runner and resolve
   * when the resulting agent turn completes. The runner's `slash` step
   * kind only lists agent-dispatching commands (/audit, /review, etc.);
   * if a non-dispatching command is passed (e.g. /help) the agent
   * never goes busy and this promise hangs by design \u2014 v1 leans on
   * recipe-author discipline rather than runtime detection.
   *
   * Subscribes to the agent's `awaitTurnComplete` BEFORE dispatching so
   * the busy=true \u2192 busy=false cycle can't race past the listener.
   */
  private async runAgentSlashCommand(
    text: string,
  ): Promise<{ assistantText: string; cancelled: boolean }> {
    if (this.agent.isBusy()) {
      throw new Error(
        "agent is busy with another turn; cannot dispatch slash command",
      );
    }
    const wait = this.agent.awaitTurnComplete();
    // Replicate `handleSubmit` for command-intent dispatch. Wrapping it
    // here means the runner doesn't need a separate dispatch path; any
    // future slash command added to handleSubmit is automatically
    // recipe-runnable.
    this.handleSubmit(text, { intent: "command", explicit: true, payload: text });
    const outcome = await wait;
    return {
      assistantText: outcome.assistantText,
      cancelled: outcome.cancelled,
    };
  }

  private setTitleFromText(text: string): void {
    if (this.autoTitleDone) return;
    const truncated = truncateLikeTabTitle(text);
    if (truncated.length === 0) return;
    this.title = truncated;
    this.autoTitleDone = true;
    this.cb.onTitleChange(this.id, this.title);
  }

  /** Shared reset path used by /new and the New button. */
  private startNewConversation(): void {
    void this.agent.newSession().then(() => {
      this.title = "New Tab";
      this.autoTitleDone = false;
      this.lastChatTopicKeywords = [];
      this.topicShiftNudged = false;
      this.longThreadNudged = false;
      this.cb.onTitleChange(this.id, this.title);
      this.notify("[agent] new session \u2014 history cleared and title reset");
    });
  }

  // -- Track B: skills awareness toggle + manifest -------------------------

  /**
   * Flip the per-tab awareness flag and update the pill UI. When ON,
   * `dispatchAgentQuery` adds an "available skills" manifest to the
   * system prompt and the LLM can call `read_skill(slug)` to request a
   * skill body. Each call surfaces an approval card; on approval the
   * skill engages (sticky) just like Track A's `/skills load`.
   */
  private toggleSkillsAwareness(): void {
    this.skillsAware = !this.skillsAware;
    this.updateSkillsToggleUI();
    this.notify(
      this.skillsAware
        ? "[skills] awareness on \u2014 the agent will see available skills and may request to load one (each request is approved)"
        : "[skills] awareness off",
    );
  }

  /** Sync the skills-toggle pill's data attributes + label with the live state. */
  private updateSkillsToggleUI(): void {
    const btn = this.root.querySelector<HTMLButtonElement>(".skills-toggle");
    if (!btn) return;
    btn.dataset.aware = this.skillsAware ? "true" : "false";
    btn.setAttribute("aria-pressed", this.skillsAware ? "true" : "false");
    btn.textContent = this.skillsAware ? "skills on" : "skills off";
  }

  /** Toggle persistent Always Verify mode, which forces grounded chat + verifier. */
  private toggleStrictMode(): void {
    const next = !settings.getStrictMode();
    settings.setStrictMode(next);
    this.updateStrictToggleUI();
    this.notify(
      next
        ? "[verify] always — grounded instructions and verifier pass forced for every agent turn"
        : "[verify] auto — factual prompts still auto-ground; other turns skip forced verification for lower latency",
    );
  }

  /** Sync the Always Verify / Auto Verify toolbar button from persisted settings. */
  private updateStrictToggleUI(): void {
    const btn = this.root.querySelector<HTMLButtonElement>(".strict-toggle");
    if (!btn) return;
    const strict = settings.getStrictMode();
    btn.dataset.strict = strict ? "true" : "false";
    btn.setAttribute("aria-pressed", strict ? "true" : "false");
    const label = btn.querySelector<HTMLElement>(".strict-toggle-label");
    if (label) label.textContent = strict ? "Always Verify" : "Auto Verify";
    btn.title = strict
      ? "Always Verify is on: every agent turn gets grounded instructions and a verifier pass. Best for maximum checking; may add latency/cost and can make answers more conservative."
      : "Auto Verify is on: Prism still auto-grounds inspectable factual prompts like counts, repo facts, and feature summaries, but does not force verification on every turn.";
  }

  /**
   * Build the awareness-manifest section of the system prefix.
   * Returns "" when there's nothing to advertise (no cwd, empty
   * corpus, or every skill is already engaged via Track A).
   *
   * Format mirrors the agent's own protocol style so the LLM treats
   * it as instruction rather than user content. Each skill is one
   * line: `- \`slug\` \u2014 description`.
   */
  private async composeSkillsAwarenessManifest(): Promise<string> {
    if (!this.cwd) return "";
    let skills: SkillSummary[];
    try {
      skills = await listSkills(this.cwd);
    } catch {
      // Best-effort: a transient list_skills failure shouldn't block
      // the agent turn. The user just won't get LLM-aware suggestions
      // this round.
      return "";
    }
    const engagedSlugs = new Set(this.engagedSkills.keys());
    const candidates = skills.filter((s) => !engagedSlugs.has(s.slug));
    if (candidates.length === 0) return "";
    const out: string[] = [];
    out.push("## Available skills");
    out.push(
      "The user has skills awareness enabled. If any of the following user-curated skills would clearly help with the current task, call the `read_skill` tool with the matching slug. Each call surfaces an approval card to the user; on approval, the skill engages for the rest of the tab session and its body rides every subsequent turn. Do not call speculatively \u2014 a wrong call costs the user a click.",
    );
    for (const s of candidates) {
      out.push(`- \`${s.slug}\` \u2014 ${s.description}`);
    }
    return out.join("\n");
  }

  /**
   * Tool-execution observer hook. Wired into AgentController via
   * `onToolExecuted`; fires once per completed tool call. We care
   * specifically about `read_skill` here \u2014 a successful one means
   * the user just approved engaging a skill, so we stickify it by
   * routing through the same `engageSkill` path Track A uses.
   *
   * Failures (user rejected, args invalid, file too large) are
   * silently ignored \u2014 the LLM already saw the error in the tool
   * result and can adjust; we don't need to surface anything more.
   */
  private async handleToolExecuted(info: {
    name: string;
    args: string;
    ok: boolean;
  }): Promise<void> {
    if (info.name !== "read_skill" || !info.ok) return;
    let slug: string | null = null;
    try {
      const parsed = JSON.parse(info.args) as { slug?: unknown };
      if (typeof parsed.slug === "string" && parsed.slug.length > 0) {
        slug = parsed.slug;
      }
    } catch {
      return; // Malformed args; nothing to engage.
    }
    if (!slug) return;
    if (this.engagedSkills.has(slug)) return; // Already engaged; nothing to do.
    // Engage via the standard path so the size-discipline gate runs
    // and the chip renders. Note: the LLM ALREADY got the body for
    // this turn via the tool result, so even if `decideEngagement`
    // blocks (over budget), the current turn isn't degraded \u2014 the
    // engagement is just refused for future turns.
    await this.engageSkill(slug);
  }

  // -- Track A: intentional skill engagement -------------------------------

  /**
   * Sum of `sizeBytes` across the currently engaged skills. Used as
   * the `alreadyEngagedBytes` argument to `decideEngagement` so the
   * per-session budget check (128 KB by default) sees the live total.
   */
  private getEngagedSkillsTotalBytes(): number {
    let total = 0;
    for (const s of this.engagedSkills.values()) total += s.sizeBytes;
    return total;
  }

  /**
   * Engage a skill: read its body, run it through the size-discipline
   * gate (`decideEngagement` in `src/skill-limits.ts`), and add it to
   * `this.engagedSkills` on success. Re-renders the input-bar chip(s)
   * and notifies the user. Idempotent on already-engaged slugs.
   *
   * Does NOT persist anything \u2014 engagement is per-tab + ephemeral by
   * design. See `docs/skills.md` for the curation-vs-engagement split.
   */
  private async engageSkill(slug: string): Promise<void> {
    if (slug.length === 0) {
      this.notifyError("[skills] usage: /skills load <slug>");
      return;
    }
    if (!this.cwd) {
      this.notifyError("[skills] cwd unknown \u2014 wait for the shell prompt");
      return;
    }
    if (this.engagedSkills.has(slug)) {
      this.notify(`[skills] ${stripAnsi(slug)} already engaged`);
      return;
    }
    let skill: SkillBody;
    try {
      skill = await readSkill(this.cwd, slug);
    } catch (err) {
      this.notifyError(`[skills] ${stripAnsi(String(err))}`);
      return;
    }
    const decision = decideEngagement({
      candidatePath: `${slug}.md`,
      candidateBytes: skill.sizeBytes,
      alreadyEngagedBytes: this.getEngagedSkillsTotalBytes(),
    });
    if (decision.kind === "block") {
      this.notifyError(`[skills] ${stripAnsi(decision.reason)}`);
      return;
    }
    if (decision.kind === "warn") {
      this.notify(`[skills] warning: ${stripAnsi(decision.reason)}`);
    }
    this.engagedSkills.set(slug, skill);
    this.renderSkillChips();
    this.notify(
      `[skills] engaged ${stripAnsi(skill.name)} (${formatKB(skill.sizeBytes)})`,
    );
  }

  /**
   * Disengage an engaged skill. No-op (with a friendly notice) if the
   * slug isn't engaged. Re-renders chips and notifies on success.
   */
  private disengageSkill(slug: string): void {
    if (slug.length === 0) {
      this.notifyError("[skills] usage: /skills unload <slug>");
      return;
    }
    const skill = this.engagedSkills.get(slug);
    if (!skill) {
      this.notify(`[skills] ${stripAnsi(slug)} is not engaged`);
      return;
    }
    this.engagedSkills.delete(slug);
    this.renderSkillChips();
    this.notify(`[skills] disengaged ${stripAnsi(skill.name)}`);
  }

  /**
   * Build the system-prefix block injected on every agent turn while
   * skills are engaged. Returns the empty string when no skills are
   * engaged so the caller can short-circuit without conditionally
   * concatenating an empty section.
   *
   * Section order is the engagement order (Map preserves insertion);
   * earlier engagements appear first in the prefix so they read like
   * a stable persona rather than a stack.
   */
  private composeEngagedSkillsBlock(): string {
    if (this.engagedSkills.size === 0) return "";
    const out: string[] = [];
    out.push("## Engaged skills");
    out.push(
      "The user has explicitly engaged the following skill(s) for this turn. Treat each as durable guidance the user wants you to apply.",
    );
    for (const skill of this.engagedSkills.values()) {
      out.push(`### ${skill.name}`);
      out.push(skill.body.trim());
    }
    return out.join("\n\n");
  }

  /**
   * (Re)render the chips row below the input-meta. Called after every
   * engage/disengage; idempotent with respect to the live engaged set.
   *
   * Layout: chips collect left-to-right and wrap onto additional rows
   * as the engaged set grows; a compact size indicator (`<used> /
   * <budget>`) sits at the end so the user always sees how much of
   * the 128 KB session budget is in play. The whole row hides itself
   * when no skills are engaged so the input bar stays compact in the
   * common case.
   *
   * The size indicator gets a `[data-state]` attribute so CSS can flip
   * its color when the user is approaching the budget cap (warn at
   * \u226575%, near at \u226590%) without us doing manual style writes here.
   */
  private renderSkillChips(): void {
    const row = this.root.querySelector<HTMLElement>(".skill-chips-row");
    if (!row) return;
    row.replaceChildren();
    if (this.engagedSkills.size === 0) {
      row.hidden = true;
      return;
    }
    row.hidden = false;

    let totalBytes = 0;
    for (const skill of this.engagedSkills.values()) {
      totalBytes += skill.sizeBytes;
      const chip = document.createElement("span");
      chip.className = "skill-chip";
      chip.title = `${skill.name} \u2014 ${formatKB(skill.sizeBytes)}\nClick \u00d7 to disengage`;

      const glyph = document.createElement("span");
      glyph.className = "skill-chip-glyph";
      glyph.textContent = "\u25b8";
      chip.appendChild(glyph);

      const labelEl = document.createElement("span");
      labelEl.className = "skill-chip-label";
      labelEl.textContent = skill.slug;
      chip.appendChild(labelEl);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "skill-chip-close";
      closeBtn.setAttribute("aria-label", `Disengage ${skill.name}`);
      closeBtn.textContent = "\u00d7";
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.disengageSkill(skill.slug);
      });
      chip.appendChild(closeBtn);

      row.appendChild(chip);
    }

    // Compact size indicator. Integer KB rounding so the badge stays
    // tight at narrow widths and lines up nicely with the chip baseline.
    // State attribute drives color: `ok` (<75%), `warn` (75\u201389%),
    // `near` (\u226590%). The hard cap itself is enforced by
    // `decideEngagement`; this is just visual headroom feedback.
    const usedKb = Math.round(totalBytes / 1024);
    const budgetKb = Math.round(SESSION_SKILL_BUDGET_BYTES / 1024);
    const ratio = totalBytes / SESSION_SKILL_BUDGET_BYTES;
    const state = ratio >= 0.9 ? "near" : ratio >= 0.75 ? "warn" : "ok";
    const size = document.createElement("span");
    size.className = "skill-chips-size";
    size.dataset.state = state;
    size.title = `${formatKB(totalBytes)} of ${formatKB(SESSION_SKILL_BUDGET_BYTES)} session budget used`;
    size.textContent = `${usedKb}K / ${budgetKb}K`;
    row.appendChild(size);
  }

  /** Emit a one-time nudge once the chat grows beyond ~40 turns. */
  private maybeNudgeLongThread(): void {
    if (this.longThreadNudged) return;
    // `getMessageCount()` includes both user + assistant messages.
    // 80 messages ~= 40 turns.
    if (this.agent.getMessageCount() < 80) return;
    this.longThreadNudged = true;
    this.agentView?.appendNotice(
      "router",
      "This conversation is getting long. Consider starting a new chat (New button or `/clear`) to keep context sharp.",
    );
  }

  /**
   * If this looks like a new topic in a long chat thread, emit a one-time
   * nudge to start a fresh conversation for better focus.
   */
  private maybeNudgeTopicShift(prompt: string): void {
    if (this.topicShiftNudged) return;
    const messageCount = this.agent.getMessageCount();
    // Wait until the thread has enough context to make "topic drift" meaningful.
    if (messageCount < 24) return; // ~12 turns
    const nextKeywords = topicKeywords(prompt);
    if (nextKeywords.length < 3) return;
    if (this.lastChatTopicKeywords.length === 0) {
      this.lastChatTopicKeywords = nextKeywords;
      return;
    }
    const overlap = keywordOverlapRatio(this.lastChatTopicKeywords, nextKeywords);
    this.lastChatTopicKeywords = nextKeywords;
    // Suppress only when the topics meaningfully overlap. The denominator
    // uses min(|a|,|b|) so a low threshold over-suppresses when one side
    // is short (e.g. 1/3 keywords → 0.33). Require a majority overlap.
    if (overlap >= 0.5) return;
    this.topicShiftNudged = true;
    this.agentView?.appendNotice(
      "router",
      "This looks like a new topic. Consider starting a new chat (New button or `/clear`) to keep context focused.",
    );
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
      // Toolbar actions live on `.sidebar-tab-action[data-action]`;
      // gear-menu actions live on `.file-menu-item[data-action]`.
      // Both share the data-action contract so we collapse handling.
      const action = target?.closest<HTMLElement>(
        ".sidebar-tab-action[data-action], .file-menu-item[data-action]",
      );
      if (action) {
        const a = action.dataset.action;
        if (a === "toggle-file-view-options") {
          e.stopPropagation();
          this.toggleFileViewOptionsMenu();
        } else if (a === "toggle-hidden") {
          this.toggleShowHiddenFiles();
        } else if (a === "refresh-files") {
          this.refreshFileTreeFull();
        } else if (a === "new-file") {
          this.hideFileViewOptionsMenu();
          void this.createNewFile(null);
        } else if (a === "new-folder") {
          this.hideFileViewOptionsMenu();
          void this.createNewFolder(null);
        }
        return;
      }
      const btn = target?.closest<HTMLButtonElement>(".sidebar-tab");
      if (!btn) return;
      const tab = btn.dataset.tab as "blocks" | "files" | undefined;
      if (!tab) return;
      this.setSidebarTab(tab);
    });
    tabsEl.addEventListener("change", (e) => {
      const target = e.target as HTMLElement | null;
      const opt = target?.closest<HTMLInputElement>("input[data-view-option]");
      if (!opt) return;
      if (opt.dataset.viewOption === "size") {
        this.setShowFileSizes(opt.checked);
      } else if (opt.dataset.viewOption === "modified") {
        this.setShowFileModified(opt.checked);
      }
    });
    const onDocPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const insideMenu = !!target.closest(".file-view-options-menu");
      const onButton = !!target.closest(
        '.sidebar-tab-action[data-action="toggle-file-view-options"]',
      );
      const onPill = !!target.closest(".model-badge, .intent-badge");
      const insidePillMenu = !!target.closest(".model-selector-menu, .intent-selector-menu");
      
      if (!insideMenu && !onButton) this.hideFileViewOptionsMenu();
      if (!onPill && !insidePillMenu) this.hidePillMenus();
    };
    this.root.ownerDocument.addEventListener("mousedown", onDocPointerDown);
    this.disposers.push(() =>
      this.root.ownerDocument.removeEventListener("mousedown", onDocPointerDown),
    );
    // Escape closes the menu and returns focus to its trigger so
    // keyboard-only users don't lose context (standard ARIA disclosure
    // pattern). We only refocus on Escape — click-outside via mouse
    // intentionally lets the user's next click receive focus.
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const btn = this.root.querySelector<HTMLButtonElement>(
        '.sidebar-tab-action[data-action="toggle-file-view-options"]',
      );
      if (!btn || btn.getAttribute("aria-expanded") !== "true") return;
      this.hideFileViewOptionsMenu();
      btn.focus();
    };
    this.root.ownerDocument.addEventListener("keydown", onDocKeyDown);
    this.disposers.push(() =>
      this.root.ownerDocument.removeEventListener("keydown", onDocKeyDown),
    );
    this.syncFileViewOptionsMenuState();
    this.updateHiddenToggleVisualState();
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
    this.updateHiddenToggleVisualState();
    void this.refreshFileTreeFull();
  }

  private setShowFileSizes(next: boolean): void {
    this.showFileSizes = next;
    this.syncFileViewOptionsMenuState();
    this.renderFileTree();
  }

  private setShowFileModified(next: boolean): void {
    this.showFileModified = next;
    this.syncFileViewOptionsMenuState();
    this.renderFileTree();
  }

  private toggleFileViewOptionsMenu(): void {
    const menu = this.root.querySelector<HTMLElement>(".file-view-options-menu");
    const btn = this.root.querySelector<HTMLButtonElement>(
      '.sidebar-tab-action[data-action="toggle-file-view-options"]',
    );
    if (!menu || !btn) return;
    const isOpen = btn.getAttribute("aria-expanded") === "true";
    this.setFileViewOptionsMenuOpen(!isOpen);
    if (!isOpen) this.syncFileViewOptionsMenuState();
  }

  private hideFileViewOptionsMenu(): void {
    this.setFileViewOptionsMenuOpen(false);
  }

  private setFileViewOptionsMenuOpen(open: boolean): void {
    const menu = this.root.querySelector<HTMLElement>(".file-view-options-menu");
    const btn = this.root.querySelector<HTMLButtonElement>(
      '.sidebar-tab-action[data-action="toggle-file-view-options"]',
    );
    if (menu) {
      if (open) menu.removeAttribute("hidden");
      else menu.setAttribute("hidden", "");
    }
    if (btn) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.classList.toggle("sidebar-tab-action-on", open);
    }
  }

  private toggleModelMenu(): void {
    const menu = this.root.querySelector<HTMLElement>(".model-selector-menu");
    const badge = this.root.querySelector<HTMLElement>(".model-badge");
    if (!menu || !badge) return;
    
    const isOpen = badge.getAttribute("aria-expanded") === "true";
    this.hidePillMenus(); // Close others
    
    if (!isOpen) {
      this.renderModelMenu();
      badge.setAttribute("aria-expanded", "true");
      menu.removeAttribute("hidden");
    }
  }

  private toggleIntentMenu(): void {
    const menu = this.root.querySelector<HTMLElement>(".intent-selector-menu");
    const badge = this.root.querySelector<HTMLElement>(".intent-badge");
    if (!menu || !badge) return;

    const isOpen = badge.getAttribute("aria-expanded") === "true";
    this.hidePillMenus(); // Close others

    if (!isOpen) {
      badge.setAttribute("aria-expanded", "true");
      menu.removeAttribute("hidden");
    }
  }

  private hidePillMenus(): void {
    const menus = this.root.querySelectorAll(".model-selector-menu, .intent-selector-menu");
    menus.forEach(m => m.setAttribute("hidden", ""));
    const badges = this.root.querySelectorAll(".model-badge, .intent-badge");
    badges.forEach(b => b.setAttribute("aria-expanded", "false"));
  }

  private renderModelMenu(): void {
    const menu = this.root.querySelector<HTMLElement>(".model-selector-menu");
    if (!menu) return;

    const currentModel = this.agent.getModel();
    const completions = modelCompletions();
    menu.innerHTML = completions
      .map((m: { label: string; detail: string; info: string }) => {
        // detail is either "<slug>" or "<slug> [img]"; the slug is the
        // first token. Highlight the row matching the active model so
        // users can see what they're switching from.
        const slug = m.detail.split(" ")[0];
        const isActive = slug === currentModel;
        const cls = isActive
          ? "model-selector-item model-selector-item-active"
          : "model-selector-item";
        return (
          `<div class="${cls}" data-slug="${escapeAttr(m.label)}">` +
          `<span class="model-item-label">${escapeHtml(m.label)}</span>` +
          `<span class="model-item-detail">${escapeHtml(m.detail)}</span>` +
          `</div>`
        );
      })
      .join("");
  }

  /**
   * Manual refresh of the file tree. Drops cached subtrees to force
   * re-fetching from disk, preserving the expanded set and immediately
   * re-loading them so the user doesn't lose their place.
   */
  private async refreshFileTreeFull(): Promise<void> {
    const expanded = Array.from(this.treeState.expanded);
    this.fileTreeRootLoaded = false;
    this.treeState = {
      ...this.treeState,
      childrenByPath: new Map(),
      loadStateByPath: new Map(),
    };
    
    await this.refreshFileTreeRoot();
    
    // Re-load all previously expanded subtrees in parallel.
    if (expanded.length > 0) {
      await Promise.all(expanded.map(path => this.loadDirectorySubtree(path)));
    }
  }

  private async loadDirectorySubtree(path: string): Promise<void> {
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
    this.renderFileTree();
  }

  private syncFileViewOptionsMenuState(): void {
    const size = this.root.querySelector<HTMLInputElement>(
      '.file-view-options-menu input[data-view-option="size"]',
    );
    const modified = this.root.querySelector<HTMLInputElement>(
      '.file-view-options-menu input[data-view-option="modified"]',
    );
    if (size) size.checked = this.showFileSizes;
    if (modified) modified.checked = this.showFileModified;
  }

  /** Sync the hidden-files toggle button's aria + glyph with state. */
  private updateHiddenToggleVisualState(): void {
    const btn = this.root.querySelector<HTMLButtonElement>(
      '.sidebar-tab-action[data-action="toggle-hidden"]',
    );
    if (!btn) return;
    btn.setAttribute("aria-pressed", this.showHiddenFiles ? "true" : "false");
    btn.classList.toggle("sidebar-tab-action-on", this.showHiddenFiles);
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
    // Hidden-files toggle is only relevant when Files tab is visible.
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

      const rows = flattenVisibleRows(this.treeState);
      let mode: "single" | "toggle" | "range" = "single";
      if (e.shiftKey) mode = "range";
      else if (e.metaKey || e.ctrlKey) mode = "toggle";

      this.treeState = updateSelection(this.treeState, rows, path, mode);

      if (kind === "dir" && mode === "single") {
        void this.handleTreeToggle(path);
      } else if (kind === "file" && mode === "single") {
        // Single click opens the file in the editable buffer.
        void this.openFileInEditor(path);
        
        // Live Sync with Pop-out Reader: 
        if (readerUI.isVisible()) {
          void readerUI.open(this.cwd!, path);
        }
      }
      this.renderFileTree();
    });

    // Right-click context menu on any tree row.
    treeEl.addEventListener("contextmenu", (e) => {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-path]");
      if (!row) return;
      e.preventDefault();
      const path = row.dataset.path!;
      const kind = row.dataset.kind ?? "file";
      
      const rows = flattenVisibleRows(this.treeState);
      // If the right-clicked item isn't in the current selection, 
      // switch selection to ONLY this item. Otherwise keep multi-selection.
      if (!this.treeState.selection.has(path)) {
        this.treeState = updateSelection(this.treeState, rows, path, "single");
      }
      
      this.renderFileTree();
      this.showFileTreeContextMenu(e as MouseEvent, path, kind);
    });

    treeEl.addEventListener("keydown", (e) => {
      const rows = flattenVisibleRows(this.treeState);
      if (rows.length === 0) return;
      const sel = this.treeState.selected;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = moveSelection(this.treeState, rows, 1);
        if (next) {
          this.treeState = updateSelection(this.treeState, rows, next, e.shiftKey ? "range" : "single");
        }
        this.renderFileTree();
        if (readerUI.isVisible() && next) {
          void readerUI.open(this.cwd!, next);
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = moveSelection(this.treeState, rows, -1);
        if (next) {
          this.treeState = updateSelection(this.treeState, rows, next, e.shiftKey ? "range" : "single");
        }
        this.renderFileTree();
        if (readerUI.isVisible() && next) {
          void readerUI.open(this.cwd!, next);
        }
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

  /**
   * Show the file-tree right-click context menu anchored at the mouse
   * position. Items vary slightly between files and directories.
   */
  private showFileTreeContextMenu(
    e: MouseEvent,
    path: string,
    kind: string,
  ): void {
    const menu = document.createElement("div");
    menu.className = "tree-context-menu";

    const addItem = (
      label: string,
      icon: string,
      onClick: () => void,
      danger = false,
    ) => {
      const item = document.createElement("div");
      item.className = "tree-context-menu-item" + (danger ? " danger" : "");
      item.innerHTML =
        `<span class="tree-context-menu-icon">${icon}</span>` +
        `<span class="tree-context-menu-label">${escapeHtml(label)}</span>`;
      item.addEventListener("click", () => { close(); onClick(); });
      menu.appendChild(item);
    };

    const addSep = () => {
      const sep = document.createElement("div");
      sep.className = "tree-context-menu-sep";
      menu.appendChild(sep);
    };

    const selection = Array.from(this.treeState.selection);
    const isMulti = selection.length > 1;

    // -- Batch / Copy actions -------------------------------------------------------
    if (isMulti) {
      addItem(`Copy ${selection.length} Paths`, "⎘", () => {
        void navigator.clipboard.writeText(selection.join("\n"));
      });
      addItem(`Add ${selection.length} to Prompt`, "@", () => {
        const cwd = this.cwd;
        const rels = selection.map(p => 
          cwd && p.startsWith(cwd)
            ? p.slice(cwd.endsWith("/") ? cwd.length : cwd.length + 1)
            : p
        );
        this.input.insertText(rels.map(r => `@${r}`).join(" "));
        this.input.focus();
      });
      addSep();
    }

    addItem(isMulti ? "Copy Path (item)" : "Copy Path", "⎘", () => {
      void navigator.clipboard.writeText(path);
    });

    // Relative path = strip cwd prefix (+ trailing slash).
    const cwd = this.cwd;
    const rel =
      cwd && path.startsWith(cwd)
        ? path.slice(cwd.endsWith("/") ? cwd.length : cwd.length + 1)
        : path;
    if (cwd && path.startsWith(cwd)) {
      addItem(isMulti ? "Copy Relative (item)" : "Copy Relative Path", "◌", () => {
        void navigator.clipboard.writeText(rel);
      });
    }

    // -- Stage in the prompt as an @-reference -----------------------------
    if (!isMulti) {
      addItem("Add to Prompt", "@", () => {
        this.input.insertText(`@${rel}`);
        this.input.focus();
      });
    }

    // -- Open / edit --------------------------------------------------------
    if (kind === "file") {
      addSep();
      addItem("Open in Editor", "✎", () => {
        void this.openFileInEditor(path);
      });
    }

    // -- Create siblings / children ----------------------------------------
    // For a directory, new items are created INSIDE it. For a file,
    // they're created in its parent directory (sibling).
    const parentForCreate =
      kind === "dir" ? path : (path.includes("/") ? path.replace(/\/[^/]*$/, "") : "");
    addSep();
    addItem("New File", "+", () => {
      void this.createNewFile(parentForCreate);
    });
    addItem("New Folder", "\u229E", () => {
      void this.createNewFolder(parentForCreate);
    });

    // -- File operations ----------------------------------------------------
    addSep();
    addItem("Rename", "✏", () => {
      void this.promptRenameTreeItem(path);
    });
    addItem("Open in Pop-out", "\u2197", () => {
      void readerUI.open(this.cwd!, path);
    });
    addItem("Move", "\u2192", () => {
      void this.promptMoveTreeItem(path);
    });
    // Delete items (files or folders). Folders use `remove_dir_all` to
    // recurse, so the confirmation modal reflects the increased risk.
    addItem(
      "Delete",
      "\u2421", // DELETE SYMBOL \u2014 monochrome, matches sibling icons
      () => {
        void this.promptDeleteTreeItem(path, kind);
      },
      true,
    );

    // -- Backdrop + positioning + escape ------------------------------------
    const backdrop = document.createElement("div");
    backdrop.className = "tree-context-menu-backdrop";
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") { ev.preventDefault(); close(); }
    };
    const close = () => {
      menu.remove();
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("contextmenu", (ev) => { ev.preventDefault(); close(); });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
    const margin = 4;
    const maxLeft = Math.max(margin, window.innerWidth - menu.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - menu.offsetHeight - margin);
    menu.style.left = `${Math.min(e.clientX, maxLeft)}px`;
    menu.style.top = `${Math.min(e.clientY, maxTop)}px`;
  }

  /**
   * Modal text-input helper. Used wherever the code needs a single
   * line of free-form input from the user (file tree New File /
   * New Folder / Rename). We can't use `window.prompt` because Tauri's
   * WKWebView returns null without showing anything — silently broken.
   * This builds a small modal at runtime that visually matches the
   * existing `.confirm-dialog`, auto-focuses the input, accepts Enter
   * to submit and Esc to cancel, and returns the trimmed text or
   * `null` on cancel.
   */
  private askText(opts: {
    title: string;
    defaultValue?: string;
    placeholder?: string;
    body?: string;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-dialog";
      overlay.dataset.visible = "true";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");

      const card = document.createElement("div");
      card.className = "confirm-dialog-card";

      const titleEl = document.createElement("h2");
      titleEl.className = "confirm-dialog-title";
      titleEl.textContent = opts.title;
      card.appendChild(titleEl);

      if (opts.body) {
        const bodyEl = document.createElement("p");
        bodyEl.className = "confirm-dialog-body";
        bodyEl.textContent = opts.body;
        card.appendChild(bodyEl);
      }

      const input = document.createElement("input");
      input.type = "text";
      input.className = "confirm-dialog-input";
      input.value = opts.defaultValue ?? "";
      if (opts.placeholder) input.placeholder = opts.placeholder;
      card.appendChild(input);

      const actions = document.createElement("div");
      actions.className = "confirm-dialog-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "confirm-dialog-btn confirm-dialog-btn-no";
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      const okBtn = document.createElement("button");
      okBtn.className = "confirm-dialog-btn confirm-dialog-btn-yes";
      okBtn.type = "button";
      okBtn.textContent = "OK";
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      card.appendChild(actions);

      overlay.appendChild(card);
      this.root.appendChild(overlay);

      const finish = (value: string | null) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(value);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          finish(null);
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          const v = input.value.trim();
          finish(v.length === 0 ? null : v);
        }
      };
      okBtn.addEventListener("click", () => {
        const v = input.value.trim();
        finish(v.length === 0 ? null : v);
      });
      cancelBtn.addEventListener("click", () => finish(null));
      // Click on the dimmed backdrop (overlay itself, not the card)
      // dismisses the modal — same affordance the confirm dialog has.
      overlay.addEventListener("mousedown", (ev) => {
        if (ev.target === overlay) finish(null);
      });
      document.addEventListener("keydown", onKey, true);
      // Focus + select-all so the user can immediately overtype the
      // suggested default (e.g. selecting `untitled.txt` and typing).
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    });
  }

  /**
   * Prompt the user to rename a file/dir in-place via the in-app
   * text-input modal. Falls back silently on cancel.
   */
  private async promptRenameTreeItem(path: string): Promise<void> {
    const parts = path.split("/");
    const oldName = parts[parts.length - 1] ?? "";
    const newName = await this.askText({
      title: "Rename",
      defaultValue: oldName,
    });
    if (!newName || newName === oldName) return;
    const dir = parts.slice(0, -1).join("/");
    const newPath = dir ? `${dir}/${newName}` : newName;
    try {
      // Rust `move_file` signature is `(cwd, from, to)` \u2014 the older
      // call here used `src` / `dst` which serde silently dropped,
      // making rename a no-op. Use the canonical names.
      await invoke("move_file", { cwd: this.cwd, from: path, to: newPath });
      // stale path reference doesn't linger.
      if (this.openFilePath === path) this.closeFileEditor();

      // Immediately rename in the local tree state to reflect the change
      // without resetting expansion/load states of other folders.
      this.treeState = renamePathInTree(this.treeState, path, newPath);
      this.renderFileTree();
    } catch (err) {
      window.alert(`Rename failed: ${String(err)}`);
    }
  }

  /**
   * Prompt the user for a destination folder and move the item.
   */
  private async promptMoveTreeItem(path: string): Promise<void> {
    const parts = path.split("/");
    const fileName = parts.pop()!;
    const oldParent = parts.join("/");

    const newParent = await this.askText({
      title: "Move to folder",
      defaultValue: oldParent,
      body: `Moving "${fileName}". Enter the destination directory path.`,
    });

    if (newParent === null || newParent === oldParent) return;

    const newPath = newParent ? `${newParent}/${fileName}` : fileName;

    try {
      await invoke("move_file", { cwd: this.cwd, from: path, to: newPath });

      // If the moved file was open in the editor, close it so the
      // stale path reference doesn't linger.
      if (this.openFilePath === path) this.closeFileEditor();

      // Immediately remove from the local tree state.
      this.treeState = removePathsFromTree(this.treeState, [path]);

      // Refresh the destination parent to show the item in its new home.
      if (!newParent) {
        await this.refreshFileTreeRoot();
      } else if (this.treeState.childrenByPath.has(newParent)) {
        await this.loadDirectorySubtree(newParent);
      } else {
        this.renderFileTree();
      }

      this.notify(`[files] moved ${fileName} to ${newParent || "root"}`);
    } catch (err) {
      window.alert(`Move failed: ${String(err)}`);
    }
  }

  /**
   * Prompt the user to confirm deleting a file, then call the Rust
   * `remove_file` command. Confirmation goes through the same
   * `askConfirm` modal used elsewhere so the user sees a familiar
   * Yes/No card with the filename in the body. On success we close
   * the editor (if the deleted file was open) and refresh the tree
   * so the row disappears.
   *
   * Files-only \u2014 caller already gates by `kind === "file"`. We pass
   * `kind` through anyway so the function is self-contained if
   * the gate is ever loosened.
   */
  private async promptDeleteTreeItem(path: string, kind: string): Promise<void> {
    const name = path.split("/").pop() ?? path;
    const isDir = kind === "dir";
    const decision = await this.askConfirm({
      title: isDir ? "Delete folder?" : "Delete file?",
      body: isDir
        ? `${name} and all its contents will be permanently deleted from disk. This can't be undone from Prism.`
        : `${name} will be permanently deleted from disk. This can't be undone from Prism.`,
    });
    if (!decision.choice) return;
    try {
      if (isDir) {
        await invoke("remove_dir_all", { cwd: this.cwd, path });
      } else {
        await invoke("remove_file", { cwd: this.cwd, path });
      }
      // stale path reference doesn't linger as a phantom buffer.
      if (this.openFilePath === path) this.closeFileEditor();

      // Immediately remove from the local tree state to reflect the deletion
      // without resetting expansion/load states of other folders.
      this.treeState = removePathsFromTree(this.treeState, [path]);
      this.renderFileTree();

      this.notify(`[files] deleted ${stripAnsi(path)}`);
    } catch (err) {
      window.alert(`Could not delete: ${String(err)}`);
    }
  }

  /**
   * Prompt the user for a filename and create an empty file. `parent`
   * is either an absolute / cwd-relative directory path that the file
   * will live in, or `""` / `null` for the cwd root. Refreshes the
   * file tree on success and opens the new file in the editor so the
   * user can start typing immediately.
   */
  private async createNewFile(parent: string | null): Promise<void> {
    if (!this.cwd) {
      window.alert("cwd unknown \u2014 wait for the shell prompt");
      return;
    }
    const name = await this.askText({
      title: "New file",
      defaultValue: "untitled.txt",
      body: parent && parent.length > 0
        ? `Create in ${parent}`
        : "Create at project root",
    });
    if (!name) return;
    const trimmed = name;
    const target = parent && parent.length > 0 ? `${parent}/${trimmed}` : trimmed;
    try {
      await invoke("write_file_text", {
        cwd: this.cwd,
        path: target,
        content: "",
        expectedMtimeSecs: null,
      });
      await this.refreshFileTreeFull();
      void this.openFileInEditor(target);
    } catch (err) {
      window.alert(`Could not create file: ${String(err)}`);
    }
  }

  /**
   * Prompt the user for a folder name and create the directory.
   * `parent` is the same shape as `createNewFile`. Uses `create_dir`
   * which is recursive (mkdir -p), so nested paths like
   * `"a/b/c"` create the chain in one call.
   */
  private async createNewFolder(parent: string | null): Promise<void> {
    if (!this.cwd) {
      window.alert("cwd unknown \u2014 wait for the shell prompt");
      return;
    }
    const name = await this.askText({
      title: "New folder",
      defaultValue: "new-folder",
      body: parent && parent.length > 0
        ? `Create in ${parent}`
        : "Create at project root",
    });
    if (!name) return;
    const trimmed = name;
    const target = parent && parent.length > 0 ? `${parent}/${trimmed}` : trimmed;
    try {
      await invoke("create_dir", { cwd: this.cwd, path: target });
      await this.refreshFileTreeFull();
    } catch (err) {
      window.alert(`Could not create folder: ${String(err)}`);
    }
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
      await this.loadDirectorySubtree(path);
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
    const selected = row.selected ? " file-tree-row-selected" : "";
    const active = row.active ? " file-tree-row-active" : "";
    const kindClass = `file-tree-row-${e.kind}`;
    let icon = "";
    if (e.kind === "dir") {
      // Caret + folder glyph; rotated via CSS when expanded.
      icon = `<span class="file-tree-caret">${row.expanded ? "\u25be" : "\u25b8"}</span>`;
    } else {
      icon = `<span class="file-tree-caret file-tree-caret-spacer">\u00a0</span>`;
    }
    const detailParts: string[] = [];
    if (this.showFileSizes && e.kind === "file" && typeof e.size === "number") {
      detailParts.push(formatTreeBytes(e.size));
    }
    if (
      this.showFileModified &&
      e.kind === "file" &&
      typeof e.mtime_secs === "number" &&
      e.mtime_secs > 0
    ) {
      detailParts.push(formatTreeDate(e.mtime_secs * 1000));
    }
    const detail =
      detailParts.length > 0
        ? `<span class="file-tree-detail">${detailParts.join(" · ")}</span>`
        : "";
    let trailing = "";
    if (row.loadState.kind === "loading") {
      trailing = `<span class="file-tree-detail file-tree-detail-loading">\u2026</span>`;
    } else if (row.loadState.kind === "error") {
      trailing = `<span class="file-tree-detail file-tree-detail-error" title="${escapeAttr(row.loadState.message)}">!</span>`;
    }
    const isOpen = readerUI.getOpenPaths().includes(e.path);
    const viewingIndicator = isOpen ? `<span class="tree-view-indicator" title="Viewing in Pop-out Reader">\u2605</span>` : "";

    return (
      `<div class="file-tree-row ${kindClass}${selected}${active}" ` +
      `data-path="${escapeAttr(e.path)}" data-kind="${e.kind}" ` +
      `style="padding-left:${indentPx}px" role="treeitem" ` +
      `aria-level="${row.depth + 1}" ` +
      `aria-expanded="${e.kind === "dir" ? (row.expanded ? "true" : "false") : ""}">` +
      `${icon}<span class="file-tree-name">${escapeHtml(e.name)}</span>` +
      viewingIndicator +
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
    // The `.file-preview-meta` span is left empty here and populated
    // after read_file_text returns size + mtime; rendering it in two
    // steps avoids a header reflow once the read resolves and keeps
    // the placeholder DOM stable.
    overlay.innerHTML =
      `<div class="file-preview-header">` +
      `<span class="file-preview-dirty" data-dirty="false" aria-hidden="true">\u25cf</span>` +
      `<span class="file-preview-path" title="${escapeAttr(path)}">${escapeHtml(path)}</span>` +
      `<span class="file-preview-meta" aria-label="file size and modification time"></span>` +
      `<button class="file-preview-copy-path" type="button" aria-label="Copy path to clipboard" title="Copy path to clipboard">` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
      `</button>` +
      `<button class="file-preview-save" type="button" disabled aria-label="Save (\u2318S)" title="Save (\u2318S)">Save</button>` +
      `<button class="file-preview-close" type="button" aria-label="Close (Esc)" title="Close (Esc)">\u00d7</button>` +
      `</div>` +
      `<div class="file-preview-body"><div class="file-tree-loading">loading\u2026</div></div>`;

    // Copy-path button: copies the full absolute path to the clipboard
    // and briefly flashes a "Copied!" tooltip so the user gets clear
    // feedback even when the path is truncated in the header.
    const copyBtn = overlay.querySelector<HTMLButtonElement>(".file-preview-copy-path");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(path).then(() => {
          copyBtn.classList.add("copied");
          copyBtn.setAttribute("title", "Copied!");
          setTimeout(() => {
            copyBtn.classList.remove("copied");
            copyBtn.setAttribute("title", "Copy path to clipboard");
          }, 1800);
        });
      });
    }

    overlay.querySelector(".file-preview-close")?.addEventListener(
      "click",
      () => this.closeFileEditor(),
    );
    overlay.querySelector(".file-preview-save")?.addEventListener(
      "click",
      () => void this.saveOpenFile(),
    );

    let loaded: {
      path: string;
      content: string;
      size: number;
      mtime_secs: number;
    };
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

    // Populate the size + relative-modified meta span. The full ISO
    // timestamp lands on the title attribute as a hover affordance for
    // anyone who needs the exact wall-clock time.
    this.updateFilePreviewMeta(loaded.size, loaded.mtime_secs);
    this.fileEditor = new FileEditor(body, loaded.content, path, {
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
   * Update the size + modification-time meta span in the file viewer
   * header. Called once on initial open and again after every save so
   * the user sees fresh values without reopening the file.
   *
   * `mtimeSecs` is the on-disk mtime as UNIX epoch seconds (matches
   * the Tauri `read_file_text` / `write_file_text` return shape).
   */
  private updateFilePreviewMeta(sizeBytes: number, mtimeSecs: number): void {
    const metaEl = this.root.querySelector<HTMLElement>(".file-preview-meta");
    if (!metaEl) return;
    const sizeLabel = formatBytesShort(sizeBytes);
    let when = "";
    let absolute = "";
    if (mtimeSecs > 0) {
      const ms = mtimeSecs * 1000;
      const isoString = new Date(ms).toISOString();
      when = formatRelativeTime(isoString);
      // Friendlier hover than ISO; matches what `ls -l` would print.
      absolute = new Date(ms).toLocaleString();
    }
    metaEl.textContent = when ? `${sizeLabel} \u00b7 ${when}` : sizeLabel;
    if (absolute) {
      metaEl.title = `${sizeBytes.toLocaleString()} bytes \u00b7 modified ${absolute}`;
    } else {
      metaEl.title = `${sizeBytes.toLocaleString()} bytes`;
    }
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
      // Refresh the meta span so the user sees the new size + "just
      // now" timestamp immediately after save instead of stale values.
      this.updateFilePreviewMeta(result.bytes_written, result.mtime_secs);
      this.notify(
        `[edit] saved ${stripAnsi(prettyPath(result.path))} (${formatBytesShort(result.bytes_written)})`,
      );
    } catch (err) {
      this.notifyError(`[edit] save failed: ${stripAnsi(String(err))}`);
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
    this.syncPreviewDividerAccessibility();
  }

  /** Horizontal center-pane divider: label reflects whether the terminal strip is visible. */
  private syncPreviewDividerAccessibility(): void {
    const el = this.root.querySelector<HTMLElement>(
      ".layout-divider-preview[data-divider=\"preview\"]",
    );
    if (!el) return;
    el.setAttribute(
      "aria-label",
      this.terminalVisible
        ? "Resize file viewer and terminal"
        : "Resize file viewer",
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
          : await expandTilde("~/Documents/Prism/Chats/"),
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      target = Array.isArray(picked) ? (picked[0] ?? null) : picked;
    } catch (e) {
      this.notifyError(`[load] dialog failed: ${stripAnsi(String(e))}`);
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
      this.notifyError(`[load] ${stripAnsi(String(e))}`);
      return;
    }

    // Adopt the saved title if there is one and the tab is still
    // "New Tab" (don't clobber a deliberate title set later in this
    // session).
    if (result.title) {
      this.title = result.title.length > 36
        ? result.title.slice(0, 33) + "\u2026"
        : result.title;
      this.autoTitleDone = true;
      this.cb.onTitleChange(this.id, this.title);
    }
    await this.agent.refreshSession();

    const pretty = prettyPath(target);
    const overwroteNote =
      priorCount > 0
        ? ` (replaced ${priorCount} prior message${priorCount === 1 ? "" : "s"})`
        : "";
    const loadLines = [
      `[load] loaded ${result.message_count} message${result.message_count === 1 ? "" : "s"} from ${stripAnsi(pretty)}${overwroteNote}`,
    ];
    if (result.model) {
      loadLines.push(
        `[load] saved model was ${stripAnsi(result.model)} \u2014 current tab uses ${stripAnsi(this.agent.getModel())}. Use /model to switch if desired.`,
      );
    }
    this.notify(loadLines.join("\n"));

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
      this.notifyError(`[load] render failed: ${stripAnsi(String(e))}`);
      return;
    }
    if (history.length === 0) return;
    // Build the entire transcript as one notice block so the messages
    // render as a single cohesive section in AgentView rather than
    // dozens of separate notice rows. ANSI escapes are stripped by
    // appendNotice; the visual structure (newlines, prefixes) survives.
    const lines: string[] = ["\u2500\u2500\u2500 transcript \u2500\u2500\u2500"];
    for (const m of history) {
      const content = (m.content ?? "").replace(/\r?\n/g, "\n");
      if (m.role === "user") {
        lines.push("");
        lines.push(`you \u203a ${content}`);
      } else if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length > 0) {
          if (content.length > 0) {
            lines.push("");
            lines.push(content);
          }
          for (const c of m.tool_calls) {
            const argPreview = c.function.arguments
              .replace(/\s+/g, " ")
              .slice(0, 80);
            lines.push(`\u2192 ${c.function.name} ${argPreview}`);
          }
        } else {
          lines.push("");
          lines.push(`\u2732 assistant`);
          lines.push(content);
        }
      } else if (m.role === "tool") {
        // Truncate large tool payloads so the transcript stays readable.
        const flat = content.replace(/\n/g, " ").trim();
        const preview =
          flat.length > 200 ? flat.slice(0, 197) + "\u2026" : flat;
        lines.push(`  \u2713 ${preview}`);
      }
    }
    lines.push("\u2500\u2500\u2500 end transcript \u2500\u2500\u2500");
    this.notify(lines.join("\n"));
  }

  async saveChat(full: boolean = false): Promise<void> {
    const count = this.agent.getMessageCount();
    if (count === 0) {
      this.notify("[save] nothing to save \u2014 no chat messages yet");
      return;
    }
    // Hybrid naming: tab title stays locked to the first prompt (setTitleFromText),
    // but the save dialog default + exported YAML title follow the latest user
    // message so filenames match recent conversation. User can still edit the path.
    const { slug, exportTitle } = await this.getSaveNamingSuggestion();
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
      : await expandTilde(
          `~/Documents/Prism/Chats/${slug}-${shortStamp()}.${ext}`,
        );
    let target: string | null = null;
    try {
      target = await saveDialog({
        title: full ? "Save chat (full \u2014 includes tool history)" : "Save chat",
        defaultPath,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
    } catch (e) {
      this.notifyError(`[save] dialog failed: ${String(e)}`);
      return;
    }
    if (!target) return; // user cancelled

    await this.exportChat(target, full, exportTitle);
  }

  /**
   * Default filename slug and markdown title for /save: derived from the most
   * recent non-empty user turn so exports align with the latest topic; falls
   * back to the tab title when needed.
   */
  private async getSaveNamingSuggestion(): Promise<{
    slug: string;
    exportTitle: string;
  }> {
    const history = await this.agent.getHistory();
    let lastUser = "";
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role === "user") {
        const t = m.content.trim().replace(/\s+/g, " ");
        if (t.length > 0) {
          lastUser = t;
          break;
        }
      }
    }
    const slugSource = lastUser || this.title;
    const slug = slugify(slugSource) || slugify(this.title) || "chat";
    const exportTitle =
      lastUser.length > 0
        ? truncateLikeTabTitle(lastUser) || this.title
        : this.title;
    return { slug, exportTitle };
  }

  /**
   * Used for both user /save commands and silent background duplication.
   */
  private async exportChat(
    target: string,
    full: boolean = false,
    exportTitle?: string,
  ): Promise<void> {
    const titleForFile = exportTitle ?? this.title;
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
        title: titleForFile,
        full,
      });
      const modeTag = result.format === "prism-chat-v2" ? " (full)" : "";
      this.notify(
        `[save] ${result.message_count} messages \u2192 ${target}${modeTag}`,
      );
    } catch (e) {
      this.notifyError(`[save] failed: ${String(e)}`);
    }
  }

  /**
   * Silently serializes current history to a temp file, returning
   * restore options so TabManager can spawn a clone. Uses the same
   * export title as /save (latest user message) for the temp markdown;
   * the new tab’s strip still uses the source `this.title`.
   */
  async duplicateSession(): Promise<WorkspaceRestoreOptions | null> {
    const { exportTitle } = await this.getSaveNamingSuggestion();
    const tempTarget = await expandTilde(
      `~/Documents/Prism/Chats/temp-dup-${crypto.randomUUID().slice(0, 8)}.full.md`,
    );
    try {
      await invoke("save_chat_markdown", {
        chatId: this.id,
        path: tempTarget,
        model: this.agent.getModel(),
        title: exportTitle,
        full: true,
      });
      return {
        cwd: this.cwd,
        title: this.title,
        loadChatPath: tempTarget,
        sidebarVisible: this.sidebarVisible,
        previewVisible: this.previewVisible,
        terminalVisible: this.terminalVisible,
        consoleVisible: this.consoleVisible,
        agentVisible: this.agentVisible,
      };
    } catch (e) {
      this.notifyError(`[duplicate] failed: ${String(e)}`);
      return null;
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
 * Turn an optional scope string (from `/review <scope>`) into a user-role
 * prompt the Cohesion Review system prompt can work with. Scope can be:
 *   - empty         → review the last 20 commits
 *   - a positive integer → review the last N commits
 *   - a single ref  → review that commit against its parent (e.g. HEAD~3)
 *   - a range       → review the explicit range (e.g. HEAD~3..HEAD)
 *   - a @-path      → review scoped to a particular file or directory
 * Mirrors `buildAuditPrompt` deliberately — the two modes share an output
 * contract so a future report-parser can route both through one path.
 */
function buildReviewPrompt(scope: string): string {
  const checks =
    "Apply the three cohesion checks (refactor cohesion, helper-body " +
    "inspection, frontend\u2194backend schema round-trip) and output only " +
    "the FINDINGS list.";
  if (!scope) {
    return `Review the last 20 commits for cohesion. Use git_log + git_diff + grep + read_file to investigate. ${checks}`;
  }
  if (scope.startsWith("@")) {
    return `Review ${scope} for cohesion. Use grep + read_file to investigate. ${checks}`;
  }
  if (scope.includes("..")) {
    return `Review the git range ${scope} for cohesion. Use git_diff + grep + read_file to investigate. ${checks}`;
  }
  // Bare integer: "last N commits".
  const n = Number(scope);
  if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
    return `Review the last ${n} commits for cohesion. Use git_log + git_diff + grep + read_file to investigate. ${checks}`;
  }
  // Single ref — treat as "this commit vs its parent."
  return `Review commit ${scope} (diff against ${scope}~1) for cohesion. Use git_diff + grep + read_file to investigate. ${checks}`;
}

/**
 * Parse the argument tail of `/review ...`. Same shape as `parseAuditArgs`:
 * an optional `--max-rounds=N` (or `--max-rounds N`) flag, plus everything
 * else treated as the review scope.
 */
function parseReviewArgs(raw: string): {
  scope: string;
  maxToolRounds?: number;
  error?: string;
} {
  return parseAuditArgs(raw);
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
 * Compose a short failure detail for the ProtocolReportCard's step
 * row. Combines the runner-provided `error` (e.g. "timed out after
 * 300s") with the exit code when present, so the card surfaces enough
 * to diagnose without requiring the user to open the full report.
 */
function composeStepFailureDetail(result: StepResult): string {
  const parts: string[] = [];
  if (result.error) parts.push(result.error);
  if (result.exitCode !== null && result.exitCode !== undefined) {
    parts.push(`exit ${result.exitCode}`);
  }
  return parts.join(" \u00b7 ");
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
    preview_visible?: boolean;
    terminal_visible?: boolean;
    agent_visible?: boolean;
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
  /** Visibility of the file-preview area in the center pane. */
  preview_visible: boolean;
  /** Visibility of the xterm strip in the center pane. */
  terminal_visible: boolean;
  /** Visibility of the right-hand agent pane. */
  agent_visible: boolean;
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
  preview_visible: true,
  terminal_visible: true,
  agent_visible: true,
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
    preview_visible: !!p.preview_visible,
    terminal_visible: !!p.terminal_visible,
    agent_visible: !!p.agent_visible,
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

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
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

function renderHistoryMarkdown(msgs: { role: string; content: string }[]): string {
  if (msgs.length === 0) {
    return "_No conversation yet._";
  }
  const out: string[] = ["### Conversation History\n\n"];
  for (const m of msgs) {
    const roleName =
      m.role === "user" ? "**you**" : m.role === "assistant" ? "**agent**" : `_${m.role}_`;
    out.push(`#### ${roleName}\n${m.content}\n\n`);
  }
  return out.join("");
}

/** Same visible truncation rules as the tab strip auto-title. */
function truncateLikeTabTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "";
  return trimmed.length > 36 ? trimmed.slice(0, 33) + "\u2026" : trimmed;
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

const TOPIC_STOPWORDS = new Set([
  "the","and","for","with","this","that","from","into","about","what","when","where","which",
  "would","could","should","have","has","had","your","you","are","was","were","can","cant",
  "will","just","need","want","please","make","build","fix","help","then","also","than",
]);

function topicKeywords(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const parts = input.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const raw of parts) {
    if (raw.length < 4) continue;
    if (TOPIC_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= 10) break;
  }
  return out;
}

function keywordOverlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aset = new Set(a);
  let overlap = 0;
  for (const k of b) {
    if (aset.has(k)) overlap++;
  }
  return overlap / Math.min(a.length, b.length);
}

/** Compact byte formatter for status lines. */
function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTreeDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/**
 * Expand a leading `~/` (or bare `~`) to the user's home directory by
 * round-tripping through the Rust `resolve_home_path` Tauri command.
 *
 * Async because there is no synchronous way to read `$HOME` from the
 * webview \u2014 only the Rust side has a reliable answer. Any path that
 * doesn't start with `~/` is returned unchanged. On failure (no home
 * dir, IPC error) the original path is returned so callers don't see
 * exceptions in best-effort dialog defaults.
 */
async function expandTilde(p: string): Promise<string> {
  if (!p.startsWith("~")) return p;
  try {
    return await invoke<string>("resolve_home_path", { path: p });
  } catch {
    return p;
  }
}
