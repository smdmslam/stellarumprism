//! Backend storage and Tauri state management for user habits & learning rules.
//! Persisted to `~/.config/prism/habits.json`.

use chrono;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HabitRule {
    pub id: String,
    pub title: String,
    pub rule: String,
    pub source: String, // "manual" | "discovered"
    pub timestamp: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HabitsStore {
    #[serde(default)]
    pub habits: Vec<HabitRule>,
}

/// Location of the habits file: `$HOME/.config/prism/habits.json`.
pub fn habits_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config").join("prism").join("habits.json"))
}

pub fn load_or_init() -> HabitsStore {
    let Some(path) = habits_path() else {
        return HabitsStore::default();
    };

    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let store = HabitsStore::default();
        if let Ok(serialized) = serde_json::to_string_pretty(&store) {
            let _ = fs::write(&path, serialized);
        }
        return store;
    }

    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HabitsStore::default(),
    }
}

pub fn save_store(store: &HabitsStore) -> Result<(), String> {
    let Some(path) = habits_path() else {
        return Err("no home dir".into());
    };
    let serialized = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(path, serialized).map_err(|e| e.to_string())
}

pub struct HabitsState {
    inner: RwLock<HabitsStore>,
}

impl HabitsState {
    pub fn new(store: HabitsStore) -> Self {
        Self {
            inner: RwLock::new(store),
        }
    }

    pub fn snapshot(&self) -> Vec<HabitRule> {
        self.inner.read().habits.clone()
    }

    pub fn remember_habit(
        &self,
        title: String,
        rule: String,
        source: String,
    ) -> Result<HabitRule, String> {
        let mut inner = self.inner.write();
        let id = format!("h-{}", Uuid::new_v4().simple());
        let habit = HabitRule {
            id,
            title,
            rule,
            source,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        inner.habits.push(habit.clone());
        save_store(&inner)?;
        Ok(habit)
    }

    pub fn delete_habit(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.write();
        let len_before = inner.habits.len();
        inner.habits.retain(|h| h.id != id);
        if inner.habits.len() != len_before {
            save_store(&inner)?;
        }
        Ok(())
    }
}

#[tauri::command]
pub fn get_habits(state: tauri::State<'_, HabitsState>) -> Result<Vec<HabitRule>, String> {
    Ok(state.snapshot())
}

#[tauri::command]
pub fn remember_habit(
    title: String,
    rule: String,
    source: String,
    state: tauri::State<'_, HabitsState>,
) -> Result<HabitRule, String> {
    state.remember_habit(title, rule, source)
}

#[tauri::command]
pub fn delete_habit(id: String, state: tauri::State<'_, HabitsState>) -> Result<(), String> {
    state.delete_habit(&id)
}
