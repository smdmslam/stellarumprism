import { TabManager } from "./tabs";

export interface ToolbarOptions {
  tabManager: TabManager;
}

export class ToolbarManager {
  private readonly tabs: TabManager;

  constructor(opts: ToolbarOptions) {
    this.tabs = opts.tabManager;
    this.wireButtons();
  }

  private wireButtons(): void {
    const searchBtn = document.getElementById("tb-search");
    const filesBtn = document.getElementById("tb-files");
    const settingsBtn = document.getElementById("tb-settings");

    searchBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        // Trigger a fake search by focusing input with '/'
        activeWs.focusInput("/");
      }
    });

    filesBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        activeWs.setSidebarTab("files");
      }
    });

    settingsBtn?.addEventListener("click", () => {
      alert("Settings modal coming soon in the next prism iteration.");
    });
  }
}
