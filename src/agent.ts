import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { BlockManager } from "./blocks";
import { route as routeModel, parseAutoSlug, PRESETS } from "./router";
import { modelSupportsToolUse } from "./models";

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
}

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

  /** Cancel the in-flight query, if any. */
  cancel(): void {
    if (!this.inflightId) return;
    void invoke("agent_cancel", { requestId: this.inflightId }).catch(() => {});
  }

  /** Kick off a streaming query. `prompt` is the user's raw message. */
  async query(
    prompt: string,
    extraFiles: AgentFileContext[] = [],
    images: AgentImageContext[] = [],
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
    this.clearActionBar();

    // Echo the user's prompt in the terminal so the dialogue is visible.
    // Cyan `you:` header, then the prompt in normal weight. Newlines in the
    // prompt get normalized to CRLF for xterm.
    const echoed = prompt.replace(/\r?\n/g, "\r\n");
    this.opts.term.write(
      `\r\n\x1b[1;36myou\x1b[0m \x1b[2m›\x1b[0m ${echoed}\r\n`,
    );

    // Decide the actual model: if the user is in auto mode, run the
    // rule-based router on the prompt + signals. The model string may
    // be "auto" (legacy), "auto-agentic", "auto-frontier", or
    // "auto-thrifty" — parseAutoSlug maps each to a preset.
    let resolvedModel = this.model;
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

    // Hard-gate (belt-and-braces): even when the router didn't run
    // (user explicitly set `/model sonar`, say), never send tool schemas
    // to a non-tool-capable model. Swap to a safe fallback and warn.
    if (!modelSupportsToolUse(resolvedModel)) {
      const fallback = preset
        ? PRESETS[preset].default
        : UNIVERSAL_TOOL_FALLBACK;
      this.opts.term.write(
        `\r\n\x1b[1;33m[router]\x1b[0m ${PREFIX_DIM}${shortSlug(resolvedModel)} doesn't support tool use; using ${shortSlug(fallback)} for this turn${RESET}`,
      );
      resolvedModel = fallback;
    }

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
      });
    } catch (err) {
      this.writeLineToTerm(`${PREFIX_OPEN}[agent error]${RESET} ${String(err)}`);
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
  }

  // -- streaming callbacks --------------------------------------------------

  private onToken(piece: string): void {
    this.responseBuffer += piece;
    // xterm expects CRLF for newlines. Bare \n moves the cursor down without
    // returning to column 0, so lines stair-step. Normalize on write.
    const normalized = piece.replace(/\r?\n/g, "\r\n");
    this.opts.term.write(normalized);
  }

  private onReviewToken(piece: string): void {
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
    // Dim cyan arrow, tool name in bold cyan, args truncated so a huge file
    // content arg doesn't blow up the line. Result summary on a dim second
    // line so the user sees what actually happened.
    const DIM = "\x1b[2m";
    const CYAN = "\x1b[36m";
    const BOLD = "\x1b[1m";
    const GREEN = "\x1b[32m";
    const RED = "\x1b[31m";
    const RESET = "\x1b[0m";
    const prettyArgs = shortenArgs(info.args);
    const statusColor = info.ok ? GREEN : RED;
    this.opts.term.write(
      `\r\n${DIM}\u2192${RESET} ${BOLD}${CYAN}${info.name}${RESET}${DIM}(${prettyArgs})${RESET}` +
        `\r\n  ${statusColor}\u2190${RESET} ${DIM}${info.summary}${RESET}\r\n`,
    );
  }

  private onDone(): void {
    this.opts.term.write("\r\n");
    this.inflightId = null;
    this.renderActionBar(extractCodeBlocks(this.responseBuffer));
    this.clearListeners();
    // Refresh session count so the UI badge stays accurate.
    void this.refreshSessionInfo();
  }

  private onError(msg: string): void {
    this.writeLineToTerm(`${PREFIX_OPEN}[agent error]${RESET} ${msg}`);
    this.inflightId = null;
    this.clearListeners();
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
  // Collapse whitespace and truncate — tool args are usually tiny, but if a
  // model passes a huge path or payload we don't want to spam the terminal.
  const collapsed = json.replace(/\s+/g, " ").trim();
  const MAX = 120;
  if (collapsed.length <= MAX) return collapsed;
  return collapsed.slice(0, MAX - 1) + "\u2026";
}
