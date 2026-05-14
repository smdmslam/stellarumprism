import { invoke } from "@tauri-apps/api/core";

export interface HabitRule {
  id: string;
  title: string;
  rule: string;
  source: string; // "manual" | "discovered"
  timestamp: string;
}

export class HabitsManager {
  async getHabits(): Promise<HabitRule[]> {
    try {
      return await invoke<HabitRule[]>("get_habits");
    } catch (e) {
      console.error("Failed to fetch habits", e);
      return [];
    }
  }

  async rememberHabit(title: string, rule: string, source: string): Promise<HabitRule | null> {
    try {
      return await invoke<HabitRule>("remember_habit", { title, rule, source });
    } catch (e) {
      console.error("Failed to remember habit", e);
      return null;
    }
  }

  async deleteHabit(id: string): Promise<boolean> {
    try {
      await invoke("delete_habit", { id });
      return true;
    } catch (e) {
      console.error("Failed to delete habit", e);
      return false;
    }
  }

  async getHabitsPromptBlock(): Promise<string> {
    const habits = await this.getHabits();
    if (habits.length === 0) return "";

    let block = "## User Preferences & Habits (CRITICAL: Always adhere to these workflow rules)\n\n";
    for (const h of habits) {
      block += `- **${h.title}**: ${h.rule}\n`;
    }
    return block;
  }
}

export const habitsManager = new HabitsManager();
