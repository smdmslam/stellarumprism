/**
 * UI Controller for the Settings Overlay.
 */

import { settings } from "./settings";
import { MODEL_LIBRARY } from "./models";

export class SettingsUI {
  private readonly overlay: HTMLElement;
  private readonly content: HTMLElement;
  private currentTab = "general";

  constructor() {
    this.overlay = document.getElementById("settings-overlay")!;
    this.content = document.getElementById("settings-content")!;
    this.wireEvents();
  }

  public open(): void {
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

  private switchTab(tab: string): void {
    this.currentTab = tab;
    const items = this.overlay.querySelectorAll(".settings-nav-item");
    items.forEach(i => i.classList.toggle("active", (i as HTMLElement).dataset.tab === tab));
    this.render();
  }

  private render(): void {
    switch (this.currentTab) {
      case "general":
        this.renderGeneral();
        break;
      case "models":
        this.renderModels();
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
    this.content.innerHTML = `
      <h2 class="settings-section-title">General Settings</h2>
      <div class="settings-group">
        <label class="settings-group-title">Editor Appearance</label>
        <p class="settings-group-desc" style="font-size: 11px; color: #6b7280; margin-bottom: 12px;">
          Configure how the Prism core workspace feels.
        </p>
        <!-- Placeholders for more settings -->
        <div style="color: #4b5563; font-size: 12px; font-style: italic;">
          More controls coming soon (Font, Spacing, Tab width).
        </div>
      </div>
    `;
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

  private renderSubstrate(): void {
    this.content.innerHTML = `
      <h2 class="settings-section-title">Substrate Configuration</h2>
      <div class="settings-group">
        <p style="color: #6b7280; font-size: 12px;">
          Advanced settings for the code analysis engine and local grounding.
        </p>
      </div>
    `;
  }

  private renderAbout(): void {
    this.content.innerHTML = `
      <h2 class="settings-section-title">About PRISM</h2>
      <div class="settings-group">
        <p style="color: #e5e7eb; font-size: 13px; font-weight: 600;">PRISM by Stellarum</p>
        <p style="color: #6b7280; font-size: 11px;">Version 2.0.4 - Catalyst Edition</p>
        <p style="margin-top: 16px; color: #94a3b8; font-size: 12px; line-height: 1.5;">
          A high-performance agentic workstation designed for the modern developer. 
          Built with speed, precision, and substrate-awareness.
        </p>
      </div>
    `;
  }
}
