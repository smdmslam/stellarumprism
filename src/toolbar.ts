import { TabManager } from "./tabs";
import { SettingsUI } from "./settings-ui";
import ProtocolsMenuManager from "./protocols-menu";

export interface ToolbarOptions {
  tabManager: TabManager;
}

export class ToolbarManager {
  private readonly tabs: TabManager;
  private readonly settingsUI: SettingsUI;
  private readonly protocolsMenu: ProtocolsMenuManager;

  constructor(opts: ToolbarOptions) {
    this.tabs = opts.tabManager;
    this.settingsUI = new SettingsUI();
    this.protocolsMenu = new ProtocolsMenuManager();
    this.wireButtons();
  }

  private wireButtons(): void {
    // Search + Files toolbar buttons were redundant with the input-bar
    // "/" autocomplete and the sidebar's Files tab respectively;
    // removed from index.html. Layout-toggle buttons remain.
    const settingsBtn = document.getElementById("tb-settings");

    const sidebarBtn = document.getElementById("lb-sidebar");
    const terminalBtn = document.getElementById("lb-terminal");
    const previewBtn = document.getElementById("lb-preview");
    const consoleBtn = document.getElementById("lb-console");
    const agentBtn = document.getElementById("lb-agent");
    const problemsBtn = document.getElementById("lb-problems");

    sidebarBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        activeWs.toggleSidebar();
        this.updateLayoutButtons();
      }
    });

    terminalBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        activeWs.toggleTerminal();
        this.updateLayoutButtons();
      }
    });

    previewBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        activeWs.togglePreview();
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

    agentBtn?.addEventListener("click", () => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        activeWs.toggleAgent();
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
      this.settingsUI.open(this.tabs.getActiveWorkspace());
    });

    // Wire up protocols menu
    this.protocolsMenu.onProtocolSelected((protocolId) => {
      const activeWs = this.tabs.getActiveWorkspace();
      if (activeWs) {
        // Trigger the /protocol command with the selected protocol ID
        activeWs.handleSubmit(`/protocol ${protocolId}`, { 
          intent: "command", 
          explicit: true, 
          payload: `protocol:${protocolId}` 
        });
      }
    });
  }

  public updateLayoutButtons(): void {
    const activeWs = this.tabs.getActiveWorkspace();
    if (!activeWs) return;

    const state = activeWs.getLayoutState();
    
    const sidebarBtn = document.getElementById("lb-sidebar");
    const terminalBtn = document.getElementById("lb-terminal");
    const previewBtn = document.getElementById("lb-preview");
    const consoleBtn = document.getElementById("lb-console");
    const agentBtn = document.getElementById("lb-agent");
    const problemsBtn = document.getElementById("lb-problems");

    sidebarBtn?.classList.toggle("active", state.sidebar);
    terminalBtn?.classList.toggle("active", state.terminal);
    previewBtn?.classList.toggle("active", state.preview);
    consoleBtn?.classList.toggle("active", state.console);
    agentBtn?.classList.toggle("active", state.agent);
    problemsBtn?.classList.toggle("active", state.problems);
  }
}
