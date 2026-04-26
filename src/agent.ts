import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { BlockManager } from "./blocks";
import { route as routeModel, parseAutoSlug, PRESETS } from "./router";
import { modelSupportsToolUse } from "./models";
import type { RuntimeProbe, SubstrateRun } from "./findings";

/**
 * Universal tool-capable fallback used when the resolved model can't do
 * tool calling AND we're not in an auto preset (so no preset.default to
 * fall back to). Kimi is in every preset's pool and supports tools.
 */
const UNIVERSAL_TOOL_FALLBACK = "moonshotai/kimi-k2.5";

// ---------------------------------------------------------------------------
// Types shared with the Rust side
// ---------------------------------------------------------------------------

interface AgentBlockContext {
  command: string;
  exit_code: number | null;
  output: string;
}

interface AgentFileContext {
  path: string;
  content: string;
  truncated: boolean;
}

export interface AgentImageContext {
  /** data URL: data:image/png;base64,... or a public https URL. */
  url: string;
}

interface AgentContext {
  cwd: string;
  /** Today's date from the user's system clock (YYYY-MM-DD). Piped
   * through to the Rust side so build_user_message can tell the model
   * what year/day it is without relying on training-era priors. */
  today: string;
  recent_blocks: AgentBlockContext[];
  files: AgentFileContext[];
  images: AgentImageContext[];
}

interface AgentConfigInfo {
  default_model: string;
  has_api_key: boolean;
  config_path: string | null;
  verifier_enabled: boolean;
  verifier_model: string;
}

export interface HistoryMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface SessionInfo {
  message_count: number;
}

// ---------------------------------------------------------------------------
// ANSI helpers so agent output reads distinctly from shell output
// ---------------------------------------------------------------------------
const PREFIX_OPEN = "\x1b[1;35m";   // bold magenta
const PREFIX_DIM = "\x1b[2m";       // dim
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// AgentController
// ---------------------------------------------------------------------------

export interface AgentControllerOptions {
  term: Terminal;
  blocks: BlockManager;
  /** PTY session id — used when the agent needs to write to the shell. */
  sessionId: string;
  /** Chat id — keys the per-tab conversation history on the Rust side. */
  chatId: string;
  /** DOM scope for per-workspace action bar lookup. */
  scopeEl?: HTMLElement;
  /** Optional getter for the shell's current working directory (OSC 7). */
  getCwd?: () => string;
  /** Called whenever the resolved model string changes. */
  onModelChange?: (model: string) => void;
  /** Called whenever the session's message count changes. */
  onSessionChange?: (messageCount: number) => void;
  /**
   * Fires `true` when an agent request goes in flight and `false` when it
   * resolves (done / error / cancel / early-failure). Drives the busy pill
   * + cancel button in the input bar.
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Fires when a query has received its request id but no tokens, tool
   * calls, or errors for STALL_TIMEOUT_MS. Drives the stalled variant of
   * the busy pill. Does NOT cancel the request — the user chooses.
   */
  onStall?: () => void;
  /**
   * Fires exactly once per audit-mode turn after the final assistant
   * response has been assembled. The workspace uses this to parse the
   * structured findings and persist the markdown report. Not fired for
   * cancelled or errored turns.
   *
   * `runtimeProbes` carries every `http_fetch` tool call the auditor
   * issued during the turn so the parsed report can preserve runtime
   * evidence even when the model forgets to cite it in a finding's
   * `evidence:` stanza. Empty array if no HTTP probes ran.
   */
  onAuditComplete?: (info: {
    responseText: string;
    model: string;
    runtimeProbes: RuntimeProbe[];
    substrateRuns: SubstrateRun[];
  }) => void;
  /**
   * Fires once per successful build/new/refactor/test-gen turn after
   * the assistant response is fully assembled. The workspace uses this
   * to parse the BUILD/RENAME/SCAFFOLD/TEST GEN REPORT block, render
   * markdown + JSON sidecar, persist them, and update the workspace
   * state pointer. Not fired for cancelled or errored turns.
   *
   * `mode` is the same string the workspace passed to `query()`
   * ("build" | "new" | "refactor" | "test-gen"). `/fix` deliberately
   * uses a different output contract and does NOT fire this hook.
   */
  onBuildComplete?: (info: {
    responseText: string;
    model: string;
    mode: string;
  }) => void;
}

/**
 * If the agent stream goes silent for this long after receiving the
 * request id, surface a warning. Long enough to avoid false positives
 * on slow upstream models but short enough that a true silent failure
 * is visible within a human attention span.
 */
const STALL_TIMEOUT_MS = 45_000;

export class AgentController {
  private readonly opts: AgentControllerOptions;
  private model = "anthropic/claude-haiku-4.5";
  private hasApiKey = false;
  private configPath: string | null = null;
  private inflightId: string | null = null;
  private unlisteners: UnlistenFn[] = [];
  private responseBuffer = "";
  private messageCount = 0;
  private verifierEnabled = true;
  private verifierModel = "anthropic/claude-haiku-4.5";
  /** True once the first review token has arrived for the current request. */
  private reviewHeaderPrinted = false;
  /** Current busy-state broadcast value, so we don't double-fire callbacks. */
  private busy = false;
  /** Stall-detection timer id (window.setTimeout return value). */
  private stallTimer: number | null = null;
  /**
   * Mode name for the in-flight request (e.g. "audit"), if any. Set at
   * query start, cleared on any terminal state. Used by onDone() to
   * decide whether to fire onAuditComplete.
   */
  private currentMode: string | null = null;
  /** Resolved model slug for the in-flight request. Used for onAuditComplete metadata. */
  private currentResolvedModel: string | null = null;
  /**
   * Every `http_fetch` tool call captured during the in-flight turn.
   * Reset at the start of each query and handed to the audit-complete
   * callback so the parsed report can record runtime evidence. Always
   * an array; empty when the agent didn't probe any endpoints.
   */
  private currentRuntimeProbes: RuntimeProbe[] = [];
  /**
   * Every typecheck / run_tests / lsp_diagnostics tool call captured
   * during the in-flight turn. Same shape as runtime probes \u2014 lets
   * the audit report surface exactly which substrate commands ran,
   * which catches the silent-misdetection class (e.g. bare
   * `tsc --noEmit` on a Vite project-references layout that compiles
   * nothing).
   */
  private currentSubstrateRuns: SubstrateRun[] = [];
  /**
   * True iff at least one tool call has fired during this turn AND no
   * assistant tokens have arrived since. Drives the dim `\u2500\u2500\u2500 answer
   * \u2500\u2500\u2500` rule we render before the final-answer prose so the user's
   * eye finds it without scanning the tool log. Reset to false on
   * every token; flipped to true on every tool call. The rule fires
   * exactly once per tool-loop \u2192 prose transition.
   */
  private expectingAnswerRule = false;

  constructor(opts: AgentControllerOptions) {
    this.opts = opts;
    void this.refreshConfig();
    void this.refreshSessionInfo();
  }

  // -- public API -----------------------------------------------------------

  getModel(): string {
    return this.model;
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  /** Clear the rolling conversation so the next query starts fresh. */
  async newSession(): Promise<void> {
    try {
      await invoke("agent_new_session", { chatId: this.opts.chatId });
    } catch (e) {
      console.error("agent_new_session failed", e);
    }
    this.messageCount = 0;
    this.opts.onSessionChange?.(0);
    this.clearActionBar();
  }

  /** Fetch the current chat history (user + assistant messages, oldest first). */
  async getHistory(): Promise<HistoryMessage[]> {
    try {
      return await invoke<HistoryMessage[]>("agent_get_history", {
        chatId: this.opts.chatId,
      });
    } catch (e) {
      console.error("agent_get_history failed", e);
      return [];
    }
  }

  private async refreshSessionInfo(): Promise<void> {
    try {
      const info = await invoke<SessionInfo>("agent_get_session_info", {
        chatId: this.opts.chatId,
      });
      this.messageCount = info.message_count;
      this.opts.onSessionChange?.(this.messageCount);
    } catch {
      /* ignore — probably not mounted yet */
    }
  }

  async refreshConfig(): Promise<void> {
    try {
      const info = await invoke<AgentConfigInfo>("get_agent_config");
      this.model = info.default_model;
      this.hasApiKey = info.has_api_key;
      this.configPath = info.config_path;
      this.verifierEnabled = info.verifier_enabled;
      this.verifierModel = info.verifier_model;
      this.opts.onModelChange?.(this.model);
    } catch (e) {
      console.error("get_agent_config failed", e);
    }
  }

  getVerifier(): { enabled: boolean; model: string } {
    return { enabled: this.verifierEnabled, model: this.verifierModel };
  }

  async setVerifierEnabled(enabled: boolean): Promise<void> {
    try {
      await invoke("set_verifier_enabled", { enabled });
      this.verifierEnabled = enabled;
    } catch (e) {
      this.writeLineToTerm(
        `\x1b[1;31m[verify]\x1b[0m failed: ${String(e)}`,
      );
    }
  }

  async setVerifierModel(model: string): Promise<void> {
    try {
      await invoke("set_verifier_model", { model });
      this.verifierModel = model;
    } catch (e) {
      this.writeLineToTerm(
        `\x1b[1;31m[verify]\x1b[0m failed to set verifier model: ${String(e)}`,
      );
    }
  }

  /** Change the model for subsequent queries and persist it. */
  async setModel(model: string): Promise<void> {
    try {
      await invoke("set_agent_model", { model });
      this.model = model;
      this.opts.onModelChange?.(model);
    } catch (e) {
      this.writeLineToTerm(
        `${PREFIX_OPEN}[agent]${RESET} failed to set model: ${String(e)}`,
      );
    }
  }

  /**
   * Force a refresh of the cached session message count from the Rust
   * side. Used by the workspace's `/load` command after seeding a tab
   * with a saved chat so the model badge picks up the new history
   * length without sending a query first.
   */
  async refreshSession(): Promise<void> {
    return this.refreshSessionInfo();
  }

  /** Cancel the in-flight query, if any. */
  cancel(): void {
    if (!this.inflightId) return;
    void invoke("agent_cancel", { requestId: this.inflightId }).catch(() => {});
    // Optimistically drop the busy state so the pill disappears immediately
    // even if the backend takes a beat to emit its final done event. The
    // subsequent onDone / onError will be a no-op because `busy` is already
    // false (setBusy is idempotent).
    this.setBusy(false);
  }

  /**
   * Is the agent currently processing a request? Readable from the
   * workspace so the pill state can be refreshed (e.g. on activate).
   */
  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Kick off a streaming query. `prompt` is the user's raw message.
   *
   * `options.mode` switches the Rust-side system prompt for this turn
   * only (e.g. 'audit' → Second Pass persona). `options.modelOverride`
   * forces a specific OpenRouter slug for the turn, bypassing the
   * auto-preset router and the session default.
   *
   * `options.maxToolRounds`, if set, overrides the Rust-side tool-round
   * cap for THIS call only — useful for very large audits without
   * permanently raising the user's `agent.max_tool_rounds` config.
   */
  async query(
    prompt: string,
    extraFiles: AgentFileContext[] = [],
    images: AgentImageContext[] = [],
    options: {
      mode?: string;
      modelOverride?: string;
      maxToolRounds?: number;
      /**
       * Optional override for the user-facing echo line. When set, the
       * terminal shows this string under `you \u203a` while the model
       * sees the full `prompt` (protocol preamble + original text).
       * Used by Grounded-Chat to keep the user's view clean while
       * giving the model the rigor scaffold it needs.
       */
      displayPrompt?: string;
    } = {},
  ): Promise<void> {
    if (!this.hasApiKey) {
      this.writeLineToTerm(
        `${PREFIX_OPEN}[agent]${RESET} no API key configured. Add one to ${PREFIX_DIM}${this.configPath ?? "~/.config/prism/config.toml"}${RESET}`,
      );
      return;
    }

    // Close any previous stream cleanly.
    if (this.inflightId) {
      this.cancel();
    }
    this.clearListeners();
    this.responseBuffer = "";
    this.currentRuntimeProbes = [];
    this.currentSubstrateRuns = [];
    this.clearActionBar();

    // Enter busy state now. Anything that short-circuits below must call
    // setBusy(false) before returning.
    this.setBusy(true);
    // Track mode for this turn so onDone() can fire mode-specific
    // completion callbacks (e.g. onAuditComplete for the audit persona).
    this.currentMode = options.mode ?? null;

    // Echo the user's prompt in the terminal so the dialogue is visible.
    // Cyan `you:` header, then the prompt in normal weight. Newlines in the
    // prompt get normalized to CRLF for xterm.
    //
    // When the caller has wrapped the prompt with a protocol preamble
    // (Grounded-Chat) we still want to echo the ORIGINAL user text, so
    // the chrome doesn't dump the rigor scaffold back at the user.
    const echoSource = options.displayPrompt ?? prompt;
    const echoed = echoSource.replace(/\r?\n/g, "\r\n");
    this.opts.term.write(
      `\r\n\x1b[1;36myou\x1b[0m \x1b[2m\u203a\x1b[0m ${echoed}\r\n`,
    );

    // Decide the actual model. Priority:
    //   1. options.modelOverride (e.g. a mode's preferred model)
    //   2. Auto-preset router (when this.model is "auto-*" / "auto")
    //   3. The session's explicit model (set via /model <slug>)
    let resolvedModel = this.model;
    if (options.modelOverride) {
      resolvedModel = options.modelOverride;
      const label = options.mode ?? "override";
      this.opts.term.write(
        `${PREFIX_DIM}\u2192 [${label}] ${shortSlug(resolvedModel)}${RESET}`,
      );
    } else {
      const preset = parseAutoSlug(this.model);
      if (preset !== null) {
        const decision = routeModel(
          prompt,
          {
            hasImages: images.length > 0,
            hasAtRefs: /(?:^|\s)@[A-Za-z0-9._~/+-]/.test(prompt),
            // Prism's agent loop always attaches tool schemas.
            requireToolUse: true,
          },
          preset,
        );
        resolvedModel = decision.slug;
        this.opts.term.write(
          `${PREFIX_DIM}\u2192 [auto/${preset}] ${shortSlug(resolvedModel)} (${decision.reason})${RESET}`,
        );
      }
    }

    // Hard-gate (belt-and-braces): even when the router didn't run
    // (user explicitly set `/model sonar`, say), never send tool schemas
    // to a non-tool-capable model. Swap to a safe fallback and warn.
    if (!modelSupportsToolUse(resolvedModel)) {
      const presetForFallback = parseAutoSlug(this.model);
      const fallback = presetForFallback
        ? PRESETS[presetForFallback].default
        : UNIVERSAL_TOOL_FALLBACK;
      this.opts.term.write(
        `\r\n\x1b[1;33m[router]\x1b[0m ${PREFIX_DIM}${shortSlug(resolvedModel)} doesn't support tool use; using ${shortSlug(fallback)} for this turn${RESET}`,
      );
      resolvedModel = fallback;
    }
    // Stash the model we're actually using so onAuditComplete can report it.
    this.currentResolvedModel = resolvedModel;

    // Announce in the terminal so the user sees something happening immediately.
    this.opts.term.write(
      `\r\n${PREFIX_OPEN}\u2732 agent${RESET} ${PREFIX_DIM}(${resolvedModel})${RESET}\r\n`,
    );

    const context = await this.gatherContext();
    if (extraFiles.length > 0) {
      context.files = [...context.files, ...extraFiles];
    }
    if (images.length > 0) {
      context.images = [...context.images, ...images];
    }

    let requestId: string;
    try {
      requestId = await invoke<string>("agent_query", {
        chatId: this.opts.chatId,
        prompt,
        context,
        model: resolvedModel,
        mode: options.mode ?? null,
        // Tauri rewrites camelCase keys to snake_case for the Rust side,
        // so this lands as `max_tool_rounds: Option<usize>` on agent_query.
        // null → None, which means "use the Rust-side default (config
        // value, or audit-mode boost when in audit mode)".
        maxToolRounds: options.maxToolRounds ?? null,
      });
    } catch (err) {
      this.writeLineToTerm(`${PREFIX_OPEN}[agent error]${RESET} ${String(err)}`);
      this.setBusy(false);
      return;
    }
    this.inflightId = requestId;

    this.reviewHeaderPrinted = false;
    this.unlisteners.push(
      await listen<string>(`agent-token-${requestId}`, (e) => {
        this.onToken(e.payload);
      }),
      await listen<{
        name: string;
        args: string;
        summary: string;
        ok: boolean;
        round: number;
      }>(`agent-tool-${requestId}`, (e) => {
        this.onToolCall(e.payload);
      }),
      await listen<{
        call_id: string;
        tool: string;
        args: string;
        preview: string;
        round: number;
      }>(`agent-tool-approval-${requestId}`, (e) => {
        this.onToolApproval(e.payload);
      }),
      await listen<string>(`agent-review-${requestId}`, (e) => {
        this.onReviewToken(e.payload);
      }),
      await listen(`agent-review-done-${requestId}`, () => {
        this.onReviewDone();
      }),
      await listen(`agent-done-${requestId}`, () => {
        this.onDone();
      }),
      await listen<string>(`agent-error-${requestId}`, (e) => {
        this.onError(e.payload);
      }),
    );
  }

  destroy(): void {
    this.cancel();
    this.clearListeners();
    this.clearStallTimer();
  }

  // -- streaming callbacks --------------------------------------------------

  private onToken(piece: string): void {
    this.responseBuffer += piece;
    this.resetStallTimer();
    // Phase rule: when the first assistant token arrives after a tool
    // call, emit a dim `\u2500\u2500\u2500 answer \u2500\u2500\u2500` rule so the user's eye finds
    // the final prose without scanning the tool log. Skipped when the
    // turn has had no tool calls (chat turns get straight prose).
    if (this.expectingAnswerRule && piece.length > 0) {
      this.expectingAnswerRule = false;
      this.opts.term.write(
        `\r\n\x1b[2m\u2500\u2500\u2500 answer \u2500\u2500\u2500\x1b[0m\r\n`,
      );
    }
    // xterm expects CRLF for newlines. Bare \n moves the cursor down without
    // returning to column 0, so lines stair-step. Normalize on write.
    const normalized = piece.replace(/\r?\n/g, "\r\n");
    this.opts.term.write(normalized);
  }

  private onReviewToken(piece: string): void {
    this.resetStallTimer();
    if (!this.reviewHeaderPrinted) {
      this.reviewHeaderPrinted = true;
      this.opts.term.write(
        `\r\n\x1b[1;33m\u27d1 review\x1b[0m \x1b[2m(${this.verifierModel})\x1b[0m\r\n`,
      );
    }
    const normalized = piece.replace(/\r?\n/g, "\r\n");
    this.opts.term.write(`\x1b[33m${normalized}\x1b[0m`);
  }

  private onReviewDone(): void {
    if (this.reviewHeaderPrinted) {
      // Cap the review block with a newline so the next prompt isn't crammed.
      this.opts.term.write("\r\n");
    }
    this.reviewHeaderPrinted = false;
  }

  /**
   * Gated write tool (`write_file` / `edit_file`) requires user approval.
   * Render a card in the action bar with Approve / Approve-session /
   * Reject buttons, then relay the click as `agent_tool_decision`.
   * Preview is pre-formatted on the Rust side with `--- old` / `+++ new`
   * markers we colorize here.
   */
  private onToolApproval(info: {
    call_id: string;
    tool: string;
    args: string;
    preview: string;
    round: number;
  }): void {
    // The agent is waiting on us — reset the stall timer so we don't
    // prematurely scream "stalled" while a long approval is pending.
    this.resetStallTimer();
    const bar = this.getActionsEl();
    if (!bar) return;
    bar.classList.add("visible");
    const coloredPreview = info.preview
      .split("\n")
      .map((line) => {
        const esc = escapeHtml(line);
        if (line.startsWith("--- ")) {
          return `<span class="diff-marker-old">${esc}</span>`;
        }
        if (line.startsWith("+++ ")) {
          return `<span class="diff-marker-new">${esc}</span>`;
        }
        return esc;
      })
      .join("\n");
    bar.innerHTML =
      `<div class="approval-card">` +
      `<div class="approval-header">` +
      `<span class="approval-label">${escapeHtml(info.tool)}</span>` +
      `<span class="approval-hint">awaiting approval</span>` +
      `</div>` +
      `<pre class="approval-preview">${coloredPreview}</pre>` +
      `<div class="approval-buttons">` +
      `<button class="btn btn-approve" data-decision="approve">Approve</button>` +
      `<button class="btn btn-approve-session" data-decision="approve-session">Approve all (session)</button>` +
      `<button class="btn btn-reject" data-decision="reject">Reject</button>` +
      `</div>` +
      `</div>`;
    // Belt-and-suspenders for the previously-clipped action row: even
    // with the taller actions bar + sticky buttons, on small windows
    // the user could land on a card whose top is visible but whose
    // buttons sit just below the fold. Scroll the wrapper to the end
    // so the Approve / Reject row is in the user's first glance.
    bar.scrollTop = bar.scrollHeight;
    bar.onclick = (ev) => {
      const target = ev.target as HTMLElement | null;
      const decision = target?.getAttribute("data-decision");
      if (!decision) return;
      void invoke("agent_tool_decision", {
        callId: info.call_id,
        decision,
      }).catch((err) => {
        this.writeLineToTerm(
          `\x1b[1;31m[approval]\x1b[0m ${String(err)}`,
        );
      });
      this.clearActionBar();
    };
  }

  private onToolCall(info: {
    name: string;
    args: string;
    summary: string;
    ok: boolean;
    round: number;
  }): void {
    this.resetStallTimer();
    // Capture http_fetch invocations into a sibling probe trail so the
    // audit report can preserve runtime evidence even when the model
    // forgets the `evidence:` stanza on a finding line.
    if (info.name === "http_fetch") {
      const probe = parseHttpFetchProbe(info.args, info.summary, info.ok, info.round);
      if (probe) this.currentRuntimeProbes.push(probe);
    }
    // Capture every substrate-cell invocation so the audit report can
    // show which commands actually ran. Detection misdetections used
    // to be invisible; this surfaces them.
    if (
      info.name === "typecheck" ||
      info.name === "run_tests" ||
      info.name === "lsp_diagnostics"
    ) {
      this.currentSubstrateRuns.push({
        tool: info.name,
        summary: info.summary,
        ok: info.ok,
        round: info.round,
      });
    }
    // Mark the next onToken to emit the `\u2500\u2500\u2500 answer \u2500\u2500\u2500` phase
    // rule. The flag lives across multiple tool calls in the same turn
    // and is consumed by whichever token arrives first after the loop
    // settles back into prose.
    this.expectingAnswerRule = true;
    // Whole-line dim so the tool log recedes visually and the final
    // answer (default brightness) pops. Tool name kept dim-cyan (no
    // bold) so it's still scannable but doesn't compete with the
    // assistant's prose for the eye.
    const DIM = "\x1b[2m";
    const CYAN = "\x1b[36m";
    const GREEN = "\x1b[32m";
    const RED = "\x1b[31m";
    const RESET = "\x1b[0m";
    const prettyArgs = prettyToolArgs(info.name, info.args);
    const argSegment = prettyArgs ? ` ${DIM}${prettyArgs}${RESET}` : "";
    const statusGlyph = info.ok ? `${GREEN}\u2713${RESET}` : `${RED}\u2717${RESET}`;
    this.opts.term.write(
      `\r\n${DIM}\u2192${RESET} ${DIM}${CYAN}${info.name}${RESET}${argSegment}` +
        `\r\n  ${statusGlyph} ${DIM}${info.summary}${RESET}\r\n`,
    );
  }

  private onDone(): void {
    this.opts.term.write("\r\n");
    this.inflightId = null;
    this.setBusy(false);
    this.renderActionBar(extractCodeBlocks(this.responseBuffer));
    this.clearListeners();
    // Fire mode-specific completion hook for audit + build-family
    // turns. Capture mode/model/response BEFORE clearing currentMode so
    // the handlers can read them.
    const finishedMode = this.currentMode;
    const respText = this.responseBuffer;
    const modelForHook = this.currentResolvedModel ?? this.model;
    this.currentMode = null;
    this.currentResolvedModel = null;

    const hasResponse = respText.trim().length > 0;
    if (finishedMode === "audit" && hasResponse) {
      // Snapshot the probes + substrate runs BEFORE clearing so the
      // workspace handler gets the immutable lists this turn captured.
      const probesForHook = this.currentRuntimeProbes.slice();
      const substrateForHook = this.currentSubstrateRuns.slice();
      try {
        this.opts.onAuditComplete?.({
          responseText: respText,
          model: modelForHook,
          runtimeProbes: probesForHook,
          substrateRuns: substrateForHook,
        });
      } catch (e) {
        console.error("onAuditComplete threw", e);
      }
    } else if (
      hasResponse &&
      (finishedMode === "build" ||
        finishedMode === "new" ||
        finishedMode === "refactor" ||
        finishedMode === "test-gen")
    ) {
      try {
        this.opts.onBuildComplete?.({
          responseText: respText,
          model: modelForHook,
          mode: finishedMode,
        });
      } catch (e) {
        console.error("onBuildComplete threw", e);
      }
    }
    // Refresh session count so the UI badge stays accurate.
    void this.refreshSessionInfo();
  }

  private onError(msg: string): void {
    this.writeLineToTerm(`${PREFIX_OPEN}[agent error]${RESET} ${msg}`);
    this.inflightId = null;
    this.setBusy(false);
    this.clearListeners();
    // Errored / cancelled turns don't fire onAuditComplete; clear the
    // mode markers so the next turn starts clean.
    this.currentMode = null;
    this.currentResolvedModel = null;
  }

  // -- busy-state plumbing --------------------------------------------------

  /**
   * Toggle the busy flag, fire the onBusyChange callback, and manage the
   * stall timer. Idempotent: calling setBusy(true) while already busy, or
   * setBusy(false) while already idle, does nothing. Always safe to call
   * defensively at any exit point.
   */
  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    if (busy) {
      this.startStallTimer();
    } else {
      this.clearStallTimer();
    }
    try {
      this.opts.onBusyChange?.(busy);
    } catch (e) {
      console.error("onBusyChange threw", e);
    }
  }

  private startStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = window.setTimeout(() => {
      // Don't kill the stream — just surface that it looks stuck so the
      // user can choose to cancel or keep waiting.
      this.opts.term.write(
        `\r\n\x1b[1;33m[agent]\x1b[0m ${PREFIX_DIM}stream silent for ${Math.round(STALL_TIMEOUT_MS / 1000)}s \u2014 click cancel or wait${RESET}\r\n`,
      );
      try {
        this.opts.onStall?.();
      } catch (e) {
        console.error("onStall threw", e);
      }
    }, STALL_TIMEOUT_MS);
  }

  private resetStallTimer(): void {
    if (!this.busy) return;
    this.startStallTimer();
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      window.clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  // -- helpers --------------------------------------------------------------

  private clearListeners(): void {
    for (const off of this.unlisteners) off();
    this.unlisteners = [];
  }

  private writeLineToTerm(line: string): void {
    this.opts.term.write(`\r\n${line}\r\n`);
  }

  private async gatherContext(): Promise<AgentContext> {
    // Shell's cwd as reported by OSC 7 from the zsh integration. Empty if
    // the shell hasn't emitted one yet (e.g. the user disabled our ZDOTDIR
    // wrapper or is using a non-zsh shell).
    const cwd = this.opts.getCwd?.() ?? "";

    const recent = this.opts.blocks
      .getBlocks()
      .filter((b) => b.status !== "running" && b.command.trim().length > 0)
      .slice(-5)
      .map<AgentBlockContext>((b) => ({
        command: b.command,
        exit_code: b.exitCode ?? null,
        output: "", // block output capture is a future improvement
      }));

    // ISO date (YYYY-MM-DD) from the user's local clock. Cheap ground
    // truth for the model so it stops anchoring to its training cutoff.
    const today = new Date().toISOString().slice(0, 10);

    return { cwd, today, recent_blocks: recent, files: [], images: [] };
  }

  // -- action bar (Run/Copy for suggested commands) -------------------------

  private renderActionBar(commands: string[]): void {
    const bar = this.getActionsEl();
    if (!bar) return;
    if (commands.length === 0) {
      bar.innerHTML = "";
      bar.classList.remove("visible");
      return;
    }
    bar.classList.add("visible");
    bar.innerHTML =
      `<div class="actions-label">Suggested:</div>` +
      commands
        .map(
          (cmd, i) =>
            `<div class="action-card" data-idx="${i}" title="${escapeHtmlAttr(cmd)}">` +
            `<code class="action-cmd">${escapeHtml(cmd)}</code>` +
            `<button class="btn btn-run" data-action="run" data-idx="${i}">Run</button>` +
            `<button class="btn btn-copy" data-action="copy" data-idx="${i}">Copy</button>` +
            `</div>`,
        )
        .join("");

    bar.onclick = (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const action = target.getAttribute("data-action");
      const idxAttr = target.getAttribute("data-idx");
      if (!action || idxAttr == null) return;
      const idx = Number(idxAttr);
      const cmd = commands[idx];
      if (cmd == null) return;
      if (action === "copy") {
        void navigator.clipboard.writeText(cmd).catch(() => {});
      } else if (action === "run") {
        void invoke("write_to_shell", {
          sessionId: this.opts.sessionId,
          data: cmd + "\n",
        }).catch(() => {});
        // Dismiss after run.
        this.clearActionBar();
      }
    };
  }

  private clearActionBar(): void {
    const bar = this.getActionsEl();
    if (!bar) return;
    bar.innerHTML = "";
    bar.classList.remove("visible");
  }

  private getActionsEl(): HTMLElement | null {
    // Prefer a scope-local element (per-tab); fall back to id lookup for
    // single-window callers.
    if (this.opts.scopeEl) {
      return this.opts.scopeEl.querySelector<HTMLElement>(".agent-actions");
    }
    return document.getElementById("agent-actions");
  }
}

// ---------------------------------------------------------------------------
// Markdown code-block extraction
// ---------------------------------------------------------------------------

/**
 * Pull runnable commands out of fenced code blocks. Keeps the *first line* of
 * shell-ish blocks; multi-line scripts can still be copied in full with the
 * Copy button.
 */
function extractCodeBlocks(markdown: string): string[] {
  const out: string[] = [];
  const re = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const lang = (m[1] || "").toLowerCase();
    if (lang && !isShellLang(lang)) continue;
    const body = m[2].trim();
    if (!body) continue;
    // Take the first non-comment, non-blank line as a runnable command.
    const firstLine = body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    if (firstLine) out.push(stripLeadingPrompt(firstLine));
  }
  return dedupe(out).slice(0, 6); // cap to keep the UI tidy
}

function isShellLang(l: string): boolean {
  return (
    l === "" ||
    l === "sh" ||
    l === "bash" ||
    l === "zsh" ||
    l === "shell" ||
    l === "console" ||
    l === "terminal"
  );
}

function stripLeadingPrompt(s: string): string {
  return s.replace(/^(\$|#|>|\u276f)\s+/, "");
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, " ");
}

/** Strip the "provider/" prefix from an OpenRouter slug for compact display. */
function shortSlug(slug: string): string {
  const idx = slug.indexOf("/");
  return idx >= 0 ? slug.slice(idx + 1) : slug;
}

/** Compact a JSON tool-call argument blob for single-line terminal display. */
function shortenArgs(json: string): string {
  // Collapse whitespace and truncate \u2014 tool args are usually tiny, but if a
  // model passes a huge path or payload we don't want to spam the terminal.
  const collapsed = json.replace(/\s+/g, " ").trim();
  const MAX = 120;
  if (collapsed.length <= MAX) return collapsed;
  return collapsed.slice(0, MAX - 1) + "\u2026";
}

/**
 * Argv-style one-line preview for a tool-call argument blob. Each tool
 * gets a hand-rolled formatter that picks the most relevant arg(s) and
 * displays them in a shape closer to how a human would type them, e.g.
 * `web_search "AI code verification 2026"` instead of
 * `web_search({"query":"AI code verification 2026"})`.
 *
 * Falls back to `shortenArgs` for tools we haven't special-cased so
 * nothing ever silently disappears. Returns an empty string when the
 * args are empty (nothing to display).
 */
function prettyToolArgs(toolName: string, json: string): string {
  const trimmed = json.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "null") return "";
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      parsed = v as Record<string, unknown>;
    }
  } catch {
    // fall through to the raw shortener.
  }
  if (!parsed) return shortenArgs(json);

  const str = (k: string): string | undefined => {
    const v = parsed![k];
    return typeof v === "string" ? v : undefined;
  };
  const arrStr = (k: string): string[] | undefined => {
    const v = parsed![k];
    if (!Array.isArray(v)) return undefined;
    return v.filter((x): x is string => typeof x === "string");
  };
  const num = (k: string): number | undefined => {
    const v = parsed![k];
    return typeof v === "number" ? v : undefined;
  };
  const quote = (s: string): string =>
    `\u201c${s.length > 80 ? s.slice(0, 79) + "\u2026" : s}\u201d`;
  const path = (s: string): string =>
    s.length > 80 ? `\u2026${s.slice(s.length - 79)}` : s;

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_directory":
    case "list_directory_tree":
    case "read_file_snippet": {
      const p = str("path");
      return p ? path(p) : "";
    }
    case "web_search": {
      const q = str("query");
      return q ? quote(q) : "";
    }
    case "grep": {
      const pat = str("pattern");
      const inPath = str("path");
      return pat
        ? inPath
          ? `${quote(pat)} in ${path(inPath)}`
          : quote(pat)
        : "";
    }
    case "find": {
      const pat = str("pattern");
      return pat ? quote(pat) : "";
    }
    case "git_diff": {
      const range = str("range");
      const p = str("path");
      const parts: string[] = [];
      if (range) parts.push(range);
      if (p) parts.push(`-- ${path(p)}`);
      return parts.join(" ");
    }
    case "git_log": {
      const refStr = str("ref") ?? "HEAD";
      const limit = num("limit");
      return limit !== undefined ? `${refStr} -${limit}` : refStr;
    }
    case "bulk_read": {
      const paths = arrStr("paths");
      if (!paths || paths.length === 0) return "";
      if (paths.length === 1) return path(paths[0]);
      return `${paths.length} files: ${path(paths[0])} + ${paths.length - 1} more`;
    }
    case "http_fetch": {
      const url = str("url");
      const method = str("method") ?? "GET";
      return url ? `${method.toUpperCase()} ${url}` : "";
    }
    case "e2e_run": {
      const flow = str("flow_name");
      return flow ? quote(flow) : "";
    }
    case "typecheck":
    case "run_tests":
    case "lsp_diagnostics":
    case "schema_inspect": {
      // These tools' interesting state is the override command (when
      // provided); otherwise they auto-detect and the tool name alone
      // is enough.
      const cmd = arrStr("command");
      return cmd && cmd.length > 0 ? cmd.join(" ") : "";
    }
    case "ast_query": {
      const op = str("op") ?? "resolve";
      const sym = str("symbol");
      const file = str("file");
      const parts: string[] = [op];
      if (sym) parts.push(quote(sym));
      if (file) parts.push(`@${path(file)}`);
      return parts.join(" ");
    }
    case "run_shell": {
      const argv = arrStr("command");
      if (!argv || argv.length === 0) return "";
      const joined = argv.join(" ");
      return joined.length > 80 ? joined.slice(0, 79) + "\u2026" : joined;
    }
    case "get_cwd":
      return "";
    default:
      return shortenArgs(json);
  }
}

/**
 * Parse the args + summary of an `http_fetch` tool-call event into a
 * `RuntimeProbe` record. Returns null when the args don't carry a URL
 * (which means the call was rejected before reaching the substrate, so
 * there's no probe to record).
 *
 * Args come over the wire as a JSON string \u2014 e.g.
 *   `{"url":"http://localhost:3000/api/health","method":"GET"}`
 * but we tolerate malformed or non-JSON args by falling back to a
 * minimal record so the probe trail never silently disappears.
 */
function parseHttpFetchProbe(
  args: string,
  summary: string,
  ok: boolean,
  round: number,
): RuntimeProbe | null {
  let url = "";
  let method = "GET";
  try {
    const parsed = JSON.parse(args) as { url?: unknown; method?: unknown };
    if (typeof parsed.url === "string") url = parsed.url.trim();
    if (typeof parsed.method === "string" && parsed.method.trim()) {
      method = parsed.method.trim().toUpperCase();
    }
  } catch {
    // Non-JSON args (shouldn't happen from the agent loop) \u2014 swallow
    // and let url stay empty so we drop the probe below.
  }
  if (!url) return null;
  return { url, method, summary, ok, round };
}
