//! OpenRouter-backed agent integration.
//!
//! Exposes a single `agent_query` Tauri command. It spawns a background task
//! that streams Server-Sent Events from OpenRouter and forwards token deltas
//! to the frontend as `agent-token-<request_id>` events, plus a terminal
//! `agent-done-<request_id>` or `agent-error-<request_id>` event.
//!
//! Frontend cancellation is supported via `agent_cancel`.

use std::sync::Arc;

use dashmap::DashMap;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::approval::{ApprovalDecision, ApprovalState};
use crate::config::ConfigState;

/// Max number of non-system messages kept in the rolling history. Older
/// user/assistant pairs are dropped when we exceed this, so long sessions
/// don't blow past OpenRouter's context window.
const MAX_HISTORY_MESSAGES: usize = 40;

/// OpenRouter slug the audit mode routes to by default. 2M-context Grok
/// is the right fit — audits need to hold the full diff + cross-referenced
/// files at once. User can still override via /model before calling /audit.
const AUDIT_DEFAULT_MODEL: &str = "x-ai/grok-4-fast";

/// OpenRouter slug the fix mode routes to by default. Fixes need precise,
/// surgical edits over moderate context (just the touched files). A strong
/// code-edit model that handles `edit_file` semantics well is the right
/// fit. Haiku is cheap, fast, and disciplined about reading-before-editing.
const FIX_DEFAULT_MODEL: &str = "anthropic/claude-haiku-4.5";

/// Tool-round cap for any "big work" mode (audit, fix) when no per-call
/// override and no config override is in play. Both modes legitimately
/// need a higher ceiling than chat turns: audit cross-references symbols
/// across the whole repo, fix walks every selected finding's file. Used
/// as a floor over the user's `agent.max_tool_rounds` setting.
const BIG_WORK_MODE_MAX_TOOL_ROUNDS: usize = 60;

/// System prompt used only when the frontend passes mode="audit". Replaces
/// the general persona for a single turn; session history is unchanged.
///
/// This prompt is **compiler-first**: the diagnostic substrate (typecheck,
/// future LSP, future runtime probes) is the source of correctness truth,
/// and the LLM's job is to interpret and prioritize substrate output, not
/// to re-derive correctness from source text.
const AUDIT_SYSTEM_PROMPT: &str = "You are Second Pass, the verifier that \
catches what AI-powered editors missed. You sit on top of a diagnostic \
substrate: deterministic checks (compiler, cross-reference, soon LSP and \
runtime probes) that ground every finding in real evidence. Your job is \
to run the substrate, interpret what it surfaces, and produce a \
structured findings list. You MUST NOT edit, create, or delete files.\n\
\n\
GROUND TRUTH HIERARCHY (most authoritative first):\n\
  1. typecheck output \u{2014} the project's actual compiler. If typecheck \
     reports an error, it IS an error.\n\
  2. grep / read_file evidence in the repo \u{2014} used to confirm and \
     localize problems the substrate surfaces.\n\
  3. git_diff / git_log \u{2014} prioritization signal only. They tell you \
     WHICH issues likely matter most (recently touched code), not \
     WHETHER something is real.\n\
  4. Your training-era knowledge \u{2014} LAST resort, frequently wrong about \
     this specific codebase.\n\
\n\
INVESTIGATION ORDER (mandatory):\n\
  1. CALL typecheck FIRST. This is non-optional. Use the tool with no \
     arguments to run the project's auto-detected build/typecheck \
     command. Read every diagnostic. Each one is a likely Finding with \
     severity=error.\n\
  2. For each compiler diagnostic, cross-reference with grep / \
     read_file to confirm and write a precise suggested fix. Report it \
     as: '[error] path:line \u{2014} <compiler message, condensed> \u{2014} \
     <concrete fix>'.\n\
  3. BEFORE flagging any 'X is undefined / missing / not declared' \
     claim that typecheck did NOT report, you MUST call ast_query with \
     op='resolve' to confirm. Pass file + symbol; pass line if useful. \
     If the result is `resolved: true`, DO NOT emit the finding \u{2014} the \
     symbol is in scope and you were wrong. If `resolved: false`, \
     include the returned `evidence_detail` in your finding's evidence \
     line as `source=ast`. ast_query is the only deterministic way to \
     answer 'does this symbol exist?' in TS/JS \u{2014} grep cannot.\n\
  4. After the compiler-backed pass, look for non-compiler wiring gaps \
     the type system can't see:\n\
        - stale barrel re-exports in index files\n\
        - dynamic require/import with string literals pointing at \
          renamed/moved files\n\
        - removed-but-still-referenced symbols (compile passes only \
          because a wildcard re-export hides the gap)\n\
        - half-applied renames in routes, config keys, CSS selectors, \
          i18n, env vars, docs\n\
        - call sites passing the old shape to callees that now expect \
          the new shape, when the type-system was permissive enough to \
          let it through\n\
     Use grep + git_diff + git_log to scope these. Report each as \
     '[warning]' or '[error]' depending on whether you can prove it \
     will break at runtime.\n\
  5. If typecheck reports zero diagnostics AND step 4 surfaces nothing, \
     output FINDINGS (0). Don't manufacture warnings to look thorough.\n\
\n\
ANTI-FALSE-POSITIVE RULES (strict, applies even when reframed):\n\
  - The compiler is THE runtime-import authority. If typecheck returned \
     exit_code 0, NO import is broken at runtime. Period. This holds \
     regardless of whether the on-disk filename matches the import \
     specifier's extension. tsx, ts-node, vite, esbuild, webpack, and \
     tsc itself all resolve .js specifiers to .ts sources under modern \
     configs (NodeNext, Node16, bundler).\n\
  - Do NOT flag a .js import as broken in ANY of these forms: \
     'wrong extension', 'non-existent file', 'breaks at runtime', \
     'file not found', 'missing module'. These are all reframes of \
     the SAME forbidden class. If typecheck is clean, the import \
     resolves \u{2014} do not flag it.\n\
  - Do NOT use read_file failure as evidence an import is broken. \
     read_file('foo.js') returning 'no such file' does NOT prove the \
     import is broken; the resolver may map the .js specifier to a \
     .ts source. The compiler is the only authority on this question.\n\
  - Do NOT flag 'looks-broken-in-source-but-compiles-fine' issues of \
     any kind. If the compiler is happy, the burden of proof is on you \
     to show why the runtime behavior is wrong, with concrete grep \
     evidence of an actual call site that will fail.\n\
  - Do NOT speculate. If grep didn't return a hit, the symbol isn't \
     used; do not suggest 'might be used somewhere not searched'.\n\
  - Do NOT report a finding twice. If you already emitted a FINDINGS \
     block, do not emit another. The parser picks the last non-empty \
     block, but duplicates waste tokens and confuse the reader.\n\
\n\
OUTPUT CONTRACT (mandatory format):\n\
  - After investigating, produce one report. No prose preamble.\n\
  - Start with 'FINDINGS (N)' where N is the total count.\n\
  - Then TWO lines per finding, in this exact shape:\n\
      [severity] path/to/file.ext:line \u{2014} description \u{2014} suggested fix\n\
      evidence: source=<src>; detail=<...> [ | source=<src>; detail=<...> ]\n\
  - Valid severities: error, warning, info.\n\
  - Valid evidence sources: typecheck, lsp, runtime, test, ast, grep, llm.\n\
  - The evidence line is REQUIRED. Every finding must declare what backed \
     it. Multiple receipts are allowed; separate them with ' | '.\n\
  - 'error' is only appropriate when at least one evidence source is in \
     {typecheck, lsp, runtime, test, ast}. The compiler is the substrate's \
     authority; runtime claims need substrate backing.\n\
  - 'warning' is appropriate for ast-backed structural findings (the \
     grader treats these as 'probable' confidence). Grep-only or \
     llm-only findings will be downgraded to candidate.\n\
  - 'info' = observation the user should know about; not a bug. \
     Appropriate for grep- or llm-only structural observations.\n\
  - One finding per pair of lines. Keep description to a single sentence. \
     Keep evidence detail concise and specific (verbatim compiler line, \
     ast_query evidence_detail, 'grep <pattern>: N hits @ file:line', etc.).\n\
  - Example shape (compiler-backed error):\n\
      [error] src/foo.ts:42 \u{2014} bar is undefined \u{2014} import bar from './bar'\n\
      evidence: source=typecheck; detail=\"src/foo.ts(42,7): error TS2304: Cannot find name 'bar'.\"\n\
  - Example shape (ast-backed warning):\n\
      [warning] src/App.tsx:42 \u{2014} handler 'foo' is not in scope \u{2014} define it or import it\n\
      evidence: source=ast; detail=\"ast: 'foo' is NOT visible in scope at src/App.tsx:42 (tsc resolveName returned undefined under the project's tsconfig)\"\n\
  - Example shape (grep-only structural observation \u{2014} must be info):\n\
      [info] src/old.ts \u{2014} symbol foo no longer referenced anywhere \u{2014} consider removing\n\
      evidence: source=grep; detail=\"grep 'foo' = 0 hits across 142 files\"\n\
  - If genuinely nothing is wrong, output exactly 'FINDINGS (0)' and a \
     one-sentence summary of what you checked. Do NOT emit both a \
     non-zero block and a trailing 'FINDINGS (0)' summary; the parser \
     treats the last non-empty block as canonical.\n\
\n\
WHAT NOT TO DO:\n\
  - Do not call edit_file / write_file. You report, you don't fix.\n\
  - Do not emit 'Summary', 'Timeline', 'Next steps', 'Recommendations', \
     or any other section beyond the findings list.\n\
  - Do not wrap findings in prose explaining your methodology. The \
     tool-call log already shows what you did.\n\
  - Do not skip typecheck because 'the diff looks small'. The compiler \
     is fast and definitive; running it is always the right first step.\n\
  - Do not omit the evidence line. A finding without evidence is a \
     guess, and the grader will treat it as such.\n\
  - Do not invent compiler diagnostics. If you cite source=typecheck, \
     the detail must be a verbatim line from the most recent typecheck \
     tool result. Fabrication is detectable and downgrades the finding.";

/// System prompt used only when the frontend passes mode="fix". The fix
/// consumer reads findings from a previously-written audit report (the
/// JSON sidecar) and applies them via the existing `edit_file` /
/// `write_file` approval flow. Same tools as audit, different persona
/// and different output contract.
const FIX_SYSTEM_PROMPT: &str = "You are Second Pass Fix, the consumer that \
applies findings from a Prism audit report. The user's prompt contains \
an authoritative list of findings; your job is to apply each one through \
the `edit_file` (or, rarely, `write_file`) tool. The user retains \
approval over every write \u{2014} you do NOT bypass that flow.\n\
\n\
GROUND RULES:\n\
  - Treat the findings list in the user prompt as authoritative. The \
     auditor that produced it ran the project's actual compiler. You do \
     NOT need to re-investigate whether each finding is real.\n\
  - Apply findings in the order given. Move on to the next only after \
     the current one's edit_file call has been issued.\n\
  - For every edit, FIRST call read_file on the target so you have the \
     exact current contents (including whitespace). Only then call \
     edit_file with an old_string that uniquely matches.\n\
  - If you cannot safely apply a finding (e.g., the suggested fix is \
     ambiguous, the file has changed since the audit, or the edit would \
     conflict with another), SKIP that finding and report it in your \
     final summary. Do not guess.\n\
  - After applying all findings, optionally call typecheck to confirm \
     the project still builds. If it does not, do NOT chase new \
     diagnostics in the same turn \u{2014} surface them for the user.\n\
  - You MAY use grep / git_diff / bulk_read for context, but bias \
     toward minimum reads. The audit already did the investigation.\n\
\n\
OUTPUT CONTRACT:\n\
  - After all edits are issued, produce a single short report block:\n\
      APPLIED (n)\n\
      <id-or-index> \u{2014} <one-line summary of what was changed>\n\
      ...\n\
      SKIPPED (m)\n\
      <id-or-index> \u{2014} <one-line reason it was not applied>\n\
      ...\n\
      VERIFIED: typecheck <exit_code> [<diagnostics_count> diagnostics]\n\
  - The verified line is optional but encouraged. Omit it if you did \
     not run typecheck after the fixes.\n\
  - One line per applied/skipped finding. Keep summaries terse.\n\
\n\
WHAT NOT TO DO:\n\
  - Do not re-investigate the audit. Trust the findings list.\n\
  - Do not apply changes outside the scope of the listed findings, \
     even if you notice unrelated issues.\n\
  - Do not produce a commit message, a PR description, or any other \
     prose beyond the APPLIED/SKIPPED/VERIFIED block.\n\
  - Do not call edit_file with replace_all=true unless the finding \
     explicitly says 'every occurrence'. Default to single-match edits.";

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AgentBlock {
    pub command: String,
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub output: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct AgentContext {
    #[serde(default)]
    pub cwd: String,
    /// Today's date as seen by the user's system clock (YYYY-MM-DD).
    /// Populated by the frontend on every turn so the model has a
    /// ground truth for "the current date" that overrides its
    /// training cutoff.
    #[serde(default)]
    pub today: String,
    #[serde(default)]
    pub recent_blocks: Vec<AgentBlock>,
    #[serde(default)]
    pub files: Vec<AgentFile>,
    #[serde(default)]
    pub images: Vec<AgentImage>,
}

#[derive(Debug, Deserialize)]
pub struct AgentFile {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AgentImage {
    /// data URL (data:image/png;base64,...) or https URL.
    pub url: String,
}

// ---------------------------------------------------------------------------
// Conversation session
// ---------------------------------------------------------------------------

/// A tool call emitted by the assistant during streaming.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String, // always "function" for OpenAI-style
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    /// JSON string (OpenAI passes args as a stringified JSON blob).
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String, // "system" | "user" | "assistant" | "tool"
    /// Text content. Optional because assistant tool-call messages can omit it
    /// (and multimodal user turns build content arrays at wire-time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Present on assistant messages that invoke tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// Present on role="tool" messages, referencing the assistant's call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Tool function name on tool messages (some providers want this).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }
    pub fn assistant_tool_calls(text: String, calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".into(),
            content: if text.is_empty() { None } else { Some(text) },
            tool_calls: Some(calls),
            tool_call_id: None,
            name: None,
        }
    }
    pub fn tool_result(call_id: String, name: String, content: String) -> Self {
        Self {
            role: "tool".into(),
            content: Some(content),
            tool_calls: None,
            tool_call_id: Some(call_id),
            name: Some(name),
        }
    }
}

/// Handle to the shared session vector. Cloning this is cheap (bumps the Arc
/// count) so we can pass one into the spawned task that will append the
/// assistant's response when streaming completes.
#[derive(Clone, Default)]
struct SessionHandle(Arc<Mutex<Vec<Message>>>);

impl SessionHandle {
    fn ensure_started(&self, system_prompt: &str) {
        let mut g = self.0.lock();
        if g.is_empty() {
            g.push(Message::system(system_prompt));
        }
    }
    fn append_user(&self, content: String) {
        self.0.lock().push(Message::user(content));
    }
    fn append_assistant(&self, content: String) {
        if content.is_empty() {
            return;
        }
        self.0.lock().push(Message::assistant(content));
    }
    fn append_raw(&self, msg: Message) {
        self.0.lock().push(msg);
    }
    fn snapshot(&self) -> Vec<Message> {
        self.0.lock().clone()
    }
    fn clear(&self) {
        self.0.lock().clear();
    }
    fn non_system_count(&self) -> usize {
        self.0.lock().iter().filter(|m| m.role != "system").count()
    }
    fn truncate_to_budget(&self) {
        let mut g = self.0.lock();
        while g.iter().filter(|m| m.role != "system").count() > MAX_HISTORY_MESSAGES {
            if let Some(idx) = g.iter().position(|m| m.role != "system") {
                g.remove(idx);
            } else {
                break;
            }
        }
    }
}

/// Tauri-managed registry: one SessionHandle per `chat_id` (tab).
///
/// `chat_id` is chosen by the frontend; we currently reuse the PTY
/// session id as the chat id so each tab's shell and chat share an
/// identifier.
#[derive(Default)]
pub struct SessionState {
    sessions: Arc<DashMap<String, SessionHandle>>,
}

impl SessionState {
    /// Get or create the handle for a chat id.
    fn get_or_init(&self, chat_id: &str) -> SessionHandle {
        if let Some(h) = self.sessions.get(chat_id) {
            return h.clone();
        }
        let h = SessionHandle::default();
        self.sessions.insert(chat_id.to_string(), h.clone());
        h
    }
    /// Look up an existing handle (does NOT create one).
    fn get(&self, chat_id: &str) -> Option<SessionHandle> {
        self.sessions.get(chat_id).map(|h| h.clone())
    }
    fn drop_chat(&self, chat_id: &str) {
        self.sessions.remove(chat_id);
    }
}

// ---------------------------------------------------------------------------
// In-flight request registry (for cancellation)
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct AgentState {
    inflight: Arc<DashMap<String, Arc<Notify>>>,
}

impl AgentState {
    fn register(&self, id: &str) -> Arc<Notify> {
        let n = Arc::new(Notify::new());
        self.inflight.insert(id.to_string(), n.clone());
        n
    }
    fn cancel(&self, id: &str) {
        if let Some((_, n)) = self.inflight.remove(id) {
            n.notify_waiters();
        }
    }
}

// ---------------------------------------------------------------------------
// OpenRouter wire types
// ---------------------------------------------------------------------------

/// Outgoing message for the OpenRouter request. We build this from the
/// session's history, preserving tool_calls / tool_call_id / name fields
/// when present, and attaching images to the final user turn.
#[derive(Serialize)]
struct OutMessage<'a> {
    role: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<OutContent<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<&'a [ToolCall]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum OutContent<'a> {
    Text(&'a str),
    Parts(Vec<ContentPart<'a>>),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentPart<'a> {
    Text { text: &'a str },
    ImageUrl { image_url: ImageUrl<'a> },
}

#[derive(Serialize)]
struct ImageUrl<'a> {
    url: &'a str,
}

#[derive(Serialize)]
struct OrRequest<'a> {
    model: &'a str,
    messages: Vec<OutMessage<'a>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct OrChunk {
    #[serde(default)]
    choices: Vec<OrChoice>,
}

#[derive(Deserialize)]
struct OrChoice {
    #[serde(default)]
    delta: OrDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct OrDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<OrToolCallDelta>>,
}

#[derive(Deserialize)]
struct OrToolCallDelta {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    #[serde(rename = "type")]
    call_type: Option<String>,
    #[serde(default)]
    function: Option<OrFunctionDelta>,
}

#[derive(Deserialize)]
struct OrFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Start a streaming LLM query. Returns a request id; listen on
/// `agent-token-<id>`, `agent-done-<id>`, `agent-error-<id>`.
///
/// Appends the user message to the session's rolling history, sends the
/// full `messages[]` to OpenRouter, and on success appends the assistant
/// response to the history so follow-up queries are multi-turn.
#[tauri::command]
pub async fn agent_query(
    app: AppHandle,
    cfg: State<'_, ConfigState>,
    state: State<'_, AgentState>,
    session: State<'_, SessionState>,
    approval: State<'_, ApprovalState>,
    chat_id: String,
    prompt: String,
    context: Option<AgentContext>,
    model: Option<String>,
    mode: Option<String>,
    // Per-call override for the tool-round cap. Takes precedence over
    // the audit-mode default and the user's `agent.max_tool_rounds`
    // config setting. Surface this from the frontend (slash commands,
    // /audit --max-rounds N syntax) when one specific turn needs more
    // headroom without permanently raising the global cap.
    max_tool_rounds: Option<usize>,
) -> Result<String, String> {
    let snapshot = cfg.snapshot();
    if snapshot.openrouter.api_key.is_empty() {
        return Err(format!(
            "OpenRouter API key is empty. Add it to {}",
            crate::config::config_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "~/.config/prism/config.toml".into())
        ));
    }

    // Prime session with system prompt if this is the first query for this tab.
    let session_handle = session.get_or_init(&chat_id);
    session_handle.ensure_started(&snapshot.agent.system_prompt);
    session_handle.append_user(build_user_message(&prompt, context.as_ref()));
    session_handle.truncate_to_budget();
    // Images are per-turn and live outside the persisted history to keep
    // future API calls cheap. `take_images` pulls them out of the provided
    // context so we can attach them to this request only.
    let pending_images: Vec<AgentImage> = context
        .as_ref()
        .map(|c| c.images.clone())
        .unwrap_or_default();
    // Clone the handle (cheap Arc bump) so the spawned task can write the
    // assistant message back when it finishes.
    let session_for_task = session_handle.clone();

    let request_id = Uuid::new_v4().to_string();
    let cancel = state.register(&request_id);
    let app_handle = app.clone();
    let inflight_map = Arc::clone(&state.inflight);
    let id_for_task = request_id.clone();

    // Mode lookup: pick the system-prompt override and the default model
    // for this call. Modes are a first-class abstraction so future /explain,
    // /review-pr, /test-gen modes all flow through the same plumbing.
    let (mode_system_prompt, mode_default_model): (Option<&str>, Option<&str>) =
        match mode.as_deref() {
            Some("audit") => (Some(AUDIT_SYSTEM_PROMPT), Some(AUDIT_DEFAULT_MODEL)),
            Some("fix") => (Some(FIX_SYSTEM_PROMPT), Some(FIX_DEFAULT_MODEL)),
            Some(other) => {
                // Unknown mode: log and fall through to normal flow.
                eprintln!("agent_query: unknown mode '{}'; ignoring", other);
                (None, None)
            }
            None => (None, None),
        };

    // Model priority: explicit caller-passed model > mode default > config default.
    let chosen_model = model
        .or_else(|| mode_default_model.map(|s| s.to_string()))
        .unwrap_or_else(|| snapshot.openrouter.default_model.clone());
    let api_key = snapshot.openrouter.api_key.clone();
    let base_url = snapshot.openrouter.base_url.clone();
    // Clone the prompt into an owned String so the spawned task can use it.
    let mode_system_prompt = mode_system_prompt.map(|s| s.to_string());

    // Tool-round cap priority: explicit caller override > big-work mode
    // floor (audit/fix) > the user's config setting. Big-work modes need
    // a higher ceiling than chat: audit cross-references the whole repo,
    // fix walks every selected finding's file. Power users can still dial
    // up via config or per-call --max-rounds without recompiling.
    let is_big_work_mode = matches!(mode.as_deref(), Some("audit") | Some("fix"));
    let max_tool_rounds = max_tool_rounds
        .or_else(|| {
            if is_big_work_mode {
                Some(BIG_WORK_MODE_MAX_TOOL_ROUNDS.max(snapshot.agent.max_tool_rounds))
            } else {
                None
            }
        })
        .unwrap_or(snapshot.agent.max_tool_rounds)
        .max(1);

    // Capture cwd for tool execution (kept outside the session so tools can
    // always resolve relative paths regardless of conversation history).
    let cwd_for_tools = context
        .as_ref()
        .map(|c| c.cwd.clone())
        .unwrap_or_default();

    // Capture verifier config + the original user prompt so the reviewer
    // pass (run after the primary completes) sees them.
    let verifier_cfg = snapshot.agent.verifier.clone();
    let original_prompt = prompt.clone();

    // Capture typecheck-substrate config so the spawned task can dispatch
    // `typecheck` tool calls with the user's project-specific defaults.
    let typecheck_command = snapshot.agent.typecheck_command.clone();
    let typecheck_timeout_secs = snapshot.agent.typecheck_timeout_secs;

    // Clone the approval maps (Arc bumps) so the spawned task can gate
    // write tool calls on user consent without holding Tauri State.
    let approval_pending = Arc::clone(&approval.pending);
    let approval_session = Arc::clone(&approval.session_allowed);
    let chat_id_for_task = chat_id.clone();

    tokio::spawn(async move {
        let token_event = format!("agent-token-{}", id_for_task);
        let tool_event = format!("agent-tool-{}", id_for_task);
        let approval_event = format!("agent-tool-approval-{}", id_for_task);
        let review_event = format!("agent-review-{}", id_for_task);
        let review_done_event = format!("agent-review-done-{}", id_for_task);
        let done_event = format!("agent-done-{}", id_for_task);
        let error_event = format!("agent-error-{}", id_for_task);

        let max_rounds = max_tool_rounds;
        let mut total_chars_all = 0usize;
        let mut final_assistant_text = String::new();
        let mut final_cancelled = false;
        // Track every tool call we executed so the reviewer can see them.
        let mut tool_summaries: Vec<(String, String, bool)> = Vec::new();

        // Tool-use loop: stream → if tools requested, execute & continue; else break.
        let mut attach_images_this_turn = !pending_images.is_empty();
        for round in 0..max_rounds {
            let snapshot = session_for_task.snapshot();
            let images_for_turn: &[AgentImage] = if attach_images_this_turn {
                &pending_images
            } else {
                &[]
            };
            let result = run_stream(
                &app_handle,
                &token_event,
                cancel.clone(),
                &api_key,
                &base_url,
                &chosen_model,
                &snapshot,
                images_for_turn,
                true, // include tools schema every round
                mode_system_prompt.as_deref(),
            )
            .await;
            // Images only attach to the first round; after that the model has
            // seen them and we don't re-send.
            attach_images_this_turn = false;

            match result {
                Ok(StreamOutcome::Completed {
                    total_chars,
                    assistant_text,
                }) => {
                    total_chars_all += total_chars;
                    // No tool calls emitted — this is the final response.
                    session_for_task.append_assistant(assistant_text.clone());
                    final_assistant_text = assistant_text;
                    break;
                }
                Ok(StreamOutcome::ToolCalls {
                    total_chars,
                    partial_text,
                    calls,
                }) => {
                    total_chars_all += total_chars;
                    // Persist the assistant's tool-call turn so the model sees
                    // its own decisions in the next round.
                    session_for_task
                        .append_raw(Message::assistant_tool_calls(partial_text, calls.clone()));

                    // Execute every call, emit status to xterm, and append
                    // tool-result messages for the next round. Write tools
                    // (`write_file`, `edit_file`) are gated on user approval
                    // via the oneshot channel registered in `approval_pending`.
                    for call in &calls {
                        let needs_approval =
                            crate::tools::requires_approval(&call.function.name);
                        let session_ok = approval_session
                            .get(&chat_id_for_task)
                            .map_or(false, |v| *v);
                        let decision = if !needs_approval || session_ok {
                            ApprovalDecision::Approve
                        } else {
                            let preview = crate::tools::preview_write(
                                &call.function.name,
                                &call.function.arguments,
                            );
                            let (tx, rx) = tokio::sync::oneshot::channel::<ApprovalDecision>();
                            approval_pending.insert(call.id.clone(), tx);
                            let _ = app_handle.emit(
                                &approval_event,
                                serde_json::json!({
                                    "call_id": call.id,
                                    "tool": call.function.name,
                                    "args": call.function.arguments,
                                    "preview": preview,
                                    "round": round,
                                }),
                            );
                            tokio::select! {
                                _ = cancel.notified() => {
                                    approval_pending.remove(&call.id);
                                    ApprovalDecision::Reject
                                }
                                res = rx => res.unwrap_or(ApprovalDecision::Reject),
                            }
                        };

                        if decision == ApprovalDecision::ApproveSession {
                            approval_session.insert(chat_id_for_task.clone(), true);
                        }

                        let inv = match decision {
                            ApprovalDecision::Approve | ApprovalDecision::ApproveSession => {
                                if crate::tools::is_async_tool(&call.function.name) {
                                    // Currently just web_search — network-
                                    // backed, needs the async entry point.
                                    match call.function.name.as_str() {
                                        "web_search" => {
                                            crate::tools::execute_web_search(
                                                &call.function.arguments,
                                                &api_key,
                                                &base_url,
                                            )
                                            .await
                                        }
                                        other => crate::tools::ToolInvocation {
                                            ok: false,
                                            summary: format!("unknown async tool: {}", other),
                                            payload: serde_json::json!({
                                                "error": format!("unknown async tool: {}", other),
                                            })
                                            .to_string(),
                                        },
                                    }
                                } else if crate::tools::needs_config_dispatch(
                                    &call.function.name,
                                ) {
                                    // Tools that depend on user config
                                    // (currently just `typecheck`) get the
                                    // dedicated entry point so per-user
                                    // defaults are honored.
                                    crate::tools::execute_typecheck(
                                        &call.function.arguments,
                                        &cwd_for_tools,
                                        typecheck_command.as_deref(),
                                        typecheck_timeout_secs,
                                    )
                                } else {
                                    crate::tools::execute(
                                        &call.function.name,
                                        &call.function.arguments,
                                        &cwd_for_tools,
                                    )
                                }
                            }
                            ApprovalDecision::Reject => crate::tools::ToolInvocation {
                                ok: false,
                                summary: "rejected by user".to_string(),
                                payload: serde_json::json!({
                                    "error": "user rejected this tool call. Do not retry the same edit; ask the user what they'd like instead.",
                                })
                                .to_string(),
                            },
                        };
                        let _ = app_handle.emit(
                            &tool_event,
                            serde_json::json!({
                                "name": call.function.name,
                                "args": call.function.arguments,
                                "summary": inv.summary,
                                "ok": inv.ok,
                                "round": round,
                            }),
                        );
                        tool_summaries.push((
                            call.function.name.clone(),
                            inv.summary.clone(),
                            inv.ok,
                        ));
                        session_for_task.append_raw(Message::tool_result(
                            call.id.clone(),
                            call.function.name.clone(),
                            inv.payload,
                        ));
                    }
                    // Loop: next iteration sends the updated messages back.
                }
                Ok(StreamOutcome::Cancelled { assistant_text }) => {
                    session_for_task.append_assistant(assistant_text);
                    final_cancelled = true;
                    break;
                }
                Err(e) => {
                    let _ = app_handle.emit(&error_event, e.to_string());
                    inflight_map.remove(&id_for_task);
                    return;
                }
            }

            if round + 1 == max_rounds {
                // Cap reached — emit a gentle note into the stream so the
                // user sees we stopped iterating on purpose, with a hint
                // toward the knob they can turn.
                let _ = app_handle.emit(
                    &token_event,
                    format!(
                        "\n\n[tool loop limit reached after {} rounds \u{2014} raise `agent.max_tool_rounds` in config.toml or pass max_tool_rounds on this call]\n",
                        max_rounds,
                    ),
                );
            }
        }

        let payload = if final_cancelled {
            serde_json::json!({
                "cancelled": true,
                "message_count": session_for_task.non_system_count(),
            })
        } else {
            serde_json::json!({
                "total_chars": total_chars_all,
                "model": chosen_model,
                "message_count": session_for_task.non_system_count(),
                "assistant_text_len": final_assistant_text.len(),
            })
        };
        let _ = app_handle.emit(&done_event, payload);

        // ---- Reviewer pass (Warp-style multi-pass validation) ----------
        // Skip when cancelled, when disabled, or when the response was
        // too short to be worth reviewing AND no tools were used.
        let should_review = !final_cancelled
            && verifier_cfg.enabled
            && !verifier_cfg.model.is_empty()
            && (final_assistant_text.len() >= verifier_cfg.min_chars
                || !tool_summaries.is_empty());
        if should_review {
            let review_input = build_reviewer_input(
                &original_prompt,
                &final_assistant_text,
                &tool_summaries,
            );
            let review_messages = vec![
                Message::system(REVIEWER_SYSTEM_PROMPT),
                Message::user(review_input),
            ];
            let outcome = run_stream(
                &app_handle,
                &review_event,
                cancel.clone(),
                &api_key,
                &base_url,
                &verifier_cfg.model,
                &review_messages,
                &[], // no images for review
                false, // no tools for the reviewer
                None, // no mode override for the reviewer
            )
            .await;
            let review_payload = match outcome {
                Ok(_) => serde_json::json!({
                    "model": verifier_cfg.model,
                }),
                Err(e) => serde_json::json!({
                    "model": verifier_cfg.model,
                    "error": e,
                }),
            };
            let _ = app_handle.emit(&review_done_event, review_payload);
        }
        inflight_map.remove(&id_for_task);
    });

    Ok(request_id)
}

#[tauri::command]
pub fn agent_cancel(request_id: String, state: State<'_, AgentState>) {
    state.cancel(&request_id);
}

#[tauri::command]
pub fn agent_new_session(
    chat_id: String,
    session: State<'_, SessionState>,
    approval: State<'_, ApprovalState>,
) {
    if let Some(h) = session.get(&chat_id) {
        h.clear();
    }
    // Starting fresh should re-arm approval prompts too.
    approval.clear_session(&chat_id);
}

#[tauri::command]
pub fn agent_drop_session(chat_id: String, session: State<'_, SessionState>) {
    session.drop_chat(&chat_id);
}

#[tauri::command]
pub fn agent_get_session_info(
    chat_id: String,
    session: State<'_, SessionState>,
) -> serde_json::Value {
    let count = session.get(&chat_id).map_or(0, |h| h.non_system_count());
    serde_json::json!({ "message_count": count })
}

#[tauri::command]
pub fn agent_get_history(
    chat_id: String,
    session: State<'_, SessionState>,
) -> Vec<Message> {
    // Hide system + tool-plumbing messages from the user-visible /history view.
    session
        .get(&chat_id)
        .map(|h| {
            h.snapshot()
                .into_iter()
                .filter(|m| m.role == "user" || m.role == "assistant")
                .filter(|m| m.content.is_some())
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Streaming core
// ---------------------------------------------------------------------------

enum StreamOutcome {
    Completed {
        total_chars: usize,
        assistant_text: String,
    },
    ToolCalls {
        total_chars: usize,
        partial_text: String,
        calls: Vec<ToolCall>,
    },
    Cancelled {
        assistant_text: String,
    },
}

async fn run_stream(
    app: &AppHandle,
    token_event: &str,
    cancel: Arc<Notify>,
    api_key: &str,
    base_url: &str,
    model: &str,
    messages: &[Message],
    pending_images: &[AgentImage],
    include_tools: bool,
    system_override: Option<&str>,
) -> Result<StreamOutcome, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let mut out_messages = build_out_messages(messages, pending_images);
    // If a mode override is set, replace the first system message on the
    // wire for this turn. The session's stored history is unchanged — only
    // what we send to OpenRouter this call differs. If there's no system
    // message at all (shouldn't happen in practice; ensure_started always
    // pushes one), prepend the override.
    if let Some(override_prompt) = system_override {
        if let Some(first) = out_messages.iter_mut().find(|m| m.role == "system") {
            first.content = Some(OutContent::Text(override_prompt));
        } else {
            out_messages.insert(
                0,
                OutMessage {
                    role: "system",
                    content: Some(OutContent::Text(override_prompt)),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                },
            );
        }
    }
    let body = OrRequest {
        model,
        messages: out_messages,
        stream: true,
        tools: if include_tools {
            Some(crate::tools::tool_schema())
        } else {
            None
        },
    };

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .header("HTTP-Referer", "https://prism.local")
        .header("X-Title", "Prism")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OpenRouter {}: {}", status, truncate(&text, 500)));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut total_chars = 0usize;
    let mut assistant_text = String::new();
    // Accumulator for tool calls being assembled from streaming deltas.
    // Keyed by index (which OpenRouter assigns per parallel call).
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    loop {
        tokio::select! {
            _ = cancel.notified() => {
                return Ok(StreamOutcome::Cancelled { assistant_text });
            }
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break; };
                let bytes = chunk.map_err(|e| format!("stream: {}", e))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));

                // Parse complete SSE events separated by blank lines.
                while let Some(sep_pos) = find_event_boundary(&buf) {
                    let event = buf[..sep_pos].to_string();
                    buf.drain(..sep_pos + 2); // consume "\n\n" or "\r\n\r\n"
                    if let Some(data) = extract_data(&event) {
                        if data == "[DONE]" {
                            return Ok(finalize(total_chars, assistant_text, tool_calls));
                        }
                        if let Ok(parsed) = serde_json::from_str::<OrChunk>(&data) {
                            if let Some(choice) = parsed.choices.first() {
                                if let Some(piece) = &choice.delta.content {
                                    if !piece.is_empty() {
                                        total_chars += piece.chars().count();
                                        assistant_text.push_str(piece);
                                        let _ = app.emit(token_event, piece.clone());
                                    }
                                }
                                if let Some(deltas) = &choice.delta.tool_calls {
                                    accumulate_tool_calls(&mut tool_calls, deltas);
                                }
                                if let Some(reason) = &choice.finish_reason {
                                    // Either "stop", "tool_calls", or "length".
                                    if reason == "tool_calls" && !tool_calls.is_empty() {
                                        return Ok(StreamOutcome::ToolCalls {
                                            total_chars,
                                            partial_text: assistant_text,
                                            calls: tool_calls,
                                        });
                                    }
                                    return Ok(finalize(total_chars, assistant_text, tool_calls));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(finalize(total_chars, assistant_text, tool_calls))
}

/// Pick the right outcome based on whether any tool_calls were assembled.
fn finalize(
    total_chars: usize,
    assistant_text: String,
    tool_calls: Vec<ToolCall>,
) -> StreamOutcome {
    if !tool_calls.is_empty() {
        StreamOutcome::ToolCalls {
            total_chars,
            partial_text: assistant_text,
            calls: tool_calls,
        }
    } else {
        StreamOutcome::Completed {
            total_chars,
            assistant_text,
        }
    }
}

/// Merge one SSE chunk's tool_call deltas into the accumulator. OpenRouter
/// streams partial function arguments character-by-character; we rebuild the
/// full ToolCall by appending arguments and filling id/name when they arrive.
fn accumulate_tool_calls(acc: &mut Vec<ToolCall>, deltas: &[OrToolCallDelta]) {
    for d in deltas {
        let idx = d.index.unwrap_or(0) as usize;
        while acc.len() <= idx {
            acc.push(ToolCall {
                id: String::new(),
                call_type: "function".into(),
                function: ToolCallFunction {
                    name: String::new(),
                    arguments: String::new(),
                },
            });
        }
        let slot = &mut acc[idx];
        if let Some(id) = &d.id {
            if !id.is_empty() {
                slot.id = id.clone();
            }
        }
        if let Some(t) = &d.call_type {
            if !t.is_empty() {
                slot.call_type = t.clone();
            }
        }
        if let Some(f) = &d.function {
            if let Some(name) = &f.name {
                if !name.is_empty() {
                    slot.function.name = name.clone();
                }
            }
            if let Some(args) = &f.arguments {
                slot.function.arguments.push_str(args);
            }
        }
    }
}

/// Find the position of a `\n\n` or `\r\n\r\n` boundary in the buffer.
fn find_event_boundary(s: &str) -> Option<usize> {
    if let Some(pos) = s.find("\n\n") {
        return Some(pos);
    }
    if let Some(pos) = s.find("\r\n\r\n") {
        return Some(pos);
    }
    None
}

/// Concatenate all `data:` lines of a single SSE event into one string.
fn extract_data(event: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for line in event.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("data:") {
            parts.push(rest.trim_start());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// Convert stored session messages to the outgoing OpenRouter shape,
/// preserving tool_calls/tool_call_id/name and attaching image parts to the
/// final user message when present.
fn build_out_messages<'a>(
    messages: &'a [Message],
    pending_images: &'a [AgentImage],
) -> Vec<OutMessage<'a>> {
    let last_user_idx = if pending_images.is_empty() {
        None
    } else {
        messages.iter().rposition(|m| m.role == "user")
    };

    messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let content = if Some(i) == last_user_idx {
                let mut parts: Vec<ContentPart> = Vec::with_capacity(1 + pending_images.len());
                if let Some(text) = &m.content {
                    parts.push(ContentPart::Text { text });
                }
                for img in pending_images {
                    parts.push(ContentPart::ImageUrl {
                        image_url: ImageUrl { url: &img.url },
                    });
                }
                Some(OutContent::Parts(parts))
            } else {
                m.content.as_deref().map(OutContent::Text)
            };
            OutMessage {
                role: &m.role,
                content,
                tool_calls: m.tool_calls.as_deref(),
                tool_call_id: m.tool_call_id.as_deref(),
                name: m.name.as_deref(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Reviewer pass
// ---------------------------------------------------------------------------

const REVIEWER_SYSTEM_PROMPT: &str = "You are a careful reviewer for an AI \
assistant embedded in a terminal. The assistant just answered a user's \
question. Your job is to spot inconsistencies, missing pieces, factual \
errors, or claims the assistant made that aren't backed by the tool calls \
it ran. Be concise. Output one of:\n\
  • 'OK — looks complete.' if you find no issues, or\n\
  • 1–3 short bullet points listing the most important gaps or fixes.\n\
Do not summarize or repeat the answer. Do not propose alternative phrasing. \
Focus on substance.";

/// Build the single user-message string sent to the reviewer model.
fn build_reviewer_input(
    user_prompt: &str,
    assistant_response: &str,
    tool_summaries: &[(String, String, bool)],
) -> String {
    let mut out = String::new();
    out.push_str("User asked:\n");
    out.push_str(user_prompt);
    out.push_str("\n\n");
    if !tool_summaries.is_empty() {
        out.push_str("Tool calls executed (in order):\n");
        for (i, (name, summary, ok)) in tool_summaries.iter().enumerate() {
            let mark = if *ok { "\u{2713}" } else { "\u{2717}" };
            out.push_str(&format!("  {}. {} {} — {}\n", i + 1, mark, name, summary));
        }
        out.push('\n');
    }
    out.push_str("Assistant's final answer:\n");
    out.push_str(assistant_response);
    out.push_str("\n\nReview this response per your instructions.\n");
    out
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('\u{2026}');
        out
    }
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

fn build_user_message(prompt: &str, context: Option<&AgentContext>) -> String {
    let Some(ctx) = context else {
        return prompt.to_string();
    };

    let mut out = String::new();
    if !ctx.today.is_empty() {
        // Emphasized so the model notices it over its training prior. The
        // phrasing matters: models anchor on "today is <year>" more reliably
        // than on a bare date line.
        out.push_str(&format!(
            "Current real-world date: {}. Treat this as authoritative; it is NEWER than your training cutoff.\n\n",
            ctx.today
        ));
    }
    if !ctx.cwd.is_empty() {
        out.push_str(&format!("Current working directory: {}\n\n", ctx.cwd));
    }
    if !ctx.recent_blocks.is_empty() {
        out.push_str("Recent commands (newest last):\n");
        for (i, b) in ctx.recent_blocks.iter().enumerate() {
            let ec = b
                .exit_code
                .map(|e| e.to_string())
                .unwrap_or_else(|| "\u{2014}".into());
            out.push_str(&format!("  [{}] exit={} $ {}\n", i + 1, ec, b.command));
            if !b.output.is_empty() {
                let trimmed = truncate(&b.output, 800);
                for line in trimmed.lines().take(12) {
                    out.push_str(&format!("      {}\n", line));
                }
            }
        }
        out.push('\n');
    }
    if !ctx.files.is_empty() {
        out.push_str("Attached files:\n");
        for f in &ctx.files {
            out.push_str(&format!(
                "\n----- BEGIN {}{} -----\n",
                f.path,
                if f.truncated { " (truncated)" } else { "" }
            ));
            out.push_str(&f.content);
            if !f.content.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!("----- END {} -----\n", f.path));
        }
        out.push('\n');
    }
    out.push_str("User question: ");
    out.push_str(prompt);
    out
}
