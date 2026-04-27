// Prism bootstrap: mount the TabManager into the DOM and open one tab.

import { TabManager } from "./tabs";
import { ToolbarManager } from "./toolbar";

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

  // Open a first tab so there's always something to look at.
  tabs.newTab();
});
