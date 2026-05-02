/**
 * UI Controller for the Settings Overlay.
 */

import { settings } from "./settings";
import { MODEL_LIBRARY, compareModelsByCostDesc } from "./models";
import { invoke } from "@tauri-apps/api/core";
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
        <label class="settings-group-title">Agent Verification</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 12px;">
          Auto Verify still grounds inspectable factual prompts. Always Verify forces grounded instructions and the verifier pass on every agent turn.
        </p>
        <div class="model-setting-card">
          <div class="model-setting-info">
            <div class="model-setting-name">Always Verify</div>
            <div class="model-setting-desc">Default on. Turn off to use Auto Verify for lower latency while keeping factual prompts grounded.</div>
          </div>
          <label class="prism-toggle">
            <input type="checkbox" id="setting-strict-mode" ${settings.getStrictMode() ? "checked" : ""}>
            <span class="toggle-slider"></span>
          </label>
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
      settings.setStrictMode(strictInput.checked);
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

    html += models.map(m => {
      // Pair the registry default with the user override so a model
      // shipped `enabled: false` reads as off on first run, even when
      // the user has never opened settings before.
      const isEnabled = settings.isModelEnabled(m.slug, m.enabled !== false);
      const tierLabel = m.tier === "main" ? "Main" : "Explore";

      return `
        <div class="model-setting-card">
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

    html += `</div>`;
    this.content.innerHTML = html;

    // Wire the master toggle. On flip, bulk-update all per-slug
    // overrides via the dedicated helper (one localStorage write,
    // one settings-changed event), then re-render so the individual
    // toggles below reflect the new state without flicker.
    const masterToggle = this.content.querySelector<HTMLInputElement>("#all-models-toggle");
    masterToggle?.addEventListener("change", () => {
      const slugs = models.map(m => m.slug);
      settings.setAllModelsEnabled(slugs, masterToggle.checked);
      this.renderModels();
    });

    // Wire per-model toggles. Each individual change might invalidate
    // the master's aggregate state (e.g. user flips one off when all
    // were on \u2192 master should now read OFF), so we re-render after
    // every change so the master stays honest.
    this.content.querySelectorAll<HTMLInputElement>("input[data-slug]").forEach(input => {
      input.addEventListener("change", () => {
        settings.setModelEnabled(input.dataset.slug!, input.checked);
        this.renderModels();
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
      const skillsPath = `${cwd}/.prism/skills`;
      const result = await invoke<any>("list_dir_entries", { cwd: skillsPath, partial: "" });
      const entries = result.entries as any[];
      const skillFiles = entries.filter(e => e.kind === "file" && e.name.endsWith(".md"));

      if (skillFiles.length === 0) {
        skillsListEl.innerHTML = `<div class="empty-state">No skills found in .prism/skills/</div>`;
        return;
      }

      // Grouping logic: Root files in "Other", subdirectories as Families
      const families: Record<string, SkillFileEntry[]> = {};
      const familyNames = ["Other"];

      const rootFiles = entries.filter(e => e.kind === "file" && e.name.endsWith(".md"));
      if (rootFiles.length > 0) {
        families["Other"] = rootFiles.map(f => ({ name: f.name, path: `${skillsPath}/${f.name}` }));
      }

      for (const entry of entries) {
        if (entry.kind === "dir") {
          familyNames.push(entry.name);
          const subResult = await invoke<any>("list_dir_entries", { cwd: `${skillsPath}/${entry.name}`, partial: "" });
          const subFiles = (subResult.entries as any[]).filter(e => e.kind === "file" && e.name.endsWith(".md"));
          if (subFiles.length > 0) {
            families[entry.name] = subFiles.map(f => ({ name: f.name, path: `${skillsPath}/${entry.name}/${f.name}` }));
          }
        }
      }

      const renderList = (filter = "") => {
        const filteredFamilies = filterSkillFamilies(families, filter);
        let html = "";

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
                          const displayName = f.name.replace(".md", "");
                          return `
                            <div class="skill-item">
                              <div class="skill-item-info">
                                <div class="skill-item-name">${escapeHtml(displayName)}</div>
                              </div>
                              <div class="skill-item-controls">
                                <label class="prism-toggle mini">
                                  <input type="checkbox" class="skill-toggle" data-path="${escapeHtml(f.path)}" ${settings.isSkillEnabled(f.path) ? "checked" : ""}>
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
          const allPaths = files.map(f => f.path);
          const allEnabled = files.length > 0 && files.every(f => settings.isSkillEnabled(f.path));
          
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
                  const displayName = f.name.replace(".md", "");
                  return `
                    <div class="skill-item">
                      <div class="skill-item-info">
                        <div class="skill-item-name">${displayName}</div>
                      </div>
                      <div class="skill-item-controls">
                        <select class="skill-move-select" data-path="${f.path}" data-current="${familyName}">
                          ${familyNames.map(name => `<option value="${name}" ${name === familyName ? "selected" : ""}>Move to ${name}</option>`).join("")}
                        </select>
                        <label class="prism-toggle mini">
                          <input type="checkbox" class="skill-toggle" data-path="${f.path}" ${settings.isSkillEnabled(f.path) ? "checked" : ""}>
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
              <div class="history-name">${escapeHtml(c.name)}</div>
              <div class="history-meta">${escapeHtml(fullPath)}</div>
            </div>
            <button class="history-load-btn" data-path="${escapeHtml(fullPath)}">Load</button>
          </div>
        `;
      }).join("");

      // Wire load buttons. Routes through Workspace.loadSavedChat()
      // (the same code path /load uses) so the active tab refreshes its
      // model badge, adopts the saved title, prints the [load]
      // confirmation in xterm, and offers transcript replay. Without
      // this, a Load click would seed the backend session but leave
      // the user staring at an unchanged terminal \u2014 the \"did anything
      // happen?\" gap the original code's TODO comment named.
      historyEl.querySelectorAll(".history-load-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const path = (btn as HTMLElement).dataset.path!;
          const ws = this.activeWorkspace;
          if (!ws) return;

          try {
            (btn as HTMLButtonElement).disabled = true;
            (btn as HTMLButtonElement).textContent = "Loading...";
            this.close();
            // loadSavedChat handles invoke + agent.refreshSession +
            // title adoption + xterm feedback + transcript-replay
            // prompt. Same surface as /load.
            await ws.loadSavedChat(path);
          } catch (err) {
            // Fallback only \u2014 loadSavedChat catches its own errors and
            // writes them to xterm, so this branch is essentially
            // unreachable. Kept defensively.
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
        Track your AI consumption and estimated costs. Data is updated after every agent turn.
      </p>
      <div id="usage-container" class="usage-container">
        <div class="loading-state">Loading usage summary...</div>
      </div>
    `;

    const container = document.getElementById("usage-container")!;
    try {
      // Use the active workspace's chat_id if available, otherwise null (aggregate only)
      const chatId = this.activeWorkspace?.id || null;
      const summary = await invoke<{
        session_tokens: number;
        session_cost_usd: number;
        today_tokens: number;
        today_cost_usd: number;
        by_model: { model: string; tokens: number; cost_usd: number }[];
      }>("get_usage_summary", { chatId });

      const subInfo = await invoke<{ 
        tier: string;
        balance_usd: number;
        total_real_cost_usd: number;
      }>("get_subscription_info");
      const isPro = subInfo.tier === "Pro";

      const formatCost = (c: number) => `$${c.toFixed(3)}`;
      const formatCredits = (c: number) => `$${c.toFixed(2)}`;
      const formatTokens = (t: number) =>
        t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t.toString();

      let html = `
        <div class="usage-stats-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 32px;">
          <div class="usage-stat-card" style="background: #111827; border: 1px solid #374151; padding: 16px; border-radius: 8px;">
            <div style="font-size: 10px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.05em; margin-bottom: 4px;">Credit Balance</div>
            <div style="font-size: 24px; font-weight: 600; color: ${subInfo.balance_usd > 0 ? "#10b981" : "#ef4444"}; margin-bottom: 4px;">${formatCredits(subInfo.balance_usd)}</div>
            <div style="font-size: 12px; color: #94a3b8;">${isPro ? "Unlimited (Pro)" : "Pay-as-you-go"}</div>
          </div>
          <div class="usage-stat-card" style="background: #111827; border: 1px solid #374151; padding: 16px; border-radius: 8px;">
            <div style="font-size: 10px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.05em; margin-bottom: 4px;">Lifetime Spend (Real Cost)</div>
            <div style="font-size: 24px; font-weight: 600; color: #e5e7eb; margin-bottom: 4px;">${formatCost(subInfo.total_real_cost_usd)}</div>
            <div style="font-size: 12px; color: #94a3b8;">Actual provider cost</div>
          </div>
        </div>

        <h3 style="font-size: 13px; font-weight: 600; color: #e5e7eb; margin-bottom: 12px;">Breakdown by Model (20x Credits)</h3>
        <div class="usage-table-wrapper" style="background: #111827; border: 1px solid #374151; border-radius: 8px; overflow: hidden;">
          <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;">
            <thead>
              <tr style="border-bottom: 1px solid #374151; background: #1f2937;">
                <th style="padding: 10px 16px; color: #94a3b8; font-weight: 500;">Model</th>
                <th style="padding: 10px 16px; color: #94a3b8; font-weight: 500; text-align: right;">Tokens</th>
                <th style="padding: 10px 16px; color: #94a3b8; font-weight: 500; text-align: right;">Credit Cost</th>
              </tr>
            </thead>
            <tbody>
      `;

      if (summary.by_model.length === 0) {
        html += `
          <tr>
            <td colspan="3" style="padding: 24px; text-align: center; color: #6b7280; font-style: italic;">No usage recorded yet.</td>
          </tr>
        `;
      } else {
        for (const m of summary.by_model) {
          const modelName = m.model.split("/").pop() || m.model;
          html += `
            <tr style="border-bottom: 1px solid #1f2937;">
              <td style="padding: 10px 16px; color: #e5e7eb; font-family: ui-monospace, monospace;">${escapeHtml(modelName)}</td>
              <td style="padding: 10px 16px; color: #e5e7eb; text-align: right; font-weight: 500;">${formatTokens(m.tokens)}</td>
              <td style="padding: 10px 16px; color: #10b981; text-align: right; font-weight: 500;">${formatCredits(m.cost_usd * 20.0)}</td>
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

        <p style="font-size: 10px; color: #6b7280; margin-top: 16px; line-height: 1.4;">
          * Credit cost is calculated as actual AI provider cost \u00d7 20. This covers platform overhead, infrastructure, and development.
        </p>
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
            alert("Success! You are now on the Pro plan with unlimited token capacity.");
            this.renderUsage(); // Refresh UI
          } catch (e) {
            alert(`Upgrade failed: ${e}`);
            upgradeBtn.disabled = false;
            upgradeBtn.textContent = "Upgrade to Pro";
          }
        });
      }
    } catch (e) {
      container.innerHTML = `<div class="error-state">Failed to load usage data: ${escapeHtml(String(e))}</div>`;
    }
  }
}
