// Pure helpers for the Files sidebar (IDE-shape phase 1).
//
// The Tauri command `list_directory_tree(cwd, path?)` returns one level
// of children at a time. This module owns the in-memory tree state
// (expanded paths, loaded children, selected path, errors), the
// keyboard-navigation arithmetic, and the row-flattening logic. It is
// deliberately UI-framework-agnostic: the workspace owns the DOM and
// drives this module via plain function calls so the test runner can
// import everything without dragging in Tauri or DOM.

/** One row from the backend `list_directory_tree` command. */
export interface RawTreeEntry {
  name: string;
  /** Absolute path on disk. */
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  /** Bytes; only set for files. */
  size?: number | null;
  /** True iff this is a dir whose children weren't listed yet. */
  has_children: boolean;
}

/** Backend response shape. Mirrors `TreeListing` in Rust. */
export interface RawTreeListing {
  /** Absolute path of the listed directory. */
  dir: string;
  entries: RawTreeEntry[];
  truncated: boolean;
  /** True iff dir == cwd (for root decoration). */
  is_root: boolean;
}

/**
 * In-memory state of the tree. Keyed on absolute paths (the same
 * `path` field the backend hands us). `roots` is the cwd's children
 * \u2014 we don't model the cwd itself as a row, just expand into it.
 * Children are stored separately so an unloaded dir doesn't waste
 * space allocating an empty array.
 */
export interface TreeState {
  /** cwd's listing (the top-level rows). */
  root: RawTreeListing | null;
  /** Loaded children by parent absolute path. */
  childrenByPath: Map<string, RawTreeListing>;
  /** Set of absolute paths that are currently expanded. */
  expanded: Set<string>;
  /** Per-path load state for spinners + error rendering. */
  loadStateByPath: Map<string, LoadState>;
  /** Currently selected absolute path (single-select v1). */
  selected: string | null;
}

export type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded" }
  | { kind: "error"; message: string };

/** Build an empty tree state (caller calls `setRoot` once cwd is known). */
export function emptyTreeState(): TreeState {
  return {
    root: null,
    childrenByPath: new Map(),
    expanded: new Set(),
    loadStateByPath: new Map(),
    selected: null,
  };
}

/**
 * One row in the rendered tree, after flattening visible nodes. The
 * UI layer maps these 1:1 to DOM rows; keyboard nav indexes into this
 * list.
 */
export interface VisibleRow {
  entry: RawTreeEntry;
  /** 0 for cwd's direct children; +1 for each level deeper. */
  depth: number;
  /** True iff this dir is in `expanded`. False for files. */
  expanded: boolean;
  /** Mirror of `state.loadStateByPath.get(entry.path)`. */
  loadState: LoadState;
}

/**
 * Walk the tree depth-first and return the rows the UI should render.
 * A dir contributes its own row, then \u2014 if expanded and loaded \u2014 its
 * children's rows in their backend-supplied order. Loading and error
 * states surface to the UI via each row's `loadState`.
 */
export function flattenVisibleRows(state: TreeState): VisibleRow[] {
  const out: VisibleRow[] = [];
  if (!state.root) return out;
  walk(state, state.root.entries, 0, out);
  return out;
}

function walk(
  state: TreeState,
  entries: RawTreeEntry[],
  depth: number,
  out: VisibleRow[],
): void {
  for (const e of entries) {
    const expanded = state.expanded.has(e.path);
    const loadState =
      state.loadStateByPath.get(e.path) ?? { kind: "idle" };
    out.push({ entry: e, depth, expanded, loadState });
    if (expanded && e.kind === "dir") {
      const child = state.childrenByPath.get(e.path);
      if (child) {
        walk(state, child.entries, depth + 1, out);
      }
    }
  }
}

/** Set / replace the cwd's listing. Resets transient state. */
export function setRoot(state: TreeState, listing: RawTreeListing): TreeState {
  return {
    ...state,
    root: listing,
    // Drop loaded subtrees that don't match the new root's cwd. We
    // keep the expanded set so the UI can re-load and re-expand on
    // refresh, but reset childrenByPath because the on-disk shape
    // may have shifted.
    childrenByPath: new Map(),
    loadStateByPath: new Map(),
  };
}

/**
 * Toggle a directory's expansion state. Returns the new state and a
 * `needsLoad` flag: when true, the caller must invoke
 * `list_directory_tree` and feed the result back via `setChildren`.
 */
export function toggleExpanded(
  state: TreeState,
  path: string,
  isDir: boolean,
): { state: TreeState; needsLoad: boolean } {
  if (!isDir) {
    return { state, needsLoad: false };
  }
  const expanded = new Set(state.expanded);
  let needsLoad = false;
  if (expanded.has(path)) {
    expanded.delete(path);
  } else {
    expanded.add(path);
    if (!state.childrenByPath.has(path)) {
      needsLoad = true;
    }
  }
  return { state: { ...state, expanded }, needsLoad };
}

/**
 * Mark a path as loading. The UI shows a spinner row under the parent
 * until `setChildren` or `setError` clears the state.
 */
export function setLoading(state: TreeState, path: string): TreeState {
  const next = new Map(state.loadStateByPath);
  next.set(path, { kind: "loading" });
  return { ...state, loadStateByPath: next };
}

/** Install a freshly-loaded sub-listing. */
export function setChildren(
  state: TreeState,
  path: string,
  listing: RawTreeListing,
): TreeState {
  const children = new Map(state.childrenByPath);
  children.set(path, listing);
  const loadStates = new Map(state.loadStateByPath);
  loadStates.set(path, { kind: "loaded" });
  return {
    ...state,
    childrenByPath: children,
    loadStateByPath: loadStates,
  };
}

/** Mark a path as failed-to-load with a message the UI can render. */
export function setError(
  state: TreeState,
  path: string,
  message: string,
): TreeState {
  const loadStates = new Map(state.loadStateByPath);
  loadStates.set(path, { kind: "error", message });
  return { ...state, loadStateByPath: loadStates };
}

/** Single-select: set or clear the selected path. */
export function setSelected(
  state: TreeState,
  path: string | null,
): TreeState {
  return { ...state, selected: path };
}

/**
 * Return the index in `flattenVisibleRows(state)` of the currently
 * selected path, or -1 when nothing is selected (or the selection
 * is no longer visible due to a parent collapse).
 */
export function selectedIndex(
  state: TreeState,
  rows: VisibleRow[],
): number {
  if (!state.selected) return -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].entry.path === state.selected) return i;
  }
  return -1;
}

/**
 * Move the keyboard selection by `delta` rows (+1 = down, -1 = up).
 * Wraps at neither end \u2014 the caller can decide whether to jump to
 * top/bottom on overshoot. Returns the new selected path (or null
 * when there are no visible rows).
 */
export function moveSelection(
  state: TreeState,
  rows: VisibleRow[],
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const cur = selectedIndex(state, rows);
  // -1 + delta=+1 should land on row 0; -1 + delta=-1 stays at -1.
  let next: number;
  if (cur < 0) {
    next = delta > 0 ? 0 : rows.length - 1;
  } else {
    next = Math.max(0, Math.min(rows.length - 1, cur + delta));
  }
  return rows[next].entry.path;
}

/**
 * Format a byte count for the tooltip / detail column. Same scale as
 * the existing `format_bytes` Rust helper but in pure JS for the UI.
 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
