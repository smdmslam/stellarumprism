// Prism bootstrap: mount the TabManager into the DOM and either restore
// the previous session's tabs (cwd + title) from `~/.config/prism/
// session.json` or, on first launch, open a single fresh tab.
//
// Startup order and import-time rules are documented in docs/BOOTSTRAP.md.
// Run `pnpm check:bootstrap` in CI to catch banned patterns (e.g. eager ReaderUI).

import { TabManager } from "./tabs";
import { ToolbarManager } from "./toolbar";
import { readSessionState } from "./session";
import { initUsageSync } from "./services/usage-persistence";
import { initPricing } from "./models";
import { applyDevInstanceBadge } from "./dev-instance-badge";

declare global {
  interface Window {
    __PRISM_MOUNTED?: boolean;
  }
}

function showFatalBootstrapError(err: unknown): void {
  console.error("Prism bootstrap fatal:", err);
  const parent = document.getElementById("workspaces");
  const lines =
    err instanceof Error
      ? `${err.message}\n\n${err.stack ?? ""}`
      : String(err);
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.style.cssText =
    "box-sizing:border-box;margin:16px;padding:20px 24px;border:1px solid #f87171;border-radius:12px;background:#1a0a0a;color:#fecaca;font:13px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;max-width:48rem;";
  panel.textContent =
    "Prism could not start the workspace UI.\n\n" + lines;
  if (parent) {
    parent.innerHTML = "";
    parent.appendChild(panel);
  } else {
    document.body.appendChild(panel);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  try {
    applyDevInstanceBadge();

    void initUsageSync().catch((e) =>
      console.warn("initUsageSync:", e),
    );
    void initPricing().catch((e) => console.warn("initPricing:", e));

    const tabStrip = document.getElementById("tab-strip");
    const workspacesParent = document.getElementById("workspaces");
    if (!tabStrip || !workspacesParent) {
      console.error("Prism bootstrap: required DOM elements not found");
      return;
    }

    let toolbar: ToolbarManager | null = null;

    const tabs = new TabManager({
      tabStripEl: tabStrip,
      workspacesParent: workspacesParent,
      onSelectTab: () => {
        toolbar?.updateLayoutButtons();
      },
    });

    tabs.newTab();
    window.__PRISM_MOUNTED = true;

    try {
      toolbar = new ToolbarManager({ tabManager: tabs });
    } catch (err) {
      console.error("Prism bootstrap: toolbar failed to initialize", err);
    }

    toolbar?.updateLayoutButtons();

    void (async () => {
      try {
        const session = await readSessionState();
        if (session.tabs.length > 0) {
          await tabs.replaceWithPersistedTabs(session.tabs);
        }
      } catch (err) {
        console.warn("Session restore failed:", err);
      } finally {
        tabs.ensureAtLeastOneTab();
        tabs.reconcileActiveWorkspace();
      }
      toolbar?.updateLayoutButtons();
      requestAnimationFrame(() => {
        tabs.ensureAtLeastOneTab();
        tabs.reconcileActiveWorkspace();
        toolbar?.updateLayoutButtons();
      });
    })().catch((err) => {
      console.error("Session restore task:", err);
    });
  } catch (err) {
    showFatalBootstrapError(err);
  }
});
