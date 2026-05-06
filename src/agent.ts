import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { BlockManager } from "./blocks";
import { modelSupportsToolUse } from "./models";
import type { AgentViewApi } from "./agent-view";
import { detectRigorViolation } from "./grounded-rigor";
import { detectVerifiedTrigger } from "./verified-mode";
import {
  WRITE_TOOL_NAMES,
  calculateWriteStats,
  cleanToolSummary,
  extractWritePath,
  formatTurnFooter,
  type WriteEntry,
} from "./turn-summary";
import type { RuntimeProbe, SubstrateRun } from "./findings";
import {
  extractWriteArtifactDiff,
  inferWriteOperation,
  parseHttpFetchProbeForAgent,
} from "./agent-write-artifacts";

/**
 * Universal tool-capable fallback used when the resolved model can't do
 * tool calling. Gemini 2.5 Flash is the project default chat model,
 * supports tools, and is cheap, so it's a safe last-resort swap.
 */
const UNIVERSAL_TOOL_FALLBACK = "anthropic/claude-haiku-4.5";

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

/**
 * Wire-shape of an OpenAI-style tool call announced inside an
 * assistant turn. Mirrors the Rust `ToolCall` struct exactly so the
 * full-history Tauri command serialises through without translation.
 */
export interface ToolCallShape {
  id: string;
  /** Always `"function"` in OpenAI-style tool calls. */
  type: string;
  function: {
    name: string;
    /** JSON-stringified argument blob; not parsed by the frontend. */
    arguments: string;
  };
}

/**
 * Full message shape used for tool-aware rendering of a loaded
 * transcript. Includes everything `agent_get_history_full` returns:
 *   user / assistant text
 *   assistant tool_calls turns (content may be empty)
 *   role=tool results with tool_call_id + name
 */
export interface FullHistoryMessage {
  role: "user" | "assistant" | "tool" | string;
  content: string | null;
  tool_calls?: ToolCallShape[] | null;
  tool_call_id?: string | null;
  name?: string | null;
}

interface SessionInfo {
  message_count: number;
}

// ---------------------------------------------------------------------------
// AgentController
// ---------------------------------------------------------------------------

export interface AgentControllerOptions {
  /**
   * DOM-based agent panel. Owns every agent-rendered surface: prose,
   * tool-log cards, review block, router / header / footer notices,
   * error lines. xterm is no longer in the agent rendering path \u2014 it
   * is reserved for shell I/O.
   */
  view: AgentViewApi;
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
  /**
   * Fires after every tool call completes (success OR failure), with
   * the tool name + raw JSON args + ok flag. The workspace uses this
   * to react to specific tool executions \u2014 e.g. engaging a skill
   * after a successful `read_skill` (Track B sticky engagement, see
   * `MASTER-Plan-II.md#7.3`). Fires AFTER the in-controller bookkeeping
   * (counts, write tracking, audit-probe capture) so observers see a
   * consistent state.
   */
  onToolExecuted?: (info: {
    call_id: string;
    name: string;
    args: string;
    ok: boolean;
    payload: string;
  }) => void;
  /**
   * Read-only access to the current set of engaged skill slugs. Used
   * by the `read_skill` approval card to filter already-engaged skills
   * out of the "consider also" alternatives so we never offer the user
   * something they already have. Returning `undefined` is fine on
   * surfaces where engagement state isn't tracked \u2014 the card just
   * won't filter.
   */
  getEngagedSkillSlugs?: () => string[];
  /**
   * Fires when the user, on a `read_skill` approval card, picks one or
   * more *additional* skills from the "consider also" section. These
   * skills don't round-trip through the LLM tool (the LLM only asked
   * for the primary); the workspace engages them directly via the
   * Track A path. See `MASTER-Plan-II.md#7.3`.
   */
  onAdditionalSkillsEngage?: (slugs: string[]) => void;
  /**
   * Fires exactly once per turn after the final assistant response
   * has been assembled and all mode-specific completion logic has
   * finished. Used by the workspace to refresh credit balances,
   * update token counters, and handle post-turn housekeeping.
   */
  onTurnComplete?: (info: {
    totalTokens?: number;
    estimatedCostUsd?: number;
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
  /** Current busy-state broadcast value, so we don't double-fire callbacks. */
  private busy = false;
  /** Stall-detection timer id (window.setTimeout return value). */
  private stallTimer: number | null = null;
  /**
   * True if the in-flight prompt matched the inventory-shape regex
   * ("what can X do", "list features of X", etc.). Captured at
   * `query()` time; consumed in `onDone()` to drive the uninspected-
   * answer notice when zero tool calls fired. Reset on every new
   * query so a stale value can't leak into the next turn.
   */
  private currentTurnInventoryShaped = false;
  /**
   * One-shot listeners fired on every busy-state transition. Used by
   * `awaitTurnComplete` to resolve when the agent goes busy=true →
   * busy=false. Listeners self-unregister on resolve.
   */
  private turnCompleteListeners: Array<() => void> = [];
  /**
   * Mode name for the in-flight request (e.g. "audit"), if any. Set at
   * query start, cleared on any terminal state. Used by onDone() to
   * decide whether to fire onAuditComplete.
   */
  private currentMode: string | null = null;
  /** Resolved model slug for the in-flight request. Used for onAuditComplete metadata. */
  private currentResolvedModel: string | null = null;
  private suggestedFork = false;
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
  /**
   * True iff this turn was dispatched with a Grounded-Chat system
   * prefix. Used by onDone() to decide whether to enforce the
   * \"\u2713 Observed labels require a real tool call\" invariant. Reset on
   * every query(); only flipped on when `options.systemPrefix` is
   * provided (today: only the verified-mode trigger sets it).
   */
  private currentGroundedActive = false;
  /**
   * Count of tool calls that fired during this turn (every onToolCall
   * increments). Reset on every query(). The rigor check refuses to
   * trust the model's `\u2713 Observed` / `Verified total: N` claims when
   * this is zero \u2014 with no tool work this turn, those labels are
   * structurally impossible to substantiate.
   */
  private currentTurnToolCount = 0;
  /**
   * `Date.now()` captured at the start of the in-flight query. Read on
   * onDone() to compose the dim turn-footer line ("done in 4.2s"). Reset
   * to null on completion / error so a stale value can't leak into a
   * later turn that doesn't go through query() (shouldn't happen, but
   * cheap defense).
   */
  private currentTurnStartedAt: number | null = null;
  /**
   * Per-turn record of every write_file / edit_file invocation that
   * fired (including failures). Read on onDone() to render the
   * "files modified" footer so the user sees at a glance which files
   * the agent touched. Reset on every query().
   */
  private currentTurnWrites: WriteEntry[] = [];
  /** Shell commands verified by successful run_shell tool calls this turn. */
  private currentTurnVerifiedShellCommands: string[] = [];
  /**
   * Approval previews keyed by tool call id. Used to pair the exact
   * approval artifact with its eventual completion event, rather than
   * assuming the latest preview belongs to the next successful write.
   * Cleared at turn start and on terminal states so stale entries
   * cannot leak across requests.
   */
  private pendingApprovals = new Map<string, {
    tool: string;
    args: string;
    preview: string;
    round: number;
  }>();
  // Markdown formatting moved out of the controller: the AgentView
  // (`./agent-view.ts`) now renders Markdown via `marked` directly
  // into the DOM. The previous ANSI-based inline-code / heading
  // formatters are retired by this migration.

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
    this.suggestedFork = false;
    try {
      await invoke("agent_new_session", { chatId: this.opts.chatId });
    } catch (e) {
      console.error("agent_new_session failed", e);
    }
    this.messageCount = 0;
    this.opts.onSessionChange?.(0);
    this.opts.view?.clear();
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

  /**
   * Fetch the full conversation history including tool calls + tool
   * results. System prompt is filtered out. Used by `loadChat()` after
   * a successful seed when the user opts to render the loaded
   * transcript visually in the active tab.
   */
  async getHistoryFull(): Promise<FullHistoryMessage[]> {
    try {
      return await invoke<FullHistoryMessage[]>("agent_get_history_full", {
        chatId: this.opts.chatId,
      });
    } catch (e) {
      console.error("agent_get_history_full failed", e);
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
      this.opts.view.appendError(`[verify] failed: ${String(e)}`);
    }
  }

  async setVerifierModel(model: string): Promise<void> {
    try {
      await invoke("set_verifier_model", { model });
      this.verifierModel = model;
    } catch (e) {
      this.opts.view.appendError(
        `[verify] failed to set verifier model: ${String(e)}`,
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
      this.opts.view.appendError(`[agent] failed to set model: ${String(e)}`);
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

  /**
   * Resolve on the next observed busy=true → busy=false cycle. Used by
   * the recipe runner so it can await one slash-command turn at a time.
   *
   * Subscribe BEFORE dispatching the slash command. The promise tracks
   * whether a busy=true transition was observed; if it never was, the
   * promise hangs (the runner is responsible for not awaiting on slash
   * commands that don't dispatch an agent turn). This is intentional:
   * v1 recipe writers only put agent-dispatching commands (/audit,
   * /review, /build, /fix) in `slash` step kinds.
   */
  awaitTurnComplete(): Promise<{
    assistantText: string;
    mode: string | null;
    cancelled: boolean;
  }> {
    return new Promise((resolve) => {
      let observedBusy = this.busy;
      const tick = () => {
        const wasBusy = observedBusy;
        observedBusy = this.busy;
        if (wasBusy && !observedBusy) {
          const idx = this.turnCompleteListeners.indexOf(tick);
          if (idx >= 0) this.turnCompleteListeners.splice(idx, 1);
          resolve({
            assistantText: this.responseBuffer,
            mode: this.currentMode,
            cancelled: false,
          });
        }
      };
      this.turnCompleteListeners.push(tick);
    });
  }

  /**
   * Read-only access to the most recent assistant response. Used by the
   * recipe runner after `awaitTurnComplete` resolves — the buffer is not
   * reset until the next `query()` so the value survives across
   * `onDone()`.
   */
  getResponseBuffer(): string {
    return this.responseBuffer;
  }

  /**
   * Read the mode of the most recent in-flight (or just-completed) turn.
   * Read this from inside an `awaitTurnComplete` resolution — the field
   * is cleared at the end of `onDone()` AFTER the busy=false setBusy
   * call that fires the listener, so a synchronous read in the resolver
   * sees the right value.
   */
  getCurrentMode(): string | null {
    return this.currentMode;
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
       * Per-turn system-prompt extension. Prepended to the system
       * message on the wire ONLY for this single call; never written
       * into the persisted session history. Used by the Grounded-Chat
       * protocol so its rigor scaffold reaches the model without
       * bloating future turns or contaminating saved chats.
       *
       * Earlier shape wrapped the user message with the protocol and
       * had to round-trip a separate `displayPrompt` so the terminal
       * echo stayed clean. That dance is gone \u2014 the user message
       * sent and shown is always the user's bare text now.
       */
      systemPrefix?: string;
      /** Force-enable/disable the background verifier for this turn. */
      verifierEnabledOverride?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.hasApiKey) {
      this.opts.view.appendError(
        `[agent] no API key configured. Add one to ${this.configPath ?? "~/.config/prism/config.toml"}`,
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
    this.pendingApprovals.clear();
    this.clearActionBar();
    // Reset the grounded-rigor counters so the previous turn's tool
    // calls or grounded flag don't leak into the new one.
    this.currentGroundedActive = !!options.systemPrefix;
    this.currentTurnToolCount = 0;
    this.currentTurnInventoryShaped =
      detectVerifiedTrigger(prompt)?.kind === "inventory";
    // Reset the per-turn footer trackers (elapsed time + writes list)
    // before entering busy state so any rendering hook reading them sees
    // a clean slate.
    this.currentTurnStartedAt = Date.now();
    this.currentTurnWrites = [];
    this.currentTurnVerifiedShellCommands = [];

    // Enter busy state now. Anything that short-circuits below must call
    // setBusy(false) before returning.
    this.setBusy(true);
    // Track mode for this turn so onDone() can fire mode-specific
    // completion callbacks (e.g. onAuditComplete for the audit persona).
    this.currentMode = options.mode ?? null;

    // Echo the user's prompt in the terminal so the dialogue is visible.
    // Cyan `you:` header, then the prompt in normal weight. Newlines in
    // the prompt get normalized to CRLF for xterm.
    //
    // The prompt sent to the model and the prompt echoed here are now
    // always the same string \u2014 protocol scaffolding (Grounded-Chat,
    // future modes) rides on `options.systemPrefix` instead of being
    // smuggled into the user message, so there's no separate "display"
    // form to track.
    //
    // Two leading CRLFs give a clean blank line above the echo. The
    // shell PTY auto-emits its own prompt line whenever it goes idle,
    // and without this buffer that shell-prompt line and our `you \u203a`
    // collide visually \u2014 they end up adjacent or even on the same row.
    // Open a new turn in the agent panel. The user echo is rendered
    // inside the turn block; xterm no longer carries the prompt.
    this.opts.view.beginTurn(prompt);

    // Decide the actual model. Priority:
    //   1. options.modelOverride (e.g. a mode's preferred model)
    //   2. The session's explicit model (set via /model <slug>)
    let resolvedModel = this.model;
    if (options.modelOverride) {
      resolvedModel = options.modelOverride;
      const label = options.mode ?? "override";
      this.opts.view.appendNotice(
        "router",
        `\u2192 [${label}] ${shortSlug(resolvedModel)}`,
      );
    }

    // Hard-gate (belt-and-braces): never send tool schemas to a
    // non-tool-capable model. Swap to the universal fallback and warn.
    if (!modelSupportsToolUse(resolvedModel)) {
      this.opts.view.appendNotice(
        "router",
        `[router] ${shortSlug(resolvedModel)} doesn't support tool use; using ${shortSlug(UNIVERSAL_TOOL_FALLBACK)} for this turn`,
      );
      resolvedModel = UNIVERSAL_TOOL_FALLBACK;
    }
    // Stash the model we're actually using so onAuditComplete can report it.
    this.currentResolvedModel = resolvedModel;

    this.opts.view.appendNotice(
      "agent-header",
      `\u2732 agent (${resolvedModel})`,
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
        // null \u2192 None, which means "use the Rust-side default (config
        // value, or audit-mode boost when in audit mode)".
        maxToolRounds: options.maxToolRounds ?? null,
        // Per-turn system-prompt extension (Grounded-Chat protocol et al).
        // null \u2192 None Rust-side. The Rust agent_query merges this onto
        // the existing system message for the wire request only and
        // never persists it into session history.
        systemPrefix: options.systemPrefix ?? null,
        verifierEnabledOverride: options.verifierEnabledOverride ?? null,
      });
    } catch (err) {
      this.opts.view.appendError(`[agent error] ${String(err)}`);
      this.opts.view.endTurn();
      this.setBusy(false);
      return;
    }
    this.inflightId = requestId;

    this.unlisteners.push(
      await listen<string>(`agent-token-${requestId}`, (e) => {
        this.onToken(e.payload);
      }),
      await listen<{
        call_id: string;
        name: string;
        args: string;
        summary: string;
        ok: boolean;
        round: number;
        payload: string;
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
      await listen<{
        cancelled?: boolean;
        total_chars?: number;
        model?: string;
        message_count: number;
        assistant_text_len?: number;
        total_tokens?: number;
        estimated_cost_usd?: number;
      }>(`agent-done-${requestId}`, (e) => {
        this.onDone(e.payload);
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
    // Phase rule: a tool call earlier in the turn flips
    // `expectingAnswerRule` so the next prose chunk knows it's the
    // start of a new answer phase. The view already opens a fresh
    // prose section underneath the latest tool card on its own; we
    // just clear the flag so it doesn't reapply on every chunk.
    if (this.expectingAnswerRule && piece.length > 0) {
      this.expectingAnswerRule = false;
    }
    // Stream the raw Markdown into the panel; the AgentView re-renders
    // through `marked` so headings, fenced code, lists, and inline
    // code all land as proper DOM nodes.
    this.opts.view.appendProse(piece);
  }

  private onReviewToken(piece: string): void {
    this.resetStallTimer();
    this.opts.view.appendReview(piece);
  }

  private onReviewDone(): void {
    // The view's review section is sealed when the turn ends; nothing
    // to do here for now beyond hooking the event so the stall timer
    // sees activity.
    this.resetStallTimer();
  }

  /**
   * Gated write tool (`write_file` / `edit_file`) requires user approval.
   * Render a card in the action bar with Approve / Approve-session /
   * Reject buttons, then relay the click as `agent_tool_decision`.
   * Preview is pre-formatted on the Rust side with `--- old` / `+++ new`
   * markers we colorize here.
   *
   * `read_skill` gets a richer card with the LLM's primary suggestion
   * highlighted plus its family members offered as alternatives so the
   * user can curate the engaged set in one approval pass. See
   * `renderReadSkillApprovalCard` and `MASTER-Plan-II.md#7.3`.
   */
  private onToolApproval(info: {
    call_id: string;
    tool: string;
    args: string;
    preview: string;
    allow_session_approval?: boolean;
    round: number;
  }): void {
    // The agent is waiting on us — reset the stall timer so we don't
    // prematurely scream "stalled" while a long approval is pending.
    this.resetStallTimer();
    this.pendingApprovals.set(info.call_id, {
      tool: info.tool,
      args: info.args,
      preview: info.preview,
      round: info.round,
    });
    if (info.tool === "read_skill") {
      void this.renderReadSkillApprovalCard(info);
      return;
    }
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
      (info.allow_session_approval === false
        ? ""
        : `<button class="btn btn-approve-session" data-decision="approve-session">Approve all (session)</button>`) +
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
        this.opts.view.appendError(`[approval] ${String(err)}`);
      });
      this.clearActionBar();
    };
  }

  /**
   * Custom approval card for `read_skill`. Renders the LLM's primary
   * pick at top with a checkbox (default checked), plus a "Consider
   * also" section listing the rest of the primary's skill family
   * (slugs sharing a hyphen-separated prefix), each with the derived
   * description and an unchecked checkbox.
   *
   * Decision shape:
   *   - Primary checked  \u2192 send "approve" to Rust (LLM gets the body).
   *   - Primary unchecked \u2192 send "reject" to Rust (LLM gets refusal).
   *   - Any non-primary checked \u2192 fire `onAdditionalSkillsEngage` so
   *     the workspace engages them directly without round-tripping
   *     through the LLM tool.
   *
   * Async because we fetch the corpus from `list_skills`. A placeholder
   * card renders synchronously so the user sees something while the
   * (millisecond) listing resolves.
   */
  private async renderReadSkillApprovalCard(info: {
    call_id: string;
    tool: string;
    args: string;
    preview: string;
    round: number;
  }): Promise<void> {
    const bar = this.getActionsEl();
    if (!bar) return;
    bar.classList.add("visible");

    // Parse primary slug from the LLM's tool args.
    let primarySlug = "";
    try {
      const parsed = JSON.parse(info.args) as { slug?: unknown };
      if (typeof parsed.slug === "string") primarySlug = parsed.slug;
    } catch {
      /* fall through with empty primarySlug; card will render an error */
    }

    // Synchronous placeholder so the user isn't staring at the old
    // tool's card while we fetch the listing.
    bar.innerHTML =
      `<div class="approval-card skill-approval-card">` +
      `<div class="approval-header">` +
      `<span class="approval-label">read_skill</span>` +
      `<span class="approval-hint">awaiting approval</span>` +
      `</div>` +
      `<div class="skill-approval-loading">loading skill list\u2026</div>` +
      `</div>`;

    const cwd = this.opts.getCwd?.() ?? "";
    const engaged = new Set(this.opts.getEngagedSkillSlugs?.() ?? []);
    let skills: ReadSkillSummary[] = [];
    if (cwd) {
      try {
        skills = await invoke<ReadSkillSummary[]>("list_skills", { cwd });
      } catch {
        /* non-fatal; render with empty corpus */
      }
    }

    const primary =
      skills.find((s) => s.slug === primarySlug) ??
      // Fallback: synthesize a primary from the slug alone so the LLM's
      // request still gets surfaced even if list_skills fails or the
      // model hallucinated a slug. Description will be empty in that
      // case; user can still approve/reject.
      ({
        slug: primarySlug,
        name: primarySlug,
        description: "",
        sizeBytes: 0,
      } as ReadSkillSummary);

    const family = inferSkillFamily(
      primarySlug,
      skills.filter((s) => s.slug !== primarySlug && !engaged.has(s.slug)),
    );

    const renderRow = (
      s: ReadSkillSummary,
      opts: { primary: boolean; checked: boolean },
    ): string => {
      const cls =
        "skill-approval-row" + (opts.primary ? " skill-approval-row-primary" : "");
      const desc = s.description
        ? `<span class="skill-approval-row-desc">${escapeHtml(s.description)}</span>`
        : "";
      const sizeTag =
        s.sizeBytes > 0
          ? `<span class="skill-approval-row-size">${formatKBLocal(s.sizeBytes)}</span>`
          : "";
      return (
        `<label class="${cls}">` +
        `<input type="checkbox" data-slug="${escapeHtml(s.slug)}"${opts.checked ? " checked" : ""} />` +
        `<div class="skill-approval-row-text">` +
        `<span class="skill-approval-row-head">` +
        `<span class="skill-approval-row-slug">${escapeHtml(s.slug)}</span>` +
        sizeTag +
        `</span>` +
        desc +
        `</div>` +
        `</label>`
      );
    };

    const sections: string[] = [];
    sections.push(
      `<div class="skill-approval-section-label">Suggested by the agent</div>` +
        renderRow(primary, { primary: true, checked: true }),
    );
    if (family.length > 0) {
      sections.push(
        `<div class="skill-approval-section-label">Consider also from this family</div>` +
          family.map((s) => renderRow(s, { primary: false, checked: false })).join(""),
      );
    }

    bar.innerHTML =
      `<div class="approval-card skill-approval-card">` +
      `<div class="approval-header">` +
      `<span class="approval-label">read_skill</span>` +
      `<span class="approval-hint">awaiting approval</span>` +
      `</div>` +
      `<div class="skill-approval-body">` +
      sections.join("") +
      `<div class="skill-approval-note">Engaging a skill loads its body into every turn for this tab. Disengage anytime by clicking the chip\u2019s \u00d7 or closing the tab.</div>` +
      `</div>` +
      `<div class="approval-buttons">` +
      `<button class="btn btn-approve" data-skill-decision="approve">Approve selected</button>` +
      `<button class="btn btn-reject" data-skill-decision="reject">Reject</button>` +
      `</div>` +
      `</div>`;
    bar.scrollTop = bar.scrollHeight;

    bar.onclick = (ev) => {
      const target = ev.target as HTMLElement | null;
      const decision = target?.getAttribute("data-skill-decision");
      if (!decision) return;
      // Read all checkboxes to figure out who got picked.
      const checked = Array.from(
        bar.querySelectorAll<HTMLInputElement>(
          ".skill-approval-row input[type='checkbox']:checked",
        ),
      ).map((el) => el.dataset.slug ?? "").filter((s) => s.length > 0);
      const primaryChecked = checked.includes(primarySlug);
      const additional = checked.filter((s) => s !== primarySlug);

      if (decision === "reject") {
        // Reject the LLM's tool call entirely. Ignore any "consider
        // also" checks \u2014 if the user hit Reject, they're saying "none
        // of this please".
        void invoke("agent_tool_decision", {
          callId: info.call_id,
          decision: "reject",
        }).catch((err) => {
          this.opts.view.appendError(`[approval] ${String(err)}`);
        });
        this.clearActionBar();
        return;
      }

      // Approve path: send approve/reject for the primary based on its
      // checkbox, then engage any additional checked slugs directly.
      void invoke("agent_tool_decision", {
        callId: info.call_id,
        decision: primaryChecked ? "approve" : "reject",
      }).catch((err) => {
        this.opts.view.appendError(`[approval] ${String(err)}`);
      });
      if (additional.length > 0) {
        try {
          this.opts.onAdditionalSkillsEngage?.(additional);
        } catch (e) {
          console.error("onAdditionalSkillsEngage threw", e);
        }
      }
      this.clearActionBar();
    };
  }

  private onToolCall(info: {
    call_id: string;
    name: string;
    args: string;
    summary: string;
    ok: boolean;
    round: number;
    payload: string;
  }): void {
    this.resetStallTimer();
    const approval = this.pendingApprovals.get(info.call_id);
    // Notify external observers (workspace) that a tool finished.
    // Wrapped in try/catch so a buggy listener can't crash the turn.
    try {
      this.opts.onToolExecuted?.({
        call_id: info.call_id,
        name: info.name,
        args: info.args,
        ok: info.ok,
        payload: info.payload,
      });
    } catch (e) {
      console.error("onToolExecuted threw", e);
    }
    // Count every tool call this turn (success OR failure \u2014 a failed
    // tool call still represents real tool work the model attempted,
    // and the rigor check only cares whether the model bothered to
    // call any tools at all). Read in onDone() to enforce the
    // \"\u2713 Observed requires a tool call\" Grounded-Chat invariant.
    this.currentTurnToolCount += 1;
    // Track write_file / edit_file invocations so onDone() can render a
    // \"files modified\" footer at end-of-turn. Both tools have a string
    // `path` arg; if extraction fails (malformed args) we drop silently
    // rather than emit a footer line with no path.
    if (WRITE_TOOL_NAMES.has(info.name)) {
      const path = extractWritePath(info.args);
      if (path !== null) {
        const operation = inferWriteOperation(info.name, info.payload);
        const stats = calculateWriteStats(info.name, info.args, info.payload);
        this.currentTurnWrites.push({
          tool: info.name,
          path,
          ok: info.ok,
          operation,
          stats,
          summary: info.summary,
        });
        if (info.ok && approval) {
          let artifactDiff = extractWriteArtifactDiff(info.payload);
          this.opts.view.appendDiff({
            path,
            diff: artifactDiff ?? approval.preview,
            source: artifactDiff ? "tool-artifact" : "approval-preview",
            operation,
          });
        }
        this.pendingApprovals.delete(info.call_id);
      }
    }
    // Capture http_fetch invocations into a sibling probe trail so the
    // audit report can preserve runtime evidence even when the model
    // forgets the `evidence:` stanza on a finding line.
    if (info.name === "http_fetch") {
      const probe = parseHttpFetchProbeForAgent(info.args, info.summary, info.ok, info.round);
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
    // Only surface shell suggestions that were actually executed by the
    // backend tool loop and reported success.
    if (info.name === "run_shell" && info.ok) {
      const verified = extractRunShellCommand(info.args);
      if (verified) this.currentTurnVerifiedShellCommands.push(verified);
    }
    // Mark the next onToken to emit the `\u2500\u2500\u2500 answer \u2500\u2500\u2500` phase
    // rule. The flag lives across multiple tool calls in the same turn
    // and is consumed by whichever token arrives first after the loop
    // settles back into prose.
    this.expectingAnswerRule = true;
    const prettyArgs = prettyToolArgs(info.name, info.args);
    // For path-touching tools, the Rust-side summary repeats the path
    // we've already shown on the args line. cleanToolSummary trims
    // that duplication so \"read /Users/.../foo.ts (1.2 KB)\" becomes
    // \"read 1.2 KB\".
    const clean = cleanToolSummary(info.name, info.summary);
    let summary = "";
    if (info.ok) {
      const verb = clean.verb || "ok";
      const pill = clean.pill ? ` (${clean.pill})` : "";
      summary = `${verb}${pill}`;
    } else {
      summary = info.summary;
    }
    this.opts.view.appendToolCall({
      name: info.name,
      argsPretty: prettyArgs,
      status: info.ok ? "ok" : "fail",
      summary,
    });
  }

  private onDone(payload?: {
    cancelled?: boolean;
    total_tokens?: number;
    estimated_cost_usd?: number;
  }): void {
    this.inflightId = null;
    this.setBusy(false);

    // Grounded-Chat rigor enforcement.
    const violation = detectRigorViolation({
      groundedActive: this.currentGroundedActive,
      toolCallCount: this.currentTurnToolCount,
      response: this.responseBuffer,
    });
    if (violation) {
      this.opts.view.appendNotice(
        "grounded-warning",
        `[grounded-chat] the response carries ${violation.summary} but no tool calls fired this turn \u2014 those claims are NOT actually verified. Treat as ? Unverified.`,
      );
    }

    // Uninspected-answer notice
    if (
      this.currentTurnInventoryShaped &&
      this.currentTurnToolCount === 0 &&
      this.responseBuffer.trim().length > 80
    ) {
      this.opts.view.appendNotice(
        "grounded-warning",
        `[uninspected] this answer was produced without reading the codebase \u2014 no file-read tool calls fired this turn. The inventory above is summarized from training-era prior, not verified against the actual source. Treat as informational, not authoritative.`,
      );
    }

    // "Files modified" footer.
    if (this.currentTurnWrites.length > 0) {
      this.opts.view.appendWriteTimeline(this.currentTurnWrites);
      this.opts.view.appendFilesModified(this.currentTurnWrites);
    }

    // Turn footer (Done in Ns \u00b7 N tools \u00b7 model).
    if (this.currentTurnStartedAt !== null) {
      const elapsedMs = Date.now() - this.currentTurnStartedAt;
      const footer = formatTurnFooter({
        elapsedMs,
        toolCount: this.currentTurnToolCount,
        model: this.currentResolvedModel ?? this.model,
        totalTokens: payload?.total_tokens,
        estimatedCostUsd: payload?.estimated_cost_usd,
      });
      this.opts.view.appendNotice("turn-footer", footer);
    }

    // External turn completion hook (used by workspace for billing/telemetry).
    this.opts.onTurnComplete?.({
      totalTokens: payload?.total_tokens,
      estimatedCostUsd: payload?.estimated_cost_usd,
    });

    this.renderActionBar(dedupe(this.currentTurnVerifiedShellCommands).slice(0, 6));
    this.opts.view.endTurn();
    this.clearListeners();

    // Mode-specific completion hooks.
    const finishedMode = this.currentMode;
    const respText = this.responseBuffer;
    const modelForHook = this.currentResolvedModel ?? this.model;
    const hasResponse = respText.trim().length > 0;

    if (finishedMode === "audit" && hasResponse) {
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

    // Reset turn state.
    this.currentMode = null;
    this.currentResolvedModel = null;
    this.currentTurnStartedAt = null;
    this.currentGroundedActive = false;
    this.currentTurnToolCount = 0;
    this.currentTurnWrites = [];
    this.currentTurnVerifiedShellCommands = [];
    this.currentRuntimeProbes = [];
    this.currentSubstrateRuns = [];
    this.currentTurnInventoryShaped = false;
    this.pendingApprovals.clear();

    // Refresh session count so the UI badge stays accurate.
    void this.refreshSessionInfo().then(() => {
      // Suggest forking at ~40 turns (80 messages).
      if (this.messageCount >= 80 && !this.suggestedFork) {
        this.suggestedFork = true;
        this.opts.view.appendNotice(
          "grounded-warning",
          "This conversation is getting long (~40 turns). For best performance and lower costs, consider starting a fresh session if you're shifting topics.",
        );
      }
    });
  }

  private onError(msg: string): void {
    this.opts.view.appendError(`[agent error] ${msg}`);
    this.opts.view.endTurn();
    this.inflightId = null;
    this.setBusy(false);
    this.clearListeners();
    // Errored / cancelled turns don't fire onAuditComplete; clear the
    // mode markers so the next turn starts clean.
    this.currentMode = null;
    this.currentResolvedModel = null;
    // Same defensive reset as onDone() \u2014 don't let an errored turn's
    // grounded flag or footer state bleed into the next attempt.
    this.currentGroundedActive = false;
    this.currentTurnToolCount = 0;
    this.currentTurnStartedAt = null;
    this.currentTurnWrites = [];
    this.currentTurnVerifiedShellCommands = [];
    this.currentTurnInventoryShaped = false;
    this.pendingApprovals.clear();
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
    // Fire turn-complete listeners (recipe runner) AFTER the public
    // onBusyChange callback so any state the workspace updates in
    // response to busy=false has already been applied. Iterate over a
    // snapshot so listeners that self-unregister don't perturb the loop.
    if (this.turnCompleteListeners.length > 0) {
      for (const tick of this.turnCompleteListeners.slice()) {
        try {
          tick();
        } catch (e) {
          console.error("turnCompleteListener threw", e);
        }
      }
    }
  }

  private startStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = window.setTimeout(() => {
      // Don't kill the stream — just surface that it looks stuck so the
      // user can choose to cancel or keep waiting.
      this.opts.view.appendNotice(
        "stall",
        `[agent] stream silent for ${Math.round(STALL_TIMEOUT_MS / 1000)}s \u2014 click cancel or wait`,
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
 * Pseudo-commands that look like shell commands but are actually tool-call
 * syntax the agent invented. These should never appear in the "Run" action
 * bar because they'll fail when executed in a real shell.
 */
const FAKE_COMMANDS = new Set([
  "edit",
  "create",
  "modify",
  "update",
  "change",
  "write",
  "add",
  "delete",
  "remove",
  "prism-edit",
  "prism-create",
  "prism-modify",
]);

/**
 * Pull runnable commands out of fenced code blocks. Keeps the *first line* of
 * shell-ish blocks; multi-line scripts can still be copied in full with the
 * Copy button.
 *
 * Filters out pseudo-commands (fake tool-call syntax) that would fail if
 * executed in a real shell.
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
    if (!firstLine) continue;

    // Skip pseudo-commands that aren't real shell executables.
    const strippedCmd = stripLeadingPrompt(firstLine);
    const cmd = strippedCmd.split(/\s+/)[0];
    if (FAKE_COMMANDS.has(cmd)) continue;

    out.push(strippedCmd);
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

// ---------------------------------------------------------------------------
// Skill-approval helpers (Track B family inference)
// ---------------------------------------------------------------------------

/**
 * Cheap subset of the `SkillSummary` type from `./skills.ts`. We can't
 * import it directly without dragging the Tauri-invoke wrapper into
 * the controller's scope, and inlining keeps agent.ts decoupled from
 * the workspace's skill module.
 */
interface ReadSkillSummary {
  slug: string;
  name: string;
  description: string;
  sizeBytes: number;
}

/**
 * Find the primary's family: skills whose slug shares a hyphen- (or
 * dot-) separated prefix with the primary, dropping the last segment
 * progressively until we find one with siblings.
 *
 * `vc-pitchdeck-framing`     \u2192 prefix `vc-pitchdeck-` \u2192 7 siblings
 * `prism-self-modification-x` \u2192 no progressively shorter prefix has
 *   siblings in the corpus \u2192 return [].
 *
 * Returns at most 12 alternatives so a huge family doesn't overflow
 * the approval card. Larger families are clipped; the user can still
 * load the rest via `/skills load <slug>` afterward.
 */
function inferSkillFamily(
  primarySlug: string,
  candidates: ReadSkillSummary[],
): ReadSkillSummary[] {
  if (!primarySlug || candidates.length === 0) return [];
  const sep = primarySlug.includes("-")
    ? "-"
    : primarySlug.includes(".")
      ? "."
      : null;
  if (!sep) return [];
  const parts = primarySlug.split(sep);
  for (let len = parts.length - 1; len >= 1; len--) {
    const prefix = parts.slice(0, len).join(sep) + sep;
    const siblings = candidates.filter((s) => s.slug.startsWith(prefix));
    if (siblings.length > 0) {
      // Sort alphabetically for deterministic ordering.
      siblings.sort((a, b) => a.slug.localeCompare(b.slug));
      return siblings.slice(0, 12);
    }
  }
  return [];
}

/** Local copy of `formatKB` from skill-limits.ts to avoid the import. */
function formatKBLocal(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const kb = bytes / 1024;
  if (kb < 1) return "<1 KB";
  return `${kb.toFixed(1)} KB`;
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
 * Parse the argv payload from a successful run_shell tool call into a
 * single command string suitable for the action bar.
 */
function extractRunShellCommand(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { command?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.command)) {
      return null;
    }
    const argv = parsed.command.filter((v): v is string => typeof v === "string");
    if (argv.length === 0) return null;
    return argv.join(" ");
  } catch {
    return null;
  }
}

