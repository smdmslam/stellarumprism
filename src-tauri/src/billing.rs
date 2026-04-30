use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use anyhow::Result;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SubscriptionTier {
    Free,
    Pro,
    Enterprise,
}

impl Default for SubscriptionTier {
    fn default() -> Self {
        SubscriptionTier::Free
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionState {
    pub tier: SubscriptionTier,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub expires_at: Option<u64>, // Unix timestamp
    pub daily_token_quota: Option<u64>,
}

impl Default for SubscriptionState {
    fn default() -> Self {
        Self {
            tier: SubscriptionTier::Free,
            stripe_customer_id: None,
            stripe_subscription_id: None,
            expires_at: None,
            daily_token_quota: Some(500_000), // Default free quota
        }
    }
}

pub fn get_subscription_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let mut p = PathBuf::from(home);
    p.push(".local/share/prism/subscription.json");
    p
}

pub fn load_subscription() -> SubscriptionState {
    let path = get_subscription_path();
    if !path.exists() {
        return SubscriptionState::default();
    }
    let content = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&content).unwrap_or_else(|_| SubscriptionState::default())
}

pub fn save_subscription(state: &SubscriptionState) -> Result<()> {
    let path = get_subscription_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(state)?;
    fs::write(path, content)?;
    Ok(())
}

#[tauri::command]
pub async fn get_subscription_info() -> Result<SubscriptionState, String> {
    Ok(load_subscription())
}

#[tauri::command]
pub async fn upgrade_to_pro() -> Result<(), String> {
    // This is a placeholder for actual Stripe integration.
    // In a real app, this would return a checkout URL.
    let mut state = load_subscription();
    state.tier = SubscriptionTier::Pro;
    state.daily_token_quota = None; // Unlimited for Pro
    save_subscription(&state).map_err(|e| e.to_string())?;
    Ok(())
}
