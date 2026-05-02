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
    pub balance_usd: f64, // Remaining credit balance (purchased amount)
    pub total_real_cost_usd: f64, // Lifetime actual AI cost
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub expires_at: Option<u64>,
}

impl Default for SubscriptionState {
    fn default() -> Self {
        Self {
            tier: SubscriptionTier::Free,
            balance_usd: 1.0, // $1.00 starter credit for new users
            total_real_cost_usd: 0.0,
            stripe_customer_id: None,
            stripe_subscription_id: None,
            expires_at: None,
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
    let mut state = load_subscription();
    state.tier = SubscriptionTier::Pro;
    // When upgrading to Pro, we could give them a larger starting balance
    // or set a flag. For now, let's just bump the balance by $30.
    state.balance_usd += 30.0;
    save_subscription(&state).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn deduct_usage_cost(actual_cost_usd: f64) -> Result<()> {
    let mut state = load_subscription();
    let credit_cost = actual_cost_usd * 20.0;
    
    if state.tier == SubscriptionTier::Free && state.balance_usd < credit_cost {
        state.balance_usd = 0.0; // Zero it out
        save_subscription(&state)?;
        return Err(anyhow::anyhow!("Insufficient credit balance. Usage cost exceeded remaining credits."));
    }

    state.balance_usd -= credit_cost;
    state.total_real_cost_usd += actual_cost_usd;
    save_subscription(&state)?;
    Ok(())
}
