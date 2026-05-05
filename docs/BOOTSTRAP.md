# Shell bootstrap (desktop UI)

This note exists so we **do not regress** into a “blank window”: chrome visible, **no tabs**, **no `#workspaces` children**, sometimes only the **“+”** button.

## What went wrong (historical)

1. **Throwing during ES module evaluation** — Anything that runs at **import time** (top-level `new …`, `initializeApp()`, `localStorage`, DOM queries) happens **before** `DOMContentLoaded`. One thrown exception prevents **`main.ts` from running at all**. Static HTML still paints (“Substrate ready”, toolbar), so it looks like the app loaded.

2. **`ToolbarManager` before the first tab** — Building settings/toolbar **before** `tabs.newTab()` meant a constructor failure **skipped mounting any workspace**.

3. **`ReaderUI` at module scope** — `export const readerUI = new ReaderUI()` ran while importing `workspace.ts`, possibly **before** the reader DOM existed or **before** buttons could be wired → instant throw.

4. **Firebase** — `initializeApp` / `getFirestore` / `getAuth` must not abort the bundle when env vars are missing or the network stack disagrees.

5. **`localStorage`** — In some WebViews or privacy modes, **`localStorage` throws**. `SettingsManager` runs at import time via `export const settings = …`; reads/writes must be **try/catch** wrapped.

6. **Session layout** — Persisted “hide everything” layout flags could make the main surface look empty (addressed in `Workspace.ensureMinimumVisibleLayout`).

## Invariants (do not break these)

| Rule | Why |
|------|-----|
| **No eager UI singletons** that touch `document` or `localStorage` at module load | Import graph must not throw |
| **`ReaderUI`**: only construct inside **`getReaderUI()`**, never `export const … = new ReaderUI()` | Lazy init after DOM exists |
| **`tabs.newTab()`** runs **before** `ToolbarManager` | Toolbar/settings must not block first workspace |
| **`window.__PRISM_MOUNTED`** set only after the first `newTab()` succeeds | Lets `index.html` detect a dead bootstrap |
| **`settings`**: wrap **all** `localStorage` access | Storage may be blocked |
| **`firebase.ts`**: isolate Firebase init; **`usage-persistence`** no-ops if `db`/`auth` is null | Usage sync is optional |

## Automated check

From the repo root:

```bash
pnpm check:bootstrap
```

Run this in CI alongside `pnpm test` before merging UI bootstrap or heavy `settings`/Firebase changes.

## Manual verify

After UI changes: `pnpm tauri dev` → confirm a tab appears and the main area is not solid black. If not, open Web Inspector → **Console** (import errors show there before our inline hints).
