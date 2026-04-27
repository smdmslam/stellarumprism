// Session restore: thin TS bridge to the Rust-side `read_session_state`
// and `write_session_state` Tauri commands. Centralizing the wire shape
// here keeps `main.ts` and `tabs.ts` from each duplicating the
// invoke + type plumbing.

import { invoke } from "@tauri-apps/api/core";

/** One persisted tab record. Mirrors `session.rs::PersistedTab`. */
export interface PersistedTab {
  /** Stable identifier across launches. */
  id: string;
  /** Last-known cwd from OSC 7. Empty when never resolved. */
  cwd: string;
  /** Auto-derived display title for the tab strip. */
  title: string;
}

/** Wire-shape returned by `read_session_state`. */
export interface SessionState {
  tabs: PersistedTab[];
}

/**
 * Read the persisted tab list. Returns an empty list on first launch,
 * missing/corrupt session.json, or any I/O hiccup — the Rust side
 * collapses every failure to "no tabs" so callers don't need a
 * try/catch. Worst case is a single fresh tab; never a crash.
 */
export async function readSessionState(): Promise<SessionState> {
  try {
    return await invoke<SessionState>("read_session_state");
  } catch (err) {
    // Defense-in-depth: invoke itself can throw if the command isn't
    // registered (e.g. running against an older Tauri build during
    // development). Empty list = the same "first launch" path.
    console.warn("readSessionState invoke failed:", err);
    return { tabs: [] };
  }
}

/**
 * Persist the current tabs list. Best-effort; failure logs to the
 * console rather than alerting the user. Restore state is a quality-
 * of-life feature, not a correctness one — a missing session.json
 * just means you'll cd into your project once instead of zero times
 * on next launch.
 */
export async function writeSessionState(tabs: PersistedTab[]): Promise<void> {
  try {
    await invoke("write_session_state", { tabs });
  } catch (err) {
    console.warn("writeSessionState invoke failed:", err);
  }
}
