/**
 * Application-wide persistence for user preferences. 
 * Stored in localStorage for now; synced with Tauri state in future.
 */

/**
 * A user-defined virtual skill grouping. Unlike filesystem families
 * (subdirectories under `.prism/skills/`), saved-search groups are
 * defined by a search term \u2014 the group's contents are *whatever
 * matches the term right now*. Adding a new skill that matches the
 * term auto-joins the group; renaming or moving a skill that no
 * longer matches auto-leaves it. The grouping is logical, not
 * physical.
 *
 * Toggle semantics: when `enabled` is true, every skill currently
 * matching the term is treated as included in agent context
 * (OR-composition with individual skill toggles). When false, the
 * group has no effect; individual skill toggles are unchanged.
 */
export interface SavedSearchGroup {
  /** Stable identifier; generated at create time, never reused. */
  id: string;
  /** Display name for the group (e.g. "vc"). User-chosen, may differ
   *  from the search term itself. */
  name: string;
  /** Search term that defines the group's contents. Same syntax the
   *  Skills search bar uses (single word, multi-word AND, "exact"
   *  with quotes). */
  searchTerm: string;
  /** Whether the group is currently included in agent context. */
  enabled: boolean;
}

export interface AppSettings {
  /** Map of model slug -> enabled status */
  enabledModels: Record<string, boolean>;
  /** Map of skill path -> enabled status */
  enabledSkills: Record<string, boolean>;
  /** Saved virtual skill groupings (search-defined, not filesystem). */
  savedSearchGroups: SavedSearchGroup[];
  enabledSkillFolders: Record<string, boolean>;
  /** UI theme preference */
  theme: "dark" | "light" | "system";
  /** Sidebar default visibility for new tabs */
  sidebarDefaultVisible: boolean;
  /** Terminal font size */
  terminalFontSize: number;
  /** Editor font size */
  editorFontSize: number;
  /** Agent / Chat font size */
  chatFontSize: number;
  /** Verification mode: true = Always Verify, false = Auto Verify. */
  strictMode: boolean;
}

const STORAGE_KEY = "prism-settings-v1";

const DEFAULT_SETTINGS: AppSettings = {
  enabledModels: {}, // empty means all are enabled by default (legacy behavior)
  enabledSkills: {},
  enabledSkillFolders: {},
  savedSearchGroups: [],
  theme: "dark",
  sidebarDefaultVisible: true,
  terminalFontSize: 9,
  editorFontSize: 12,
  chatFontSize: 13,
  strictMode: true,
};

export class SettingsManager {
  private current: AppSettings;

  constructor() {
    this.current = this.load();
    this.applyCssVariables();
  }

  private load(): AppSettings {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode / blocked storage (some WebViews) — don't abort the bundle.
      return { ...DEFAULT_SETTINGS };
    }
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      /* ignore — prefs won't persist this session */
    }
    this.applyCssVariables();
  }

  private applyCssVariables(): void {
    const root = document.documentElement;
    root.style.setProperty("--editor-font-size", `${this.getEditorFontSize()}px`);
    root.style.setProperty("--chat-font-size", `${this.getChatFontSize()}px`);
  }

  // -- Model Curation --------------------------------------------------------

  /**
   * Returns true if a model should be visible in the UI.
   *
   * Two-layer resolution:
   *   1. If the user has explicitly toggled this slug in settings,
   *      that override wins (true OR false).
   *   2. Otherwise, fall back to `registryDefault` \u2014 the visibility
   *      shipped with `ModelEntry.enabled` in `models.ts`.
   *
   * Callers MUST pass `registryDefault` so the registry's intent
   * survives a localStorage clear (or a fresh install). Defaulting
   * to `true` here is for ad-hoc callers that don't know the
   * registry value; the production paths (router, picker, settings
   * UI) all pass `m.enabled !== false`.
   */
  isModelEnabled(slug: string, registryDefault = true): boolean {
    const override = this.current.enabledModels[slug];
    if (override === undefined) return registryDefault;
    return override;
  }

  setModelEnabled(slug: string, enabled: boolean): void {
    this.current.enabledModels[slug] = enabled;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  toggleModel(slug: string): void {
    this.setModelEnabled(slug, !this.isModelEnabled(slug));
  }

  /**
   * Bulk-set every slug in `slugs` to the same enabled state. One
   * `prism-settings-changed` event fires (rather than N), and one
   * localStorage write happens, so callers wiring a master
   * "all on / all off" UI toggle don't pay the cost of N
   * single-slug writes. Mirrors `setFamilyEnabled` for skills.
   */
  setAllModelsEnabled(slugs: string[], enabled: boolean): void {
    for (const slug of slugs) {
      this.current.enabledModels[slug] = enabled;
    }
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  // -- Skill Library ---------------------------------------------------------

  isSkillEnabled(path: string): boolean {
    return !!this.current.enabledSkills[path];
  }

  setSkillEnabled(path: string, enabled: boolean): void {
    this.current.enabledSkills[path] = enabled;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  setFamilyEnabled(paths: string[], enabled: boolean): void {
    for (const p of paths) {
      this.current.enabledSkills[p] = enabled;
    }
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  isSkillFolderEnabled(folder: string): boolean {
    const override = this.current.enabledSkillFolders[folder];
    if (override === undefined) return true; // Enabled by default
    return override;
  }

  setSkillFolderEnabled(folder: string, enabled: boolean): void {
    this.current.enabledSkillFolders[folder] = enabled;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  // -- Saved-search skill groups ---------------------------------------------

  /** Snapshot of all saved groups in display order. The returned array
   *  is a copy so callers can iterate without worrying about mutation
   *  during a render pass. */
  getSavedGroups(): SavedSearchGroup[] {
    return this.current.savedSearchGroups.map((g) => ({ ...g }));
  }

  /**
   * Persist a new saved-search group. Returns the created group so the
   * UI can highlight / scroll-to it after creation. Both `name` and
   * `searchTerm` are trimmed; an empty searchTerm is rejected at the
   * UI layer (the `+ Group` button is disabled when the search bar is
   * empty), but we double-check here so a programmatic caller can't
   * persist a non-functional group.
   */
  addSavedGroup(name: string, searchTerm: string): SavedSearchGroup | null {
    const trimmedName = name.trim();
    const trimmedTerm = searchTerm.trim();
    if (trimmedName.length === 0 || trimmedTerm.length === 0) return null;
    const group: SavedSearchGroup = {
      // Crypto.randomUUID is widely available in modern browsers; the
      // fallback uses a timestamp + random tail so two groups created
      // in the same millisecond still get distinct ids.
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      searchTerm: trimmedTerm,
      enabled: true,
    };
    this.current.savedSearchGroups.push(group);
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
    return { ...group };
  }

  /** Delete a saved group by id. Silently no-ops on unknown ids so
   *  callers don't have to defend against double-delete races. */
  removeSavedGroup(id: string): void {
    const before = this.current.savedSearchGroups.length;
    this.current.savedSearchGroups = this.current.savedSearchGroups.filter(
      (g) => g.id !== id,
    );
    if (this.current.savedSearchGroups.length === before) return;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  /** Toggle a saved group's enabled flag. Unknown id = silent no-op. */
  setSavedGroupEnabled(id: string, enabled: boolean): void {
    const group = this.current.savedSearchGroups.find((g) => g.id === id);
    if (!group) return;
    if (group.enabled === enabled) return;
    group.enabled = enabled;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
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

  getTerminalFontSize(): number {
    return this.current.terminalFontSize ?? 9;
  }

  setTerminalFontSize(size: number): void {
    this.current.terminalFontSize = size;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  getEditorFontSize(): number {
    return this.current.editorFontSize ?? 12;
  }

  setEditorFontSize(size: number): void {
    this.current.editorFontSize = size;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  getChatFontSize(): number {
    return this.current.chatFontSize ?? 13;
  }

  setChatFontSize(size: number): void {
    this.current.chatFontSize = size;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }

  getStrictMode(): boolean {
    return this.current.strictMode ?? true;
  }

  setStrictMode(enabled: boolean): void {
    if (this.current.strictMode === enabled) return;
    this.current.strictMode = enabled;
    this.save();
    window.dispatchEvent(new CustomEvent("prism-settings-changed"));
  }
}

// Global singleton
export const settings = new SettingsManager();
