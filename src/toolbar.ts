import { TabManager } from "./tabs";
import { SettingsUI } from "./settings-ui";

export interface ToolbarOptions {
  tabManager: TabManager;
}

export class ToolbarManager {
  private readonly tabs: TabManager;
  private readonly settingsUI: SettingsUI;

  constructor(opts: ToolbarOptions) {
    this.tabs = opts.tabManager;
    this.settingsUI = new SettingsUI();
    this.wireButtons();
  }

  private wireButtons(): void {
    const searchBtn = document.getElementById("tb-search");
    const filesBtn = document.getElementById("tb-files");
    const settingsBtn = document.getElementById("tb-settings");

    const sidebarBtn = document.getElementById("lb-sidebar");
    const consoleBtn = document.getElementById("lb-console");
    const problemsBtn = document.getElementById("lb-problems");

    searchBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) activeWs.focusInput("/");
    });

    filesBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) activeWs.setSidebarTab("files");
    });

    sidebarBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        activeWs.toggleSidebar();
        this.updateLayoutButtons();
      }
    });

    consoleBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        activeWs.toggleConsole();
        this.updateLayoutButtons();
      }
    });

    problemsBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        activeWs.toggleProblems();
        this.updateLayoutButtons();
      }
    });

    settingsBtn?.addEventListener("click", () => {
      this.settingsUI.open();
    });
  }

  public updateLayoutButtons(): void {
    const activeWs = this.tabs.getActiveWorkspace();
    if (!activeWs) return;

    const state = activeWs.getLayoutState();
    
    const sidebarBtn = document.getElementById("lb-sidebar");
    const consoleBtn = document.getElementById("lb-console");
    const problemsBtn = document.getElementById("lb-problems");

    sidebarBtn?.classList.toggle("active", state.sidebar);
    consoleBtn?.classList.toggle("active", state.console);
    problemsBtn?.classList.toggle("active", state.problems);
  }
}
