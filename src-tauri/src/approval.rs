//! Approval registry + Tauri commands for gating write/edit tool calls on
//! explicit user consent.
//!
//! Flow:
//!   1. The tool loop in `agent.rs` encounters a call to `write_file` /
//!      `edit_file` (see `tools::requires_approval`).
//!   2. It calls `ApprovalState::register(call_id)` to get a oneshot
//!      receiver, then emits `agent-tool-approval-<request_id>` with a
//!      human-readable preview of the pending write.
//!   3. The frontend renders an approval card. User clicks a button,
//!      which invokes `agent_tool_decision(call_id, decision)`.
//!   4. That command looks up the sender and fires the decision.
//!   5. The tool loop's `tokio::select!` wakes up and either executes
//!      the tool (approve / approve-session) or fabricates a
//!      user-rejected tool result.
//!
//! "Approve for session" latches a per-chat flag so subsequent write
//! tools in the same tab don't prompt. Cleared on `agent_new_session`.

use std::sync::Arc;

use dashmap::DashMap;
use tauri::State;
use tokio::sync::oneshot;

/// The three outcomes of an approval decision. `ApproveSession` means
/// "approve this call AND auto-approve every future write in this chat".
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ApprovalDecision {
    Approve,
    ApproveSession,
    Reject,
}

/// Tauri-managed state. Holds pending oneshot senders keyed by call_id
/// and a per-chat "approve all this session" latch.
#[derive(Default)]
pub struct ApprovalState {
    pub(crate) pending: Arc<DashMap<String, oneshot::Sender<ApprovalDecision>>>,
    pub(crate) session_allowed: Arc<DashMap<String, bool>>,
}

// Public helpers. The tool loop in agent.rs currently touches the Arc
// fields directly to keep the select! ergonomic, so these aren't on the
// hot path — they're here as a supported external API.
#[allow(dead_code)]
impl ApprovalState {
    /// Register a new pending approval. Returns the receiver the tool
    /// loop awaits on. If the request is cancelled before a decision,
    /// callers should invoke `cancel()` to clean up the map entry.
    pub fn register(&self, call_id: &str) -> oneshot::Receiver<ApprovalDecision> {
        let (tx, rx) = oneshot::channel();
        self.pending.insert(call_id.to_string(), tx);
        rx
    }

    /// Remove a pending approval entry without firing. Used on cancel.
    pub fn cancel(&self, call_id: &str) {
        self.pending.remove(call_id);
    }

    pub fn is_session_allowed(&self, chat_id: &str) -> bool {
        self.session_allowed.get(chat_id).map_or(false, |v| *v)
    }

    pub fn allow_session(&self, chat_id: &str) {
        self.session_allowed.insert(chat_id.to_string(), true);
    }

    pub fn clear_session(&self, chat_id: &str) {
        self.session_allowed.remove(chat_id);
    }
}

/// Frontend-driven decision. `decision` is one of "approve",
/// "approve-session", "reject". Returns Ok even if there's no pending
/// entry (stale click), since that's user error, not a fault.
#[tauri::command]
pub fn agent_tool_decision(
    state: State<'_, ApprovalState>,
    call_id: String,
    decision: String,
) -> Result<(), String> {
    let d = match decision.as_str() {
        "approve" => ApprovalDecision::Approve,
        "approve-session" => ApprovalDecision::ApproveSession,
        "reject" => ApprovalDecision::Reject,
        other => return Err(format!("unknown decision: {}", other)),
    };
    if let Some((_, tx)) = state.pending.remove(&call_id) {
        // Send may fail if the receiver was already dropped (request
        // cancelled mid-approval). That's fine — we've done our part.
        let _ = tx.send(d);
    }
    Ok(())
}

/// Manually drop the session-allow latch for a chat. Invoked by the
/// frontend when the user wants to re-enable approval prompts without
/// starting a new session.
#[tauri::command]
pub fn agent_clear_session_approval(state: State<'_, ApprovalState>, chat_id: String) {
    state.clear_session(&chat_id);
}
