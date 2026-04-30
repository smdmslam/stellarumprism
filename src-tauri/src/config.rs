//! Persistent user configuration stored at `~/.config/prism/config.toml`.
//!
//! On first run, a template is written with an empty `api_key` so the user
//! can discover where to put it. Reads are tolerant of missing fields.

use std::fs;
use std::path::PathBuf;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenRouterConfig {
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_model")]
    pub default_model: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
}

impl Default for OpenRouterConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            default_model: default_model(),
            base_url: default_base_url(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(default = "default_system_prompt")]
    pub system_prompt: String,
    #[serde(default = "default_max_context_blocks")]
    pub max_context_blocks: usize,
    /// Hard cap on tool-call rounds per agent turn.
    ///
    /// Each round is one upstream completion call: the model emits tool
    /// calls, we execute them, and feed results back in another round.
    /// Hitting this cap prints `[tool loop limit reached]` and stops the
    /// turn. The default is sized for non-trivial audits (a 10-commit /
    /// 8-file diff legitimately needs ~30 rounds when the model is
    /// disciplined). Drop it for tighter feedback during development;
    /// raise it for very large refactors.
    #[serde(default = "default_max_tool_rounds")]
    pub max_tool_rounds: usize,
    /// Per-call timeout for the `typecheck` substrate tool, in seconds.
    /// Audits run this first, so set high enough to cover a cold `tsc`
    /// or `cargo check` on a large repo. Default 60.
    #[serde(default = "default_typecheck_timeout_secs")]
    pub typecheck_timeout_secs: u64,
    /// Optional override for the typecheck command, as an argv array
    /// (NOT a shell string). When set, this wins over the auto-detect
    /// branches in `diagnostics::detect_typecheck_command`. Useful for
    /// pinning a specific config-aware invocation, e.g.
    /// `["pnpm", "-w", "run", "typecheck"]` in a monorepo.
    #[serde(default)]
    pub typecheck_command: Option<Vec<String>>,
    /// Per-call timeout for the `run_tests` substrate tool, in seconds.
    /// Tests are slower than typecheck on average. Default 120.
    #[serde(default = "default_test_timeout_secs")]
    pub test_timeout_secs: u64,
    /// Optional override for the test command, as an argv array (NOT a
    /// shell string). Mirrors `typecheck_command` for the test runner.
    /// Example: `["pnpm", "-w", "test", "--reporter=json"]`.
    #[serde(default)]
    pub test_command: Option<Vec<String>>,
    /// Per-call timeout for the `lsp_diagnostics` substrate tool, in
    /// seconds. LSP analysis is incremental, so this needs to be long
    /// enough for rust-analyzer / pyright / gopls to settle on a
    /// medium project. Default 30.
    #[serde(default = "default_lsp_timeout_secs")]
    pub lsp_timeout_secs: u64,
    /// Optional override for the LSP server argv (NOT a shell string).
    /// When unset, `lsp::detect_lsp_command` infers from project shape
    /// + PATH. Example: `["rust-analyzer"]`, `["pyright-langserver",
    /// "--stdio"]`, `["typescript-language-server", "--stdio"]`.
    #[serde(default)]
    pub lsp_command: Option<Vec<String>>,
    /// Per-call timeout for the `schema_inspect` substrate tool, in
    /// seconds. Inspecting an ORM's migration status hits the local
    /// project tooling (Prisma, Drizzle, Alembic, Django, Rails); it
    /// can take a while on first run when caches are cold. Default 30.
    #[serde(default = "default_schema_timeout_secs")]
    pub schema_timeout_secs: u64,
    /// Optional override for the schema-inspection command, as an argv
    /// array (NOT a shell string). When unset,
    /// `schema::detect_schema_command` infers from project shape
    /// (`prisma/schema.prisma`, `drizzle.config.ts`, `alembic.ini`,
    /// `manage.py`, `bin/rails` + `db/migrate/`). Example:
    /// `["pnpm", "exec", "prisma", "migrate", "status"]` or
    /// `["alembic", "check"]`.
    #[serde(default)]
    pub schema_command: Option<Vec<String>>,
    /// Optional allowlist of program names that `run_shell` is
    /// permitted to invoke. Matched against `argv[0]` by basename
    /// (so `/usr/bin/git` matches an entry of `"git"`). When the
    /// list is empty (the default), every `run_shell` call still
    /// hits the user-approval card; setting an allowlist makes
    /// non-matching programs hard-rejected at the substrate layer
    /// BEFORE approval is requested. Hardcoded destructive patterns
    /// (`rm -rf /`, fork bomb, `dd of=/dev/`, etc.) are rejected
    /// regardless of this setting and cannot be allowlisted.
    /// Example: `["rsync", "git", "npm", "pnpm", "yarn", "mkdir",
    /// "mv", "cp", "chmod"]`.
    #[serde(default)]
    pub run_shell_allowlist: Vec<String>,
    /// Base URL of the user's dev server, used by the `http_fetch`
    /// substrate cell when /audit and /build probe live endpoints.
    /// When unset, `diagnostics::detect_dev_server_url` infers a sensible
    /// default from the project shape (vite \u{2192} 5173, next \u{2192} 3000,
    /// django \u{2192} 8000, etc.). When detection also fails, the agent
    /// falls back to http://localhost:3000 per its system prompt.
    /// Example: "http://localhost:5173".
    #[serde(default)]
    pub dev_server_url: Option<String>,
    #[serde(default)]
    pub verifier: VerifierConfig,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            system_prompt: default_system_prompt(),
            max_context_blocks: default_max_context_blocks(),
            max_tool_rounds: default_max_tool_rounds(),
            typecheck_timeout_secs: default_typecheck_timeout_secs(),
            typecheck_command: None,
            test_timeout_secs: default_test_timeout_secs(),
            test_command: None,
            lsp_timeout_secs: default_lsp_timeout_secs(),
            lsp_command: None,
            schema_timeout_secs: default_schema_timeout_secs(),
            schema_command: None,
            run_shell_allowlist: Vec::new(),
            dev_server_url: None,
            verifier: VerifierConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifierConfig {
    #[serde(default = "default_verifier_enabled")]
    pub enabled: bool,
    #[serde(default = "default_verifier_model")]
    pub model: String,
    /// Skip review for very short responses (no value to add).
    #[serde(default = "default_verifier_min_chars")]
    pub min_chars: usize,
}

impl Default for VerifierConfig {
    fn default() -> Self {
        Self {
            enabled: default_verifier_enabled(),
            model: default_verifier_model(),
            min_chars: default_verifier_min_chars(),
        }
    }
}

fn default_verifier_enabled() -> bool {
    true
}
fn default_verifier_model() -> String {
    "anthropic/claude-haiku-4.5".into()
}
fn default_verifier_min_chars() -> usize {
    200
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub openrouter: OpenRouterConfig,
    #[serde(default)]
    pub agent: AgentConfig,
}

fn default_model() -> String {
    // Haiku is the new baseline default — Gemini Flash was pulled from the
    // auto flow for being too lazy on this project. Users can still point
    // at any slug via `/model <slug>` or by editing config.toml.
    "anthropic/claude-haiku-4.5".into()
}
fn default_base_url() -> String {
    "https://openrouter.ai/api/v1".into()
}
fn default_system_prompt() -> String {
    "You are Prism, an assistant embedded in a macOS terminal.\n\
\n\
MEMORY: You DO have memory of this conversation. You can see earlier \
user and assistant messages in the messages array you receive. When the \
user refers to something they said earlier, find it in the conversation \
and use it. Do NOT say you are 'stateless' or lack memory — that is \
incorrect here.\n\
\n\
READ TOOLS: list_directory, read_file, get_cwd. USE THEM. Strict rules:\n\
  1. NEVER ask 'which file?' or 'can you list the files?' — you have \
     list_directory; CALL IT YOURSELF. The user will not do it for you.\n\
  2. When the user mentions text they saw in the app/site/project (like \
     a heading or button label), you need to FIND that text in the code. \
     Start by list_directory(\"\"), identify likely source files, and \
     read_file on them until you locate the text.\n\
  3. For 'what does X do?' questions about code, always list_directory \
     first, then read_file on the README / package.json / entry points, \
     BEFORE answering.\n\
  4. Typical exploration chain for a web project: list_directory() → \
     read_file(\"package.json\") → read_file(\"README.md\") → \
     list_directory(\"src\") → read_file on src/app/page.tsx or \
     src/pages/index.tsx or src/index.tsx etc.\n\
  5. Only ask the user for clarification AFTER exploring and genuinely \
     failing to find what they mean.\n\
\n\
WEB SEARCH TOOL: web_search. USE IT whenever the user's question \
requires information more current than your training data \u{2014} current \
events, release dates, prices, news, pop-ups, event schedules, the \
current version of software, today's weather, who won last night's \
game, etc.\n\
\n\
When you call web_search, the response comes from Perplexity Sonar, \
which has already retrieved and grounded the information in live web \
sources. Your role for these turns is to ARRANGE and PRESENT those \
results, not to validate or paraphrase them. Think of yourself as an \
editor laying out a page, and Sonar as the reporter whose copy has \
already been fact-checked.\n\
\n\
Strict rules:\n\
  1. If the question is about external reality and you're not fully \
     confident of the answer, CALL web_search instead of saying 'I don't \
     have real-time info'. You have Sonar specifically so you don't \
     have to refuse these questions.\n\
  2. You may call web_search multiple times in a turn to refine. Start \
     broad, then narrow. Cross-reference when the first result is thin \
     or ambiguous.\n\
  3. DO NOT use web_search for questions about the user's local project, \
     files, or environment \u{2014} those go through read_file / \
     list_directory / get_cwd.\n\
  4. web_search results are AUTHORITATIVE for external facts. Quote \
     dates, years, names, locations, prices, URLs, version numbers, and \
     event titles VERBATIM from the tool response. Never 'correct' a \
     date or year from the tool result against your own training \u{2014} \
     your training is older than the tool result. If you see 'November \
     2025' in the tool result, write 'November 2025' in your answer, \
     not 'November 2024'.\n\
  5. Preserve any inline [1][2][3] citation markers Sonar emits. Do not \
     renumber, drop, or invent citations.\n\
  6. You MAY combine results from multiple searches, choose which parts \
     to include, omit tangential details, and format the final answer. \
     You MAY NOT substitute your own facts for the tool's facts.\n\
  7. If a web_search result looks internally inconsistent or clearly \
     wrong, flag it transparently to the user ('the web result said X, \
     which seems inconsistent with Y') rather than silently overwriting \
     it with what you think is correct.\n\
\n\
WRITE TOOLS: write_file, edit_file, delete_file, move_path, create_directory. Use them to make changes the user asks for. Strict rules:\n\
  1. RIGOR MANDATE: ALWAYS read the target file first with read_file (or bulk_read) before calling edit_file or delete_file. You MUST know the EXACT current contents, including whitespace and punctuation. Do NOT guess. If you attempt an edit without a prior read in this turn, your finding will be graded as 'speculative' and rejected.\n\
  2. For small targeted changes (a word, a line, a block), use edit_file. Its old_string MUST appear exactly once in the file — include surrounding context (the whole line, or a few lines) so the match is unique. If edit_file reports 0 or N>1 matches, DO NOT retry with replace_all blindly; widen old_string to be uniquely identifying. Only use replace_all=true when the user literally asked you to change every occurrence.\n\
  3. For brand-new files, use write_file. Never use write_file to change a single word in an otherwise-unchanged file — that's what edit_file is for.\n\
  4. DESTRUCTIVE ACTIONS: NEVER delete (delete_file) or move (move_path) a file until you have confirmed its contents and role in the project via read_file. Prefer moving to a backup location over deletion unless the user explicitly requested removal.\n\
  5. Writes are restricted to the shell's cwd subtree. You will see an error if you try to write elsewhere; don't loop on it.\n\
  6. After editing, TRUST the tool's result payload. Do not re-read the file just to confirm. Only re-read if a follow-up edit depends on the post-edit state.\n\
  7. Typical 'change X to Y' flow: list_directory → read_file on the likely file → edit_file with old_string = \"X\" plus enough surrounding context to be unique → done.\n\
\n\
STYLE: Prefer short, precise, copy-pasteable answers. When suggesting \
shell commands, put them in fenced code blocks so the UI can surface \
them as one-click actions. You also have access to the user's current \
working directory and recent shell commands in the context.\n\
\n\
RESPONSE SHAPE: Match the shape of your answer to the shape of the \
question. Hard rules:\n\
  1. Terse question \u{2192} terse answer. 'Show me the last 5 commits' \
     gets 5 short lines, not 5 numbered sections with summaries.\n\
  2. Do NOT add unsolicited 'Summary', 'Timeline', 'Next steps', or \
     'You can view each with ...' cheatsheet blocks. If the user \
     didn't ask for meta-commentary, don't produce any.\n\
  3. When showing git commit IDs, abbreviate to the 7-character short \
     SHA (e.g. 'baebe89') unless the user explicitly asks for full \
     hashes. Full 40-character SHAs are noise for humans.\n\
  4. When listing items, use the shortest format that carries the \
     information. Prefer 'a6d09ec  Phase 4 step 1: grep / find / ...' \
     over a numbered list with bullets, dates, and descriptions, \
     unless the user asked for detail.\n\
  5. If you used tools to get the answer, trust the tool output. Do \
     NOT re-wrap it in your own prose summary when the tool result \
     is already the answer (e.g. git_log gives you the commits; just \
     print them)."
        .into()
}
fn default_max_context_blocks() -> usize {
    5
}
/// 40 rounds is enough for an 8-file / 10-commit refactor audit when the
/// model is disciplined about grep-first / read-only-on-hit. The previous
/// 8-round cap was too tight: a single audit run regularly burned the
/// budget on bulk_read calls before reaching the findings list.
fn default_max_tool_rounds() -> usize {
    40
}
/// 60 seconds is enough for a cold `tsc --noEmit` or `cargo check` on a
/// medium repo without making fast projects feel laggy.
fn default_typecheck_timeout_secs() -> u64 {
    60
}
/// 120 seconds is enough for a typical Vitest/Jest/cargo-test suite.
/// Tests legitimately take longer than typecheck; users with very large
/// suites should raise this in config.
fn default_test_timeout_secs() -> u64 {
    120
}
/// 30 seconds is the default LSP budget. Long enough for rust-analyzer
/// or pyright to do a first analysis pass on a medium project, short
/// enough that a hung server doesn't stall the agent indefinitely.
fn default_lsp_timeout_secs() -> u64 {
    crate::lsp::DEFAULT_LSP_TIMEOUT_SECS
}
/// 30 seconds is enough for `prisma migrate status`, `drizzle-kit check`,
/// `alembic check`, `manage.py showmigrations`, or `rails
/// db:migrate:status` to run on a typical project.
fn default_schema_timeout_secs() -> u64 {
    30
}

/// Location of the config file: `$HOME/.config/prism/config.toml`.
pub fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config").join("prism").join("config.toml"))
}

/// Ensure the config directory and file exist, writing a starter template if
/// the file is missing. Returns the parsed config (defaults if parsing fails).
pub fn load_or_init() -> Config {
    let Some(path) = config_path() else {
        return Config::default();
    };

    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let template = r#"# Prism configuration.
# Get an API key at https://openrouter.ai/keys

[openrouter]
api_key = ""
default_model = "anthropic/claude-haiku-4.5"
# base_url = "https://openrouter.ai/api/v1"

[agent]
# system_prompt = "..."
# max_context_blocks = 5
"#;
        let _ = fs::write(&path, template);
        return Config::default();
    }

    match fs::read_to_string(&path) {
        Ok(contents) => toml::from_str::<Config>(&contents).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

/// Persist a partial update (model string only, for now) back to the file.
pub fn save_default_model(new_model: &str) -> std::io::Result<()> {
    let Some(path) = config_path() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no home dir",
        ));
    };
    let mut cfg = load_or_init();
    cfg.openrouter.default_model = new_model.to_string();
    let serialized = toml::to_string_pretty(&cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(path, serialized)
}

/// Tauri-managed state wrapper so we can hot-update the model at runtime.
#[derive(Default)]
pub struct ConfigState {
    inner: RwLock<Config>,
}

impl ConfigState {
    pub fn new(cfg: Config) -> Self {
        Self {
            inner: RwLock::new(cfg),
        }
    }
    pub fn snapshot(&self) -> Config {
        self.inner.read().clone()
    }
    pub fn set_default_model(&self, model: String) {
        self.inner.write().openrouter.default_model = model;
    }
    pub fn set_verifier_enabled(&self, enabled: bool) {
        self.inner.write().agent.verifier.enabled = enabled;
    }
    pub fn set_verifier_model(&self, model: String) {
        self.inner.write().agent.verifier.model = model;
    }
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub fn get_agent_config(state: tauri::State<'_, ConfigState>) -> serde_json::Value {
    let cfg = state.snapshot();
    serde_json::json!({
        "default_model": cfg.openrouter.default_model,
        "has_api_key": !cfg.openrouter.api_key.is_empty(),
        "config_path": config_path().map(|p| p.to_string_lossy().to_string()),
        "verifier_enabled": cfg.agent.verifier.enabled,
        "verifier_model": cfg.agent.verifier.model,
    })
}

#[tauri::command]
pub fn set_verifier_enabled(
    enabled: bool,
    state: tauri::State<'_, ConfigState>,
) -> Result<(), String> {
    state.set_verifier_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn set_verifier_model(
    model: String,
    state: tauri::State<'_, ConfigState>,
) -> Result<(), String> {
    state.set_verifier_model(model);
    Ok(())
}

#[tauri::command]
pub fn set_agent_model(
    model: String,
    state: tauri::State<'_, ConfigState>,
) -> Result<(), String> {
    save_default_model(&model).map_err(|e| e.to_string())?;
    state.set_default_model(model);
    Ok(())
}
