// Prism bootstrap: mount the TabManager into the DOM and either restore
// the previous session's tabs (cwd + title) from `~/.config/prism/
// session.json` or, on first launch, open a single fresh tab.

import { TabManager } from "./tabs";
import { ToolbarManager } from "./toolbar";
import { readSessionState } from "./session";
import { initUsageSync } from "./services/usage-persistence";
import { initPricing } from "./models";

window.addEventListener("DOMContentLoaded", () => {
  // Initialize Firebase usage sync and model pricing
  void initUsageSync();
  void initPricing();

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

  // Open one tab immediately so `#workspaces` is never empty while
  // `read_session_state` round-trips through Tauri. If session.json has
  // tabs, replace this bootstrap tab with the persisted set.
  tabs.newTab();

  void (async () => {
    const session = await readSessionState();
    if (session.tabs.length > 0) {
      await tabs.replaceWithPersistedTabs(session.tabs);
    }
    toolbar.updateLayoutButtons();
  })();
});
