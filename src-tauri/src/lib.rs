mod agent;
mod approval;
mod config;
mod file_ref;
mod pty;
mod save_chat;
mod shell_integration;
mod tools;

use agent::{
    agent_cancel, agent_drop_session, agent_get_history, agent_get_session_info,
    agent_new_session, agent_query, AgentState, SessionState,
};
use approval::{agent_clear_session_approval, agent_tool_decision, ApprovalState};
use file_ref::{list_dir_entries, read_file_scoped};
use save_chat::save_chat_markdown;
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
            agent_tool_decision,
            agent_clear_session_approval,
            get_agent_config,
            set_agent_model,
            set_verifier_enabled,
            set_verifier_model,
            save_chat_markdown,
            read_file_scoped,
            list_dir_entries,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
