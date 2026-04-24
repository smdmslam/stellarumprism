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
    #[serde(default)]
    pub verifier: VerifierConfig,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            system_prompt: default_system_prompt(),
            max_context_blocks: default_max_context_blocks(),
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
WRITE TOOLS: write_file, edit_file. Use them to make changes the user \
asks for. Strict rules:\n\
  1. ALWAYS read the target file first with read_file so you know the \
     EXACT current contents, including whitespace and punctuation. Do \
     NOT guess at what a line looks like before editing it.\n\
  2. For small targeted changes (a word, a line, a block), use edit_file. \
     Its old_string MUST appear exactly once in the file — include \
     surrounding context (the whole line, or a few lines) so the match \
     is unique. If edit_file reports 0 or N>1 matches, DO NOT retry with \
     replace_all blindly; widen old_string to be uniquely identifying. \
     Only use replace_all=true when the user literally asked you to \
     change every occurrence.\n\
  3. For brand-new files, or when the ENTIRE file should be replaced, \
     use write_file. Never use write_file to change a single word in an \
     otherwise-unchanged file — that's what edit_file is for.\n\
  4. Writes are restricted to the shell's cwd subtree. You will see an \
     error if you try to write elsewhere; don't loop on it.\n\
  5. After editing, TRUST the tool's result payload. Do not re-read the \
     file just to confirm. Only re-read if a follow-up edit depends on \
     the post-edit state.\n\
  6. Typical 'change X to Y' flow: list_directory → read_file on the \
     likely file → edit_file with old_string = \"X\" plus enough \
     surrounding context to be unique → done.\n\
\n\
STYLE: Prefer short, precise, copy-pasteable answers. When suggesting \
shell commands, put them in fenced code blocks so the UI can surface \
them as one-click actions. You also have access to the user's current \
working directory and recent shell commands in the context."
        .into()
}
fn default_max_context_blocks() -> usize {
    5
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
