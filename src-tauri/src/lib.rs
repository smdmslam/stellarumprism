// The `tool_schema()` literal in tools.rs is a single `json!` macro
// invocation that crossed the default 128-token expansion budget when
// the eighth tool (run_shell, substrate v8) was added. Bumping to 256
// gives the schema room to grow without forcing us to fragment the
// literal across helper functions.
#![recursion_limit = "256"]

mod agent;
mod approval;
mod config;
// Substrate cells are exposed at the crate root so the `prism-audit`
// CLI binary (and any future Rust consumer) can call them directly
// without going through the Tauri command surface.
pub mod diagnostics;
mod e2e;
mod file_ref;
pub mod lsp;
mod pty;
mod load_chat;
mod save_chat;
mod recipes;
pub mod run_shell;
pub mod schema;
mod second_pass;
mod session;
mod shell_integration;
mod tools;
mod workspace_state;

use agent::{
    agent_cancel, agent_drop_session, agent_get_history, agent_get_history_full,
    agent_get_session_info, agent_new_session, agent_query, AgentState, SessionState,
};
use approval::{agent_clear_session_approval, agent_tool_decision, ApprovalState};
use file_ref::{
    create_dir, list_dir_entries, list_directory_tree, move_file, read_file_scoped,
    read_file_snippet, read_file_text, remove_file, resolve_home_path, write_file_text,
};
use load_chat::load_chat_markdown;
use save_chat::save_chat_markdown;
use recipes::{run_pnpm_script, write_recipe_report};
use second_pass::{read_latest_audit_report, write_audit_report};
use session::{read_session_state, write_session_state};
use workspace_state::{
    read_latest_build_report, read_workspace_state, write_build_report, write_workspace_state,
};
use config::{
    get_agent_config, load_or_init, set_agent_model, set_verifier_enabled, set_verifier_model,
    ConfigState,
};
use pty::{kill_shell, resize_shell, spawn_shell, write_to_shell, PtyState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Ensure config file exists; load whatever's there (falls back to defaults).
    let cfg = load_or_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .manage(ConfigState::new(cfg))
        .manage(AgentState::default())
        .manage(SessionState::default())
        .manage(ApprovalState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_shell,
            write_to_shell,
            resize_shell,
            kill_shell,
            agent_query,
            agent_cancel,
            agent_new_session,
            agent_drop_session,
            agent_get_session_info,
            agent_get_history,
            agent_get_history_full,
            agent_tool_decision,
            agent_clear_session_approval,
            get_agent_config,
            set_agent_model,
            set_verifier_enabled,
            set_verifier_model,
            save_chat_markdown,
            load_chat_markdown,
            write_audit_report,
            read_latest_audit_report,
            read_workspace_state,
            write_workspace_state,
            write_build_report,
            read_latest_build_report,
            read_file_scoped,
            read_file_snippet,
            read_file_text,
            write_file_text,
            list_dir_entries,
            list_directory_tree,
            create_dir,
            move_file,
            remove_file,
            resolve_home_path,
            read_session_state,
            write_session_state,
            run_pnpm_script,
            write_recipe_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
