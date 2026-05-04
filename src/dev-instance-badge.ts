/**
 * In `pnpm tauri dev`, the WebView loads `http://localhost:<port>`, so
 * `location.port` matches `PRISM_DEV_PORT`. Use that (and optional
 * VITE_PRISM_INSTANCE_ID) to label multiple local checkouts in the titlebar.
 */

const DEFAULT_DEV_PORT_LABELS: Record<string, string> = {
  "1420": "Instance 1",
  "2000": "Instance 2",
};

export function applyDevInstanceBadge(): void {
  const el = document.getElementById("titlebar-dev-instance");
  if (!el) return;

  if (!import.meta.env.DEV) {
    el.hidden = true;
    el.textContent = "";
    el.removeAttribute("aria-label");
    document.title = "PRISM by Stellarum";
    return;
  }

  const port = window.location.port;
  if (!port || window.location.hostname !== "localhost") {
    el.hidden = true;
    el.textContent = "";
    el.removeAttribute("aria-label");
    document.title = "PRISM by Stellarum";
    return;
  }

  const explicit = import.meta.env.VITE_PRISM_INSTANCE_ID?.trim();
  const label = explicit
    ? `Instance ${explicit}`
    : (DEFAULT_DEV_PORT_LABELS[port] ?? `:${port}`);

  el.textContent = label;
  el.hidden = false;
  el.setAttribute("title", `Dev server: localhost:${port}`);
  el.setAttribute("aria-label", `Development, port ${port}`);

  document.title = `PRISM by Stellarum · ${label}`;
}
