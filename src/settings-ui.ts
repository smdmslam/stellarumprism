/**
 * UI Controller for the Settings Overlay.
 */

import { settings } from "./settings";
import { MODEL_LIBRARY } from "./models";
import { invoke } from "@tauri-apps/api/core";
import { Workspace } from "./workspace";

type SkillFileEntry = {
  name: string;
  path: string;
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
  private currentTab = "general";
  private activeWorkspace: Workspace | null = null;

  constructor() {
    this.overlay = document.getElementById("settings-overlay")!;
    this.content = document.getElementById("settings-content")!;
    this.wireEvents();
  }

  public open(activeWs: Workspace | null = null): void {
    this.activeWorkspace = activeWs;
    this.overlay.setAttribute("aria-hidden", "false");
    this.render();
  }

  public close(): void {
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
      case "substrate":
        this.renderSubstrate();
        break;
      case "about":
        this.renderAbout();
        break;
    }
  }

  private renderGeneral(): void {
    const currentTheme = settings.getTheme();
    
    this.content.innerHTML = `
      <h2 class="settings-section-title">General Settings</h2>
      
      <div class="settings-group">
        <label class="settings-group-title">Appearance & Theme</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 12px;">
          Select your preferred interface aesthetic.
        </p>
        
        <div class="theme-selector">
          <button class="theme-btn ${currentTheme === "dark" ? "active" : ""}" data-theme="dark">Dark</button>
          <button class="theme-btn ${currentTheme === "light" ? "active" : ""}" data-theme="light">Light</button>
          <button class="theme-btn ${currentTheme === "system" ? "active" : ""}" data-theme="system">System</button>
        </div>
      </div>

      <div class="settings-group">
        <label class="settings-group-title">Editor Configuration</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 12px;">
          Controls for the CodeMirror editor core.
        </p>
        <div style="color: #4b5563; font-size: 12px; font-style: italic;">
          More controls coming soon (Font size, Tab behavior, Indent guides).
        </div>
      </div>
    `;

    // Wire theme buttons
    this.content.querySelectorAll(".theme-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const theme = (btn as HTMLElement).dataset.theme as any;
        settings.setTheme(theme);
        this.render(); // Redraw to update active class
      });
    });
  }

  private renderModels(): void {
    const models = MODEL_LIBRARY.filter(m => m.tier !== "backend");
    
    let html = `
      <h2 class="settings-section-title">AI Model Curation</h2>
      <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 24px;">
        Toggle models to enable/disable them in the global command bar. Disabling poor-performing models streamlines your workflow.
      </p>
      <div class="model-settings-list">
    `;

    html += models.map(m => {
      const isEnabled = settings.isModelEnabled(m.slug);
      const tierLabel = m.tier === "main" ? "Main" : "Explore";
      
      return `
        <div class="model-setting-card">
          <div class="model-setting-info">
            <div class="model-setting-name">
              ${m.aliases[0]} 
              <span class="model-setting-tier ${m.tier}">${tierLabel}</span>
            </div>
            <div class="model-setting-desc">${m.description}</div>
          </div>
          <label class="prism-toggle">
            <input type="checkbox" data-slug="${m.slug}" ${isEnabled ? "checked" : ""}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      `;
    }).join("");

    html += `</div>`;
    this.content.innerHTML = html;

    // Wire toggles
    this.content.querySelectorAll<HTMLInputElement>("input[data-slug]").forEach(input => {
      input.addEventListener("change", () => {
        settings.setModelEnabled(input.dataset.slug!, input.checked);
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
        <button id="skills-refresh" class="settings-refresh-btn" title="Refresh library">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
        </button>
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

    refreshBtn.addEventListener("click", () => this.renderSkills());

    try {
      const skillsPath = `${cwd}/.prism/skills`;
      const result = await invoke<any>("list_dir_entries", { cwd: skillsPath, partial: "" });
      const skillFiles = (result.entries as any[]).filter(e => e.kind === "file" && e.name.endsWith(".md"));

      if (skillFiles.length === 0) {
        skillsListEl.innerHTML = `<div class="empty-state">No skills found in .prism/skills/</div>`;
        return;
      }

      // Grouping logic
      const families: Record<string, SkillFileEntry[]> = {};
      for (const file of skillFiles) {
        const parts = file.name.split("-");
        let familyName = "Other";
        if (parts.length > 1) {
          familyName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        }
        if (!families[familyName]) families[familyName] = [];
        // Construct full path for persistence
        const fullPath = `${skillsPath}/${file.name}`;
        families[familyName].push({ name: file.name, path: fullPath });
      }

      const renderList = (filter = "") => {
        const filteredFamilies = filterSkillFamilies(families, filter);
        let html = "";

        for (const { familyName, files } of filteredFamilies) {
          const allPaths = files.map(f => f.path);
          const allEnabled = files.every(f => settings.isSkillEnabled(f.path));
          
          html += `
            <div class="skill-family">
              <div class="skill-family-header">
                <span class="skill-family-name">${familyName}</span>
                <div class="skill-family-actions">
                  <span class="skill-count">${files.length} skills</span>
                  <label class="prism-toggle mini">
                    <input type="checkbox" class="family-toggle" data-paths='${JSON.stringify(allPaths)}' ${allEnabled ? "checked" : ""}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              <div class="skill-family-content">
                ${files.map(f => `
                  <div class="skill-item">
                    <div class="skill-item-info">
                      <div class="skill-item-name">${f.name}</div>
                    </div>
                    <label class="prism-toggle mini">
                      <input type="checkbox" class="skill-toggle" data-path="${f.path}" ${settings.isSkillEnabled(f.path) ? "checked" : ""}>
                      <span class="toggle-slider"></span>
                    </label>
                  </div>
                `).join("")}
              </div>
            </div>
          `;
        }

        skillsListEl.innerHTML = html || `<div class="empty-state">No skills matching "${filter}"</div>`;

        // Wire toggles
        skillsListEl.querySelectorAll<HTMLInputElement>(".skill-toggle").forEach(input => {
          input.addEventListener("change", () => {
            settings.setSkillEnabled(input.dataset.path!, input.checked);
          });
        });

        skillsListEl.querySelectorAll<HTMLInputElement>(".family-toggle").forEach(input => {
          input.addEventListener("change", () => {
            const paths = JSON.parse(input.dataset.paths!);
            settings.setFamilyEnabled(paths, input.checked);
            renderList(searchInput.value); // Refresh state
          });
        });
      };

      renderList();

      let searchDebounce: number | null = null;
      searchInput.addEventListener("input", (e) => {
        const nextValue = (e.target as HTMLInputElement).value;
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

    const cwd = this.activeWorkspace.getCwd();
    if (!cwd) {
      this.content.innerHTML = `
        <h2 class="settings-section-title">History</h2>
        <div class="empty-state">
          <p>Workspace unknown. Start a shell to browse history.</p>
        </div>
      `;
      return;
    }

    this.content.innerHTML = `
      <h2 class="settings-section-title">History</h2>
      <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 24px;">
        Saved conversation artifacts found in <code>.prism/</code>.
      </p>
      <div id="history-list" class="history-list">
        <div class="loading-state">Scanning .prism/ directory...</div>
      </div>
    `;

    const historyEl = document.getElementById("history-list")!;

    try {
      // List entries in .prism/ directory
      const prismPath = `${cwd}/.prism`;
      const result = await invoke<any>("list_dir_entries", { cwd: prismPath, partial: "" });
      
      const chats = (result.entries as any[]).filter(e => e.kind === "file" && e.name.endsWith(".md"));
      
      if (chats.length === 0) {
        historyEl.innerHTML = `<div class="empty-state">No saved chats found in .prism/</div>`;
        return;
      }

      // Sort by name (which usually includes timestamp) descending
      chats.sort((a, b) => b.name.localeCompare(a.name));

      historyEl.innerHTML = chats.map(c => {
        const fullPath = `${prismPath}/${c.name}`;
        return `
          <div class="history-item">
            <div class="history-info">
              <div class="history-name">${c.name}</div>
              <div class="history-meta">${fullPath}</div>
            </div>
            <button class="history-load-btn" data-path="${fullPath}">Load</button>
          </div>
        `;
      }).join("");

      // Wire load buttons
      historyEl.querySelectorAll(".history-load-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const path = (btn as HTMLElement).dataset.path!;
          const chatId = this.activeWorkspace!.getId();
          
          try {
            (btn as HTMLButtonElement).disabled = true;
            (btn as HTMLButtonElement).textContent = "Loading...";
            
            await invoke("load_chat_markdown", { chatId, path });
            
            this.close();
            // The workspace will need a way to refresh its terminal or show a "Chat Loaded" message.
            // For now, we'll assume load_chat_markdown does its job on the backend.
          } catch (err) {
            alert(`Failed to load chat: ${err}`);
            (btn as HTMLButtonElement).disabled = false;
            (btn as HTMLButtonElement).textContent = "Load";
          }
        });
      });

    } catch (err) {
      historyEl.innerHTML = `<div class="error-state">No .prism directory found in this workspace.</div>`;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
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
}
