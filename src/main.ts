// Prism bootstrap: mount the TabManager into the DOM and either restore
// the previous session's tabs (cwd + title) from `~/.config/prism/
// session.json` or, on first launch, open a single fresh tab.

import { TabManager } from "./tabs";
import { ToolbarManager } from "./toolbar";
import { readSessionState } from "./session";

window.addEventListener("DOMContentLoaded", () => {
  const tabStrip = document.getElementById("tab-strip");
  const workspacesParent = document.getElementById("workspaces");
  if (!tabStrip || !workspacesParent) {
    console.error("Prism bootstrap: required DOM elements not found");
    return;
  }

  const tabs = new TabManager({
    tabStripEl: tabStrip,
    workspacesParent: workspacesParent,
    onSelectTab: () => {
      toolbar.updateLayoutButtons();
    },
  });

  // Global toolbar controller.
  const toolbar = new ToolbarManager({ tabManager: tabs });

  // Session restore. Read once at startup; if any tabs are persisted,
  // rehydrate each in its saved cwd. Otherwise (first launch, missing
  // file, parse error, or zero saved tabs) fall back to the original
  // "open a single fresh tab" behavior so we never leave the user
  // staring at an empty workspace.
  void (async () => {
    const session = await readSessionState();
    if (session.tabs.length === 0) {
      tabs.newTab();
      return;
    }
    for (const t of session.tabs) {
      tabs.newTab({
        id: t.id,
        cwd: t.cwd,
        title: t.title,
        sidebarVisible: t.sidebar_visible,
        previewVisible: t.preview_visible,
        terminalVisible: t.terminal_visible,
        consoleVisible: t.console_visible,
        agentVisible: t.agent_visible,
      });
    }
  })();
});
