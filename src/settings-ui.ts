/**
 * UI Controller for the Settings Overlay.
 */

import { settings } from "./settings";
import { MODEL_LIBRARY, compareModelsByCostDesc } from "./models";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Workspace } from "./workspace";

/**
 * Escape user / filesystem-derived strings before interpolating into
 * innerHTML. Most content here is registry-static (model descriptions)
 * or filesystem paths the user themselves owns, so this isn't an XSS
 * surface today \u2014 but a quoted character in a chat filename would
 * silently break the load button's data-path attribute, and a future
 * \"custom model from config\" feature would land here as a real
 * vector. Cheap insurance.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type SkillFileEntry = {
  name: string;
  slug: string;
  sizeBytes: number;
  description: string;
};

const SKILLS_SEARCH_DEBOUNCE_MS = 250;

function filterSkillFamilies(
  families: Record<string, SkillFileEntry[]>,
  rawQuery: string,
): Array<{ familyName: string; files: SkillFileEntry[] }> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return Object.entries(families).map(([familyName, files]) => ({ familyName, files }));
  }

  const isExactMode = query.length >= 2 && query.startsWith('"') && query.endsWith('"');
  const normalizedQuery = isExactMode ? query.slice(1, -1).trim() : query;
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  const useAllWords = words.length > 1;

  return Object.entries(families)
    .map(([familyName, files]) => {
      const filteredFiles = files.filter((file) => {
        const haystack = `${file.name} ${familyName}`.toLowerCase();
        if (isExactMode) return haystack.includes(normalizedQuery);
        if (useAllWords) return words.every((word) => haystack.includes(word));
        return normalizedQuery.length > 0 && haystack.includes(normalizedQuery);
      });
      return { familyName, files: filteredFiles };
    })
    .filter((group) => group.files.length > 0);
}

export class SettingsUI {
  private readonly overlay: HTMLElement;
  private readonly content: HTMLElement;
  /** False when settings HTML nodes were missing at startup. */
  private readonly overlayMounted: boolean;
  private currentTab = "general";
  private activeWorkspace: Workspace | null = null;

  constructor() {
    const overlay = document.getElementById("settings-overlay");
    const content = document.getElementById("settings-content");
    if (!overlay || !content) {
      console.error(
        "Prism: settings-overlay or settings-content missing — settings disabled",
      );
      this.overlay = document.createElement("div");
      this.content = document.createElement("div");
      this.overlayMounted = false;
      return;
    }
    this.overlay = overlay;
    this.content = content;
    this.overlayMounted = true;
    this.wireEvents();
  }

  public open(activeWs: Workspace | null = null): void {
    if (!this.overlayMounted) return;
    this.activeWorkspace = activeWs;
    this.overlay.setAttribute("aria-hidden", "false");
    this.render();
  }

  public close(): void {
    if (!this.overlayMounted) return;
    this.overlay.setAttribute("aria-hidden", "true");
  }

  private wireEvents(): void {
    // Close button
    document.getElementById("settings-close")?.addEventListener("click", () => this.close());

    // Navigation
    const navItems = this.overlay.querySelectorAll<HTMLElement>(".settings-nav-item");
    navItems.forEach(item => {
      item.addEventListener("click", () => {
        const tab = item.dataset.tab!;
        this.switchTab(tab);
      });
    });

    // Close on background click
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Close on Escape
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.overlay.getAttribute("aria-hidden") === "false") {
        this.close();
      }
    });
  }

  private async switchTab(tab: string): Promise<void> {
    this.currentTab = tab;
    const items = this.overlay.querySelectorAll(".settings-nav-item");
    items.forEach(i => i.classList.toggle("active", (i as HTMLElement).dataset.tab === tab));
    await this.render();
  }

  private async render(): Promise<void> {
    switch (this.currentTab) {
      case "general":
        this.renderGeneral();
        break;
      case "models":
        this.renderModels();
        break;
      case "skills":
        this.renderSkills();
        break;
      case "history":
        await this.renderHistory();
        break;
      case "usage":
        await this.renderUsage();
        break;
      case "substrate":
        this.renderSubstrate();
        break;
      case "about":
        this.renderAbout();
        break;
    }
  }

  private renderGeneral(): void {
    // Appearance / Theme selector is intentionally hidden until light
    // mode is supported. The `theme` field on AppSettings (and its
    // getter/setter in settings.ts) is preserved so localStorage
    // entries from older versions still parse cleanly.
    this.content.innerHTML = `
      <h2 class="settings-section-title">General Settings</h2>
      <div class="settings-group">
        <label class="settings-group-title">Always Verify / Auto Verify</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 12px;">
          Always Verify is on by default. Turn off to use <strong>Auto Verify</strong> for lower latency while keeping factual prompts grounded.
        </p>
        <div class="model-setting-card">
          <div class="model-setting-info">
            <div class="model-setting-name">Always Verify</div>
            <div class="model-setting-desc">
              <strong>Always Verify</strong> adds an independent background model to fact-check every response for maximum reliability.
              <div style="margin-top: 4px;">
                <strong>Auto Verify</strong> relies on Prism's structural rigor checks and triggered protocols for faster, grounded performance.
              </div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span id="strict-mode-status" style="font-size: 10px; font-weight: 800; color: ${settings.getStrictMode() ? "var(--prism-emerald)" : "var(--prism-cyan)"}; text-transform: uppercase; width: 48px; text-align: right;">
              ${settings.getStrictMode() ? "ALWAYS" : "AUTO"}
            </span>
            <label class="prism-toggle">
              <input type="checkbox" id="setting-strict-mode" ${settings.getStrictMode() ? "checked" : ""}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <label class="settings-group-title">Default Input Mode</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 12px;">
          Select the default input mode when starting a fresh workspace session or tab.
        </p>
        <div class="model-setting-card" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;">
          <div class="model-setting-info">
            <div class="model-setting-name">Default Mode</div>
            <div class="model-setting-desc">
              Choose whether the input editor defaults to <strong>AGENT (Ask / Natural Language)</strong> or <strong>CMD (Terminal Command)</strong>.
            </div>
          </div>
          <select id="setting-default-prompt-mode" style="background: #111827; border: 1px solid #374151; color: #e5e7eb; border-radius: 6px; padding: 6px 12px; font-size: 11px; font-weight: 600; outline: none; cursor: pointer; height: 32px; box-sizing: border-box;">
            <option value="agent" ${settings.getDefaultPromptMode() === "agent" ? "selected" : ""}>AGENT (Ask)</option>
            <option value="command" ${settings.getDefaultPromptMode() === "command" ? "selected" : ""}>CMD (Terminal)</option>
          </select>
        </div>
      </div>

      <div class="settings-group">
        <label class="settings-group-title">Editor Configuration</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 12px;">
          Controls for the CodeMirror editor core.
        </p>
        <div style="color: #4b5563; font-size: 12px; font-style: italic;">
          More controls coming soon (Tab behavior, Indent guides).
        </div>
      </div>

      <div class="settings-group">
        <label class="settings-group-title">Typography & Scale</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 16px;">
          Adjust the font size of various working areas independently.
        </p>
        
        <div class="font-size-control" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <label style="font-size: 12px; color: #d1d5db;">Terminal</label>
          <input type="number" id="setting-fontSize-terminal" value="${settings.getTerminalFontSize()}" min="6" max="24" style="width: 60px; background: #111827; border: 1px solid #374151; color: #e5e7eb; border-radius: 4px; padding: 4px 8px; font-size: 12px; outline: none;">
        </div>
        
        <div class="font-size-control" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <label style="font-size: 12px; color: #d1d5db;">Editor</label>
          <input type="number" id="setting-fontSize-editor" value="${settings.getEditorFontSize()}" min="8" max="32" style="width: 60px; background: #111827; border: 1px solid #374151; color: #e5e7eb; border-radius: 4px; padding: 4px 8px; font-size: 12px; outline: none;">
        </div>

        <div class="font-size-control" style="display: flex; align-items: center; justify-content: space-between;">
          <label style="font-size: 12px; color: #d1d5db;">Chat & Prose</label>
          <input type="number" id="setting-fontSize-chat" value="${settings.getChatFontSize()}" min="9" max="32" style="width: 60px; background: #111827; border: 1px solid #374151; color: #e5e7eb; border-radius: 4px; padding: 4px 8px; font-size: 12px; outline: none;">
        </div>
      </div>
    `;

    // Wire font size inputs
    const termInput = document.getElementById("setting-fontSize-terminal") as HTMLInputElement;
    const editorInput = document.getElementById("setting-fontSize-editor") as HTMLInputElement;
    const chatInput = document.getElementById("setting-fontSize-chat") as HTMLInputElement;
    const strictInput = document.getElementById("setting-strict-mode") as HTMLInputElement;

    const handleNumberChange = (input: HTMLInputElement, setter: (val: number) => void) => {
      input.addEventListener("change", () => {
        const val = parseInt(input.value, 10);
        if (!isNaN(val)) setter(val);
      });
    };

    if (termInput) handleNumberChange(termInput, v => settings.setTerminalFontSize(v));
    if (editorInput) handleNumberChange(editorInput, v => settings.setEditorFontSize(v));
    if (chatInput) handleNumberChange(chatInput, v => settings.setChatFontSize(v));
    strictInput?.addEventListener("change", () => {
      const isChecked = strictInput.checked;
      settings.setStrictMode(isChecked);
      const statusEl = document.getElementById("strict-mode-status");
      if (statusEl) {
        statusEl.textContent = isChecked ? "ALWAYS" : "AUTO";
        statusEl.style.color = isChecked ? "var(--prism-emerald)" : "var(--prism-cyan)";
      }
    });

    const promptModeSelect = document.getElementById("setting-default-prompt-mode") as HTMLSelectElement;
    promptModeSelect?.addEventListener("change", () => {
      const mode = promptModeSelect.value as "agent" | "command";
      settings.setDefaultPromptMode(mode);
    });
  }

  private renderModels(): void {
    const models = MODEL_LIBRARY
      .filter(m => m.tier !== "backend")
      .slice()
      .sort(compareModelsByCostDesc);
    // Aggregate state for the master toggle: ON only when every model
    // is currently enabled. A mixed state (some on, some off) reads as
    // OFF \u2014 clicking flips everything to ON. Clicking again from a
    // fully-on state turns everything OFF. Simpler than a tristate.
    const allEnabled =
      models.length > 0 &&
      models.every(m => settings.isModelEnabled(m.slug, m.enabled !== false));

    let html = `
      <h2 class="settings-section-title">AI Model Curation</h2>
      <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 16px;">
        Toggle models to enable/disable them in the global command bar. Disabling poor-performing models streamlines your workflow.
      </p>
      <div class="models-search-container" style="margin-bottom: 16px;">
        <input type="text" id="models-search" placeholder="Search models (e.g. 'flash', '4o')..." class="prism-search-input" style="width: 100%;">
      </div>
      <div class="model-setting-card model-setting-card-master">
        <div class="model-setting-info">
          <div class="model-setting-name">All models</div>
          <div class="model-setting-desc">Master switch \u2014 enables or disables every model below in one click.</div>
        </div>
        <label class="prism-toggle">
          <input type="checkbox" id="all-models-toggle" ${allEnabled ? "checked" : ""}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="model-settings-list">
    `;

    const categories = [
      { key: "simple", title: "🟢 Simple Tasks", subtitle: "Fast, low-latency, and highly economical", border: "1px solid rgba(16, 185, 129, 0.2)" },
      { key: "standard", title: "🟡 Standard Tasks", subtitle: "Methodical tool-use and reliable daily coding", border: "1px solid rgba(245, 158, 11, 0.2)" },
      { key: "complex", title: "🔴 Complex Tasks", subtitle: "Deep logical reasoning, long-horizon planning, and audits", border: "1px solid rgba(239, 68, 68, 0.2)" },
    ];

    for (const cat of categories) {
      const catModels = models.filter(m => (m.complexity || "standard") === cat.key);
      if (catModels.length === 0) continue;

      html += `
        <div class="settings-subsection-container" style="margin-top: 16px; margin-bottom: 20px; padding: 14px; background: rgba(15, 23, 42, 0.35); border-radius: 10px; border: ${cat.border};">
          <div class="settings-subsection-header" style="margin-bottom: 12px;">
            <div class="settings-subsection-title" style="font-size: 13px; font-weight: 700; color: #f3f4f6; display: flex; align-items: center; gap: 6px;">
              ${cat.title}
            </div>
            <div class="settings-subsection-subtitle" style="font-size: 11px; color: #94a3b8; margin-top: 2px;">
              ${cat.subtitle}
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
      `;

      html += catModels.map(m => {
        const isEnabled = settings.isModelEnabled(m.slug, m.enabled !== false);
        const tierLabel = m.tier === "main" ? "Main" : "Explore";

        return `
          <div class="model-setting-card" style="margin-bottom: 0;">
            <div class="model-setting-info">
              <div class="model-setting-name">
                ${escapeHtml(m.aliases[0])} 
                <span class="model-setting-tier ${m.tier}">${tierLabel}</span>
              </div>
              <div class="model-setting-desc">${escapeHtml(m.description)}</div>
            </div>
            <label class="prism-toggle">
              <input type="checkbox" data-slug="${escapeHtml(m.slug)}" ${isEnabled ? "checked" : ""}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        `;
      }).join("");

      html += `
          </div>
        </div>
      `;
    }

    html += `</div>`;
    this.content.innerHTML = html;

    // Filter logic
    const searchInput = this.content.querySelector<HTMLInputElement>("#models-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        const query = searchInput.value.toLowerCase().trim();
        this.content.querySelectorAll<HTMLElement>(".model-setting-card:not(.model-setting-card-master)").forEach(card => {
          const name = card.querySelector(".model-setting-name")?.textContent?.toLowerCase() || "";
          const desc = card.querySelector(".model-setting-desc")?.textContent?.toLowerCase() || "";
          if (name.includes(query) || desc.includes(query)) {
            card.style.display = "flex";
          } else {
            card.style.display = "none";
          }
        });
      });
    }

    // Wire the master toggle. On flip, bulk-update all per-slug
    // overrides via the dedicated helper (one localStorage write,
    // one settings-changed event), then re-render so the individual
    // toggles below reflect the new state without flicker.
    const masterToggle = this.content.querySelector<HTMLInputElement>("#all-models-toggle");
    masterToggle?.addEventListener("change", () => {
      const slugs = models.map(m => m.slug);
      settings.setAllModelsEnabled(slugs, masterToggle.checked);
      
      // We don't want to re-render the whole tab and lose focus on the search input,
      // so we just update the checkboxes manually.
      this.content.querySelectorAll<HTMLInputElement>("input[data-slug]").forEach(input => {
        input.checked = masterToggle.checked;
      });
    });

    // Wire per-model toggles. Each individual change might invalidate
    // the master's aggregate state (e.g. user flips one off when all
    // were on \u2192 master should now read OFF), so we re-render after
    // every change so the master stays honest.
    this.content.querySelectorAll<HTMLInputElement>("input[data-slug]").forEach(input => {
      input.addEventListener("change", () => {
        settings.setModelEnabled(input.dataset.slug!, input.checked);
        // Update master toggle manually without re-rendering to preserve search state
        if (masterToggle) {
          const allInputs = Array.from(this.content.querySelectorAll<HTMLInputElement>("input[data-slug]"));
          masterToggle.checked = allInputs.every(input => input.checked);
        }
      });
    });
  }

  private async renderSkills(): Promise<void> {
    if (!this.activeWorkspace) {
      this.content.innerHTML = `
        <h2 class="settings-section-title">Prism Skills</h2>
        <div class="empty-state">
          <p>Open a tab first to browse conversation skills for its workspace.</p>
        </div>
      `;
      return;
    }

    const cwd = this.activeWorkspace.getCwd();
    if (!cwd) {
      this.content.innerHTML = `
        <h2 class="settings-section-title">Prism Skills</h2>
        <div class="empty-state">
          <p>Workspace unknown. Start a shell to browse skills.</p>
        </div>
      `;
      return;
    }

    this.content.innerHTML = `
      <div class="settings-header-row">
        <h2 class="settings-section-title">Prism Skill Library</h2>
        <div class="settings-header-actions">
          <button id="skills-new-group" class="settings-action-btn" title="Save the current search as a named group (type a search first)" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            Group
          </button>
          <button id="skills-refresh" class="settings-refresh-btn" title="Refresh library">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
          </button>
        </div>
      </div>
      <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 20px;">
        Skills are persistent behavioral guides loaded from <code>.prism/skills/</code>. Enabled skills are injected into the agent's context.
      </p>
      
      <div class="skills-search-container">
        <input type="text" id="skills-search" placeholder="Search skills or families..." class="prism-search-input">
      </div>

      <div id="skills-list" class="skills-list">
        <div class="loading-state">Scanning skill library...</div>
      </div>
    `;

    const skillsListEl = document.getElementById("skills-list")!;
    const searchInput = document.getElementById("skills-search") as HTMLInputElement;
    const refreshBtn = document.getElementById("skills-refresh")!;
    const newGroupBtn = document.getElementById("skills-new-group")!;

    refreshBtn.addEventListener("click", () => this.renderSkills());
    // `+ Group` is repurposed: instead of creating a filesystem
    // subdirectory (the legacy behavior), it saves the current search
    // bar text as a named virtual group. The group's contents are
    // \"whatever currently matches the term\" \u2014 see
    // `SavedSearchGroup` in settings.ts. The button is disabled
    // whenever the search bar is empty so the affordance is honest
    // (no search = nothing to save).
    newGroupBtn.addEventListener("click", () => {
      const term = (searchInput.value ?? "").trim();
      if (term.length === 0) return; // belt-and-suspenders; button is disabled in this state
      // Default the group's name to the search term itself \u2014 most users
      // will want \"vc\" \u2192 group named \"vc\" rather than typing both.
      // The prompt is editable so they can pick a friendlier name
      // when the search syntax is more complex (e.g. a quoted phrase).
      const name = prompt(
        `Save \"${term}\" as a group? Pick a name:`,
        term,
      );
      if (!name) return;
      const created = settings.addSavedGroup(name, term);
      if (!created) {
        alert("Could not save group (empty name or term).");
        return;
      }
      this.renderSkills();
    });

    try {
      const skills = await invoke<any[]>("list_skills", { cwd });
      const folders = await invoke<string[]>("list_skill_folders", { cwd });

      // Grouping logic: Root files in "Other", subdirectories as Families
      const families: Record<string, SkillFileEntry[]> = {};
      
      for (const s of skills) {
        let family = "Other";
        if (s.slug.includes("/")) {
          family = s.slug.split("/").slice(0, -1).join("/");
        }
        if (!families[family]) families[family] = [];
        families[family].push({
          name: s.name,
          slug: s.slug,
          sizeBytes: s.sizeBytes,
          description: s.description
        });
      }

      const familyNames = Object.keys(families).sort();

      const renderList = (filter = "") => {
        const filteredFamilies = filterSkillFamilies(families, filter);
        let html = "";

        // ---- Skill Folders Awareness --------------------------------------
        if (folders.length > 0 && !filter) {
          html += `
            <div class="settings-subsection-title" style="margin-top: 0; margin-bottom: 12px; font-size: 11px; text-transform: uppercase; color: #4b5563; font-weight: 700; letter-spacing: 0.05em;">Skill Folders Awareness</div>
            <div class="skill-folders-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin-bottom: 24px; padding: 12px; background: rgba(15, 21, 32, 0.4); border-radius: 8px; border: 1px solid #1f2937;">
          `;
          for (const folder of folders) {
            const isEnabled = settings.isSkillFolderEnabled(folder);
            html += `
              <div class="skill-folder-item" style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" class="skill-folder-toggle" id="folder-toggle-${folder}" data-folder="${folder}" ${isEnabled ? "checked" : ""}>
                <label for="folder-toggle-${folder}" style="font-size: 12px; color: #94a3b8; cursor: pointer; user-select: none;">${folder}</label>
              </div>
            `;
          }
          html += `</div>`;
        }

        // ---- Saved-search groups (virtual; user-defined) ------------------
        // Render BEFORE filesystem families so the user's curated views
        // sit at the top. Saved groups intentionally ignore the search
        // bar text \u2014 they're pre-curated views, not exploratory
        // searches. Their contents are computed by re-running the
        // group's stored searchTerm against the same `families` map
        // the search bar uses, so whatever \"vc\" matches today, the
        // saved \"vc\" group surfaces today.
        const savedGroups = settings.getSavedGroups();
        for (const group of savedGroups) {
          const matches = filterSkillFamilies(families, group.searchTerm).flatMap(
            (g) => g.files,
          );
          html += `
            <div class="skill-family skill-family--saved" data-saved-group-id="${group.id}">
              <div class="skill-family-header">
                <span class="skill-family-name">
                  ${escapeHtml(group.name)}
                  <span class="skill-family-meta" style="font-size:10px;color:#6b7280;font-weight:400;margin-left:6px;">search: \u201c${escapeHtml(group.searchTerm)}\u201d</span>
                </span>
                <div class="skill-family-actions">
                  <span class="skill-count">${matches.length} skill${matches.length === 1 ? "" : "s"}</span>
                  <button class="saved-group-delete" data-group-id="${group.id}" title="Delete this saved group" style="background:transparent;border:none;color:#6b7280;cursor:pointer;font-size:14px;padding:0 4px;">\u00d7</button>
                  <label class="prism-toggle mini">
                    <input type="checkbox" class="saved-group-toggle" data-group-id="${group.id}" ${group.enabled ? "checked" : ""}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              <div class="skill-family-content">
                ${
                  matches.length === 0
                    ? `<div class="empty-state" style="font-size:11px;color:#6b7280;padding:8px 12px;">No skills currently match \u201c${escapeHtml(group.searchTerm)}\u201d.</div>`
                    : matches
                        .map((f) => {
                          return `
                            <div class="skill-item">
                              <div class="skill-item-info">
                                <div class="skill-item-name">${escapeHtml(f.name)}</div>
                                <div class="skill-item-desc" style="font-size:10px;color:#4b5563;">${escapeHtml(f.description)}</div>
                              </div>
                              <div class="skill-item-controls">
                                <label class="prism-toggle mini">
                                  <input type="checkbox" class="skill-toggle" data-path="${escapeHtml(f.slug)}" ${settings.isSkillEnabled(f.slug) ? "checked" : ""}>
                                  <span class="toggle-slider"></span>
                                </label>
                              </div>
                            </div>
                          `;
                        })
                        .join("")
                }
              </div>
            </div>
          `;
        }

        // ---- Filesystem families (existing behavior) ----------------------
        for (const { familyName, files } of filteredFamilies) {
          const allPaths = files.map(f => f.slug);
          const allEnabled = files.length > 0 && files.every(f => settings.isSkillEnabled(f.slug));
          
          html += `
            <div class="skill-family">
              <div class="skill-family-header">
                <span class="skill-family-name">${escapeHtml(familyName)}</span>
                <div class="skill-family-actions">
                  <span class="skill-count">${files.length} skills</span>
                  <label class="prism-toggle mini">
                    <input type="checkbox" class="family-toggle" data-paths='${escapeHtml(JSON.stringify(allPaths))}' ${allEnabled ? "checked" : ""}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              <div class="skill-family-content">
                ${files.map(f => {
                  return `
                    <div class="skill-item">
                      <div class="skill-item-info">
                        <div class="skill-item-name">${escapeHtml(f.name)}</div>
                        <div class="skill-item-desc" style="font-size:10px;color:#4b5563;">${escapeHtml(f.description)}</div>
                      </div>
                      <div class="skill-item-controls">
                        <select class="skill-move-select" data-path="${escapeHtml(f.slug)}" data-current="${escapeHtml(familyName)}">
                          ${familyNames.map(name => `<option value="${name}" ${name === familyName ? "selected" : ""}>Move to ${name}</option>`).join("")}
                        </select>
                        <label class="prism-toggle mini">
                          <input type="checkbox" class="skill-toggle" data-path="${escapeHtml(f.slug)}" ${settings.isSkillEnabled(f.slug) ? "checked" : ""}>
                          <span class="toggle-slider"></span>
                        </label>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          `;
        }

        skillsListEl.innerHTML = html || `<div class="empty-state">No skills matching "${filter}"</div>`;

        // Folder awareness toggles
        skillsListEl.querySelectorAll<HTMLInputElement>(".skill-folder-toggle").forEach(input => {
          input.addEventListener("change", () => {
            settings.setSkillFolderEnabled(input.dataset.folder!, input.checked);
          });
        });

        // Skill toggles
        skillsListEl.querySelectorAll<HTMLInputElement>(".skill-toggle").forEach(input => {
          input.addEventListener("change", () => {
            settings.setSkillEnabled(input.dataset.path!, input.checked);
          });
        });

        skillsListEl.querySelectorAll<HTMLInputElement>(".family-toggle").forEach(input => {
          input.addEventListener("change", () => {
            const paths = JSON.parse(input.dataset.paths!);
            settings.setFamilyEnabled(paths, input.checked);
            renderList(searchInput.value);
          });
        });

        // Saved-group toggle: enable/disable the group's logical
        // inclusion in agent context. Doesn't touch individual skill
        // toggles \u2014 OR-composition (group on \u2228 skill on) is what the
        // future agent-loader will check.
        skillsListEl
          .querySelectorAll<HTMLInputElement>(".saved-group-toggle")
          .forEach((input) => {
            input.addEventListener("change", () => {
              const id = input.dataset.groupId!;
              settings.setSavedGroupEnabled(id, input.checked);
            });
          });

        // Saved-group delete: removes the virtual grouping. Individual
        // skill toggles + filesystem families are untouched. We re-run
        // the full skill render so the now-deleted card disappears.
        skillsListEl
          .querySelectorAll<HTMLButtonElement>(".saved-group-delete")
          .forEach((btn) => {
            btn.addEventListener("click", () => {
              const id = btn.dataset.groupId!;
              const group = settings
                .getSavedGroups()
                .find((g) => g.id === id);
              const label = group?.name ?? "this group";
              if (!confirm(`Delete saved group \u201c${label}\u201d?`)) return;
              settings.removeSavedGroup(id);
              this.renderSkills();
            });
          });

        // Wire Move selects
        skillsListEl.querySelectorAll<HTMLSelectElement>(".skill-move-select").forEach(select => {
          select.addEventListener("change", async () => {
            const from = select.dataset.path!;
            const targetName = select.value;
            const targetDir = targetName === "Other" ? ".prism/skills" : `.prism/skills/${targetName}`;
            
            try {
              await invoke("move_file", { cwd, from, to: targetDir });
              this.renderSkills(); // Refresh
            } catch (err) {
              alert(`Move failed: ${err}`);
              select.value = select.dataset.current!;
            }
          });
        });
      };

      renderList();

      // Keep the `+ Group` button's disabled state in sync with the
      // search bar: enabled iff there's a non-empty term to save.
      // Updating it here means tab-switches (which re-run renderSkills)
      // and direct edits both stay correct.
      const updateNewGroupButtonState = (rawValue: string) => {
        const hasTerm = rawValue.trim().length > 0;
        (newGroupBtn as HTMLButtonElement).disabled = !hasTerm;
        newGroupBtn.title = hasTerm
          ? `Save \u201c${rawValue.trim()}\u201d as a named group`
          : "Save the current search as a named group (type a search first)";
      };
      updateNewGroupButtonState(searchInput.value);

      let searchDebounce: number | null = null;
      searchInput.addEventListener("input", (e) => {
        const nextValue = (e.target as HTMLInputElement).value;
        // Button state tracks the live input value (no debounce) so
        // the affordance flips immediately on the first keystroke.
        updateNewGroupButtonState(nextValue);
        if (searchDebounce !== null) {
          window.clearTimeout(searchDebounce);
        }
        searchDebounce = window.setTimeout(() => {
          renderList(nextValue);
        }, SKILLS_SEARCH_DEBOUNCE_MS);
      });

      searchInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        if (searchDebounce !== null) {
          window.clearTimeout(searchDebounce);
          searchDebounce = null;
        }
        renderList(searchInput.value);
      });

    } catch (err) {
      skillsListEl.innerHTML = `<div class="error-state">Failed to access .prism/skills/ directory.</div>`;
    }
  }

  private async renderHistory(): Promise<void> {
    if (!this.activeWorkspace) {
      this.content.innerHTML = `
        <h2 class="settings-section-title">History</h2>
        <div class="empty-state">
          <p>Open a tab first to browse conversation history for its workspace.</p>
        </div>
      `;
      return;
    }

    const cloudPath = settings.getCloudSyncPath();
    const cwd = this.activeWorkspace.getCwd();

    this.content.innerHTML = `
      <h2 class="settings-section-title">History</h2>
      <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 24px;">
        Saved conversation artifacts found in <code>.prism/history/</code>.
      </p>

      <!-- Cloud Sync Configuration -->
      <div class="settings-group sync-group">
        <label class="settings-group-title">Cloud Synchronization</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 12px;">
          Synchronize your conversation histories automatically across devices using iCloud, Dropbox, or any custom directory.
        </p>
        <div class="sync-config-row">
          ${cloudPath ? `
            <div class="sync-status active">
              <span class="sync-icon">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
              </span>
              <div class="sync-info">
                <div class="sync-title">Cloud Sync Active</div>
                <div class="sync-path">${escapeHtml(cloudPath)}</div>
              </div>
              <button id="unmap-sync-btn" class="history-load-btn" style="background: #ef4444; font-size: 11px;">Unmap</button>
            </div>
          ` : `
            <div class="sync-status inactive">
              <span class="sync-icon">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17.5 19a3.5 3.5 0 1 1 0-7c.28 0 .55.03.81.08c1-3.6 4.3-6.08 8.19-6.08c5.25 0 9.5 4.25 9.5 9.5c0 .35-.02.7-.06 1.04C41 19.5 37 22 32 22h-13a6 6 0 0 1-1.5-11.8"></path>
                </svg>
              </span>
              <div class="sync-info">
                <div class="sync-title">Cloud Sync Disabled</div>
                <div class="sync-desc">Auto-saves will live only in this project's local <code>.prism/history/</code>.</div>
              </div>
              <button id="map-sync-btn" class="history-load-btn" style="background: #10b981; font-size: 11px;">Map Cloud Folder</button>
            </div>
          `}
        </div>
      </div>

      <label class="settings-group-title">Saved Chats</label>
      <div id="history-list" class="history-list">
        <div class="loading-state">Scanning directories...</div>
      </div>
    `;

    // Hook cloud sync button listeners
    const mapBtn = document.getElementById("map-sync-btn");
    if (mapBtn) {
      mapBtn.addEventListener("click", async () => {
        try {
          const picked = await openDialog({
            title: "Select cloud sync folder (e.g. inside Dropbox or iCloud Drive)",
            multiple: false,
            directory: true,
          });
          const target = Array.isArray(picked) ? (picked[0] ?? null) : picked;
          if (target) {
            settings.setCloudSyncPath(target);
            // Re-render
            void this.renderHistory();
          }
        } catch (e) {
          alert(`Failed to pick sync folder: ${e}`);
        }
      });
    }

    const unmapBtn = document.getElementById("unmap-sync-btn");
    if (unmapBtn) {
      unmapBtn.addEventListener("click", () => {
        settings.setCloudSyncPath(undefined);
        void this.renderHistory();
      });
    }

    const historyEl = document.getElementById("history-list")!;

    try {
      // 1. Create .prism/history on demand so it's always ready
      await invoke("create_dir", { cwd, path: ".prism/history" });

      // 2. List entries in .prism/history directory
      const localPath = `${cwd}/.prism/history`;
      const result = await invoke<any>("list_dir_entries", { cwd: localPath, partial: "" });
      const localFiles = (result.entries as any[]).filter(e => e.kind === "file" && e.name.endsWith(".md"));

      interface ChatMetadata {
        path: string;
        name: string;
        title: string;
        model: string;
        chatId?: string;
        created?: string;
        messagesCount?: number;
        format?: string;
        source: "local" | "cloud" | "both";
      }

      const chatsMap = new Map<string, ChatMetadata>();

      const parseFrontmatter = (content: string): Record<string, string> => {
        const meta: Record<string, string> = {};
        const lines = content.split("\n");
        if (lines[0]?.trim() !== "---") return meta;
        
        let i = 1;
        while (i < lines.length && lines[i].trim() !== "---") {
          const line = lines[i].trim();
          const colonIdx = line.indexOf(":");
          if (colonIdx !== -1) {
            const key = line.slice(0, colonIdx).trim();
            let val = line.slice(colonIdx + 1).trim();
            if (val.startsWith('"') && val.endsWith('"')) {
              val = val.slice(1, -1);
            } else if (val.startsWith("'") && val.endsWith("'")) {
              val = val.slice(1, -1);
            }
            meta[key] = val;
          }
          i++;
        }
        return meta;
      };

      // Read local files frontmatter
      for (const entry of localFiles) {
        try {
          const fileData = await invoke<any>("read_file_text", { cwd: localPath, path: entry.name });
          const frontmatter = parseFrontmatter(fileData.content);
          const chatId = frontmatter.chat_id || entry.name;
          const created = frontmatter.created || "";
          
          chatsMap.set(chatId, {
            path: fileData.path,
            name: entry.name,
            title: frontmatter.title || entry.name.replace(/\.full\.md$/, "").replace(/\.md$/, ""),
            model: frontmatter.model || "unknown",
            chatId,
            created,
            messagesCount: frontmatter.messages ? parseInt(frontmatter.messages, 10) : undefined,
            format: frontmatter.format,
            source: "local"
          });
        } catch (e) {
          console.error("Failed to read local chat frontmatter:", e);
        }
      }

      // Read cloud sync files if configured
      if (cloudPath) {
        try {
          const cloudResult = await invoke<any>("list_dir_entries", { cwd: cloudPath, partial: "" });
          const cloudFiles = (cloudResult.entries as any[]).filter(e => e.kind === "file" && e.name.endsWith(".md"));
          
          for (const entry of cloudFiles) {
            try {
              // Ensure we only read cloud sync files related to this workspace
              const workspaceName = cwd.split("/").pop() || "workspace";
              if (!entry.name.startsWith(`${workspaceName}_`)) continue;

              const fileData = await invoke<any>("read_file_text", { cwd: cloudPath, path: entry.name });
              const frontmatter = parseFrontmatter(fileData.content);
              const chatId = frontmatter.chat_id || entry.name;
              const created = frontmatter.created || "";
              
              const existing = chatsMap.get(chatId);
              if (!existing) {
                chatsMap.set(chatId, {
                  path: fileData.path,
                  name: entry.name,
                  title: frontmatter.title || entry.name.replace(/\.full\.md$/, "").replace(/\.md$/, ""),
                  model: frontmatter.model || "unknown",
                  chatId,
                  created,
                  messagesCount: frontmatter.messages ? parseInt(frontmatter.messages, 10) : undefined,
                  format: frontmatter.format,
                  source: "cloud"
                });
              } else {
                existing.source = "both";
              }
            } catch (e) {
              console.error("Failed to read cloud chat frontmatter:", e);
            }
          }
        } catch (e) {
          console.error("Failed to list cloud sync files:", e);
        }
      }

      const chats = Array.from(chatsMap.values());
      
      if (chats.length === 0) {
        historyEl.innerHTML = `<div class="empty-state">No saved chats found in .prism/history/</div>`;
        return;
      }

      // Sort by created timestamp descending, or sort by name descending as a fallback
      chats.sort((a, b) => {
        if (a.created && b.created) {
          return b.created.localeCompare(a.created);
        }
        return b.name.localeCompare(a.name);
      });

      historyEl.innerHTML = chats.map(c => {
        const fullPath = c.path;
        
        let badgeHtml = "";
        if (c.source === "both") {
          badgeHtml += `<span class="history-badge history-badge-cloud">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2px;">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg> Synced</span>`;
        } else if (c.source === "cloud") {
          badgeHtml += `<span class="history-badge history-badge-cloud">Cloud</span>`;
        } else {
          badgeHtml += `<span class="history-badge history-badge-local">Local</span>`;
        }

        if (c.model && c.model !== "unknown") {
          badgeHtml += `<span class="history-badge history-badge-model">${escapeHtml(c.model)}</span>`;
        }

        if (c.messagesCount !== undefined) {
          badgeHtml += `<span class="history-badge history-badge-messages">${c.messagesCount} turns</span>`;
        }

        const formattedDate = c.created ? new Date(c.created).toLocaleString() : "";

        return `
          <div class="history-item" style="padding: 14px 18px;">
            <div class="history-info">
              <div class="history-name" style="font-size: 14px; font-weight: 600;">${escapeHtml(c.title)}</div>
              <div class="history-item-badge-row">
                ${badgeHtml}
                ${formattedDate ? `<span style="font-size: 11px; color: #4b5563; margin-left: 6px;">${escapeHtml(formattedDate)}</span>` : ""}
              </div>
              <div class="history-meta" style="margin-top: 6px; opacity: 0.5;">${escapeHtml(fullPath)}</div>
            </div>
            <button class="history-load-btn" data-path="${escapeHtml(fullPath)}">Load</button>
          </div>
        `;
      }).join("");

      historyEl.querySelectorAll(".history-load-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const path = (btn as HTMLElement).dataset.path!;
          const ws = this.activeWorkspace;
          if (!ws) return;

          try {
            (btn as HTMLButtonElement).disabled = true;
            (btn as HTMLButtonElement).textContent = "Loading...";
            this.close();
            await ws.loadSavedChat(path);
          } catch (err) {
            alert(`Failed to load chat: ${err}`);
            (btn as HTMLButtonElement).disabled = false;
            (btn as HTMLButtonElement).textContent = "Load";
          }
        });
      });

    } catch (err) {
      historyEl.innerHTML = `<div class="error-state">No .prism/history directory found or failed to scan.</div>`;
    }
  }

  private renderSubstrate(): void {
    this.content.innerHTML = `
      <h2 class="settings-section-title">Substrate Configuration</h2>
      <div class="settings-group">
        <p style="color: #6b7280; font-size: 12px;">
          Advanced settings for the code analysis engine and local grounding.
        </p>
        <div style="margin-top: 24px; color: #4b5563; font-size: 12px; font-style: italic;">
          Custom substrate commands and rigor levels coming soon.
        </div>
      </div>
    `;
  }

  private renderAbout(): void {
    this.content.innerHTML = `
      <h2 class="settings-section-title">About PRISM</h2>
      <div class="settings-group">
        <p style="color: #e5e7eb; font-size: 13px; font-weight: 600;">PRISM by Stellarum</p>
        <p style="color: #6b7280; font-size: 11px;">Version 2.0.4 - Catalyst Edition</p>
        <div class="about-logo"></div>
        <p style="margin-top: 16px; color: #94a3b8; font-size: 12px; line-height: 1.5;">
          A high-performance agentic workstation designed for the modern developer. 
          Built with speed, precision, and substrate-awareness.
        </p>
      </div>
    `;
  }

  private async renderUsage(): Promise<void> {
    this.content.innerHTML = `
      <h2 class="settings-section-title">AI Usage & Analytics</h2>
      <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 24px;">
        Track your consumption and compare actual provider costs against the credit markup.
      </p>
      <div id="usage-container" class="usage-container">
        <div class="loading-state">Loading usage summary...</div>
      </div>
    `;

    const container = document.getElementById("usage-container")!;
    try {
      const chatId = this.activeWorkspace?.id || null;
      const summary = await invoke<{
        session_tokens: number;
        session_cost_usd: number;
        session_markup_cost_usd: number;
        session_calls: number;
        today_tokens: number;
        today_cost_usd: number;
        today_markup_cost_usd: number;
        today_calls: number;
        by_interaction: { mode: string; model: string; tokens: number; cost: number; markup_cost: number; calls: number }[];
      }>("get_usage_summary", { chatId });

      const subInfo = await invoke<{ 
        tier: string;
        balance_usd: number;
        total_real_cost_usd: number;
      }>("get_subscription_info");
      const isPro = subInfo.tier === "Pro";

      const formatCost = (c: number) => `$${c.toFixed(4)}`;
      const formatCredits = (c: number) => `$${c.toFixed(2)}`;
      const formatTokensFull = (t: number) => t.toLocaleString();

      let html = `
        <div class="usage-stats-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 32px;">
          <div class="usage-stat-card" style="background: #111827; border: 1px solid #1f2937; padding: 24px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: 700; color: #2dd4bf; margin-bottom: 4px;">${summary.today_calls}</div>
            <div style="font-size: 10px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.1em; font-weight: 600;">Turns (Today)</div>
          </div>
          <div class="usage-stat-card" style="background: #111827; border: 1px solid #1f2937; padding: 24px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: 700; color: #2dd4bf; margin-bottom: 4px;">${formatTokensFull(summary.today_tokens)}</div>
            <div style="font-size: 10px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.1em; font-weight: 600;">Total Tokens</div>
          </div>
          <div class="usage-stat-card" style="background: #111827; border: 1px solid #1f2937; padding: 24px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: 700; color: #2dd4bf; margin-bottom: 4px;">${formatCredits(subInfo.balance_usd)}</div>
            <div style="font-size: 10px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.1em; font-weight: 600;">Credit Balance</div>
          </div>
        </div>

        <div class="usage-table-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 style="font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em;">Interaction Breakdown</h3>
          <div style="font-size: 11px; color: #4b5563;">Lifetime Spend: ${formatCost(subInfo.total_real_cost_usd)} (Real)</div>
        </div>

        <div class="usage-table-wrapper" style="background: transparent; border-radius: 8px; overflow: hidden;">
          <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
            <thead>
              <tr style="border-bottom: 1px solid #1f2937;">
                <th style="padding: 12px 0; color: #4b5563; font-weight: 600; text-transform: uppercase; font-size: 10px;">Agent</th>
                <th style="padding: 12px 0; color: #4b5563; font-weight: 600; text-transform: uppercase; font-size: 10px;">Model</th>
                <th style="padding: 12px 0; color: #4b5563; font-weight: 600; text-transform: uppercase; font-size: 10px; text-align: right;">Calls</th>
                <th style="padding: 12px 0; color: #4b5563; font-weight: 600; text-transform: uppercase; font-size: 10px; text-align: right;">Real Cost</th>
                <th style="padding: 12px 0; color: #4b5563; font-weight: 600; text-transform: uppercase; font-size: 10px; text-align: right;">Credits</th>
              </tr>
            </thead>
            <tbody>
      `;

      if (summary.by_interaction.length === 0) {
        html += `
          <tr>
            <td colspan="5" style="padding: 48px 0; text-align: center; color: #374151; font-style: italic;">No usage recorded yet.</td>
          </tr>
        `;
      } else {
        for (const m of summary.by_interaction) {
          const modelName = m.model.split("/").pop() || m.model;
          const modeName = m.mode.charAt(0).toUpperCase() + m.mode.slice(1);
          html += `
            <tr style="border-bottom: 1px solid #111827;">
              <td style="padding: 16px 0; color: #e5e7eb; font-weight: 500;">${escapeHtml(modeName)}</td>
              <td style="padding: 16px 0; color: #4b5563; font-family: ui-monospace, monospace;">${escapeHtml(modelName)}</td>
              <td style="padding: 16px 0; color: #e5e7eb; text-align: right;">${m.calls}</td>
              <td style="padding: 16px 0; color: #94a3b8; text-align: right;">${formatCost(m.cost)}</td>
              <td style="padding: 16px 0; color: #2dd4bf; text-align: right; font-weight: 600;">${formatCost(m.markup_cost)}</td>
            </tr>
          `;
        }
      }

      html += `
            </tbody>
          </table>
        </div>

        <div class="usage-subscription-section" style="margin-top: 32px; border-top: 1px solid #1f2937; padding-top: 24px;">
          <h3 style="font-size: 13px; font-weight: 600; color: #e5e7eb; margin-bottom: 8px;">Refill Credits</h3>
          <div style="display: flex; align-items: center; justify-content: space-between; background: #1f2937; padding: 12px 16px; border-radius: 8px;">
            <div>
              <div style="font-size: 14px; color: #e5e7eb; font-weight: 500;">${isPro ? "Pro Plan" : "Free Tier"}</div>
              <div style="font-size: 11px; color: #94a3b8;">${isPro ? "High-volume usage included" : "Credits expire at $0.00 balance"}</div>
            </div>
            ${isPro ? `
              <div style="background: #059669; color: white; padding: 4px 12px; border-radius: 99px; font-size: 11px; font-weight: 600;">Active</div>
            ` : `
              <button id="upgrade-pro-btn" class="settings-action-btn" style="background: #3b82f6; color: white; border: none; padding: 6px 16px; border-radius: 4px; font-weight: 600; font-size: 12px; cursor: pointer;">Buy $30.00 Credit</button>
            `}
          </div>
        </div>

      `;

      container.innerHTML = html;

      // Wire upgrade button
      const upgradeBtn = document.getElementById("upgrade-pro-btn") as HTMLButtonElement;
      if (upgradeBtn) {
        upgradeBtn.addEventListener("click", async () => {
          try {
            upgradeBtn.disabled = true;
            upgradeBtn.textContent = "Processing...";
            await invoke("upgrade_to_pro");
            alert("Success! You have added $30.00 to your credit balance.");
            this.renderUsage(); // Refresh UI
          } catch (e) {
            alert(`Upgrade failed: ${e}`);
            upgradeBtn.disabled = false;
            upgradeBtn.textContent = "Buy $30.00 Credit";
          }
        });
      }
    } catch (e) {
      container.innerHTML = `<div class="error-state">Failed to load usage summary: ${escapeHtml(String(e))}</div>`;
    }
  }
}
