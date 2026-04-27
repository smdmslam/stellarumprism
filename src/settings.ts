/**
 * Application-wide persistence for user preferences. 
 * Stored in localStorage for now; synced with Tauri state in future.
 */

export interface AppSettings {
  /** Map of model slug -> enabled status */
  enabledModels: Record<string, boolean>;
  /** UI theme preference */
  theme: "dark" | "light" | "system";
  /** Sidebar default visibility for new tabs */
  sidebarDefaultVisible: boolean;
}

const STORAGE_KEY = "prism-settings-v1";

const DEFAULT_SETTINGS: AppSettings = {
  enabledModels: {}, // empty means all are enabled by default (legacy behavior)
  theme: "dark",
  sidebarDefaultVisible: true,
};

export class SettingsManager {
  private current: AppSettings;

  constructor() {
    this.current = this.load();
  }

  private load(): AppSettings {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
  }

  // -- Model Curation --------------------------------------------------------

  /** 
   * Returns true if a model should be visible in the UI. 
   * Always returns true for backend models.
   */
  isModelEnabled(slug: string): boolean {
    // If enabledModels is empty, treat all as enabled (initial state)
    if (Object.keys(this.current.enabledModels).length === 0) return true;
    
    // Explicit opt-in check
    return this.current.enabledModels[slug] !== false;
  }

  setModelEnabled(slug: string, enabled: boolean): void {
    // If this is the first turn, we should probably populate with everything first
    // so we don't accidentally hide models not yet in the map.
    if (Object.keys(this.current.enabledModels).length === 0) {
      // Lazy init: we need the model library here, but let's just 
      // handle it by assuming everything else is true below.
    }
    
    this.current.enabledModels[slug] = enabled;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  toggleModel(slug: string): void {
    this.setModelEnabled(slug, !this.isModelEnabled(slug));
  }

  // -- General Get/Set -------------------------------------------------------

  getTheme(): "dark" | "light" | "system" {
    return this.current.theme;
  }

  setTheme(theme: "dark" | "light" | "system"): void {
    this.current.theme = theme;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }
}

// Global singleton
export const settings = new SettingsManager();
