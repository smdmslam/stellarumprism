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
  /** UNIX epoch seconds; only set for files. */
  mtime_secs?: number | null;
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
  /** Primary selected path (keyboard focus anchor). */
  selected: string | null;
  /** Set of all selected absolute paths (multi-select). */
  selection: Set<string>;
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
    selection: new Set(),
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
  /** True iff this path is in `state.selection`. */
  selected: boolean;
  /** True iff this path is `state.selected` (primary focus). */
  active: boolean;
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
    out.push({
      entry: e,
      depth,
      expanded,
      loadState,
      selected: state.selection.has(e.path),
      active: state.selected === e.path,
    });
    if (expanded && e.kind === "dir") {
      const child = state.childrenByPath.get(e.path);
      if (child) {
        walk(state, child.entries, depth + 1, out);
      }
    }
  }
}

/** Set / replace the cwd's listing. */
export function setRoot(state: TreeState, listing: RawTreeListing): TreeState {
  const sameCwd = state.root?.dir === listing.dir;
  return {
    ...state,
    root: listing,
    childrenByPath: sameCwd ? state.childrenByPath : new Map(),
    loadStateByPath: sameCwd ? state.loadStateByPath : new Map(),
    selection: sameCwd ? state.selection : new Set(),
    selected: sameCwd ? state.selected : null,
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

/**
 * Remove one or more absolute paths from the tree state. Returns the
 * updated state without performing disk I/O. Use this to immediately
 * reflect a deletion in the UI while keeping the rest of the tree's
 * expansion and load state intact.
 */
export function removePathsFromTree(
  state: TreeState,
  paths: string[],
): TreeState {
  const pathSet = new Set(paths);

  // 1. Update root entries if they contain any of the deleted paths.
  let root = state.root;
  if (root) {
    const entries = root.entries.filter((e) => !pathSet.has(e.path));
    if (entries.length !== root.entries.length) {
      root = { ...root, entries };
    }
  }

  // 2. Update child listings.
  const childrenByPath = new Map(state.childrenByPath);
  for (const path of paths) {
    childrenByPath.delete(path);
  }
  // Also filter entries in any other loaded subtrees.
  for (const [parentPath, listing] of childrenByPath.entries()) {
    const entries = listing.entries.filter((e) => !pathSet.has(e.path));
    if (entries.length !== listing.entries.length) {
      childrenByPath.set(parentPath, { ...listing, entries });
    }
  }

  // 3. Clean up metadata / transient state.
  const loadStateByPath = new Map(state.loadStateByPath);
  const expanded = new Set(state.expanded);
  const selection = new Set(state.selection);
  let selected = state.selected;

  for (const path of paths) {
    loadStateByPath.delete(path);
    expanded.delete(path);
    selection.delete(path);
    if (selected === path) selected = null;
  }

  return {
    ...state,
    root,
    childrenByPath,
    loadStateByPath,
    expanded,
    selection,
    selected,
  };
}

/**
 * Rename a path in the tree state. If `oldPath` is a directory, all
 * nested entries in the cache are also migrated to the new path prefix.
 * Returns the updated state without disk I/O.
 */
export function renamePathInTree(
  state: TreeState,
  oldPath: string,
  newPath: string,
): TreeState {
  const migrate = (p: string) => {
    if (p === oldPath) return newPath;
    if (p.startsWith(oldPath + "/")) {
      return newPath + p.substring(oldPath.length);
    }
    return p;
  };

  // 1. Update root entries.
  let root = state.root;
  if (root) {
    const entries = root.entries.map((e) => ({
      ...e,
      path: migrate(e.path),
    }));
    root = { ...root, entries };
  }

  // 2. Update child listings.
  const childrenByPath = new Map<string, RawTreeListing>();
  for (const [p, listing] of state.childrenByPath.entries()) {
    const newP = migrate(p);
    const entries = listing.entries.map((e) => ({
      ...e,
      path: migrate(e.path),
    }));
    childrenByPath.set(newP, { ...listing, dir: newP, entries });
  }

  // 3. Update transient state.
  const loadStateByPath = new Map<string, LoadState>();
  for (const [p, s] of state.loadStateByPath.entries()) {
    loadStateByPath.set(migrate(p), s);
  }

  const expanded = new Set<string>();
  for (const p of state.expanded) {
    expanded.add(migrate(p));
  }

  const selection = new Set<string>();
  for (const p of state.selection) {
    selection.add(migrate(p));
  }

  let selected = state.selected;
  if (selected) selected = migrate(selected);

  return {
    ...state,
    root,
    childrenByPath,
    loadStateByPath,
    expanded,
    selection,
    selected,
  };
}

/** Set the primary selected path (focus anchor). */
export function setSelected(state: TreeState, path: string | null): TreeState {
  return { ...state, selected: path, selection: new Set(path ? [path] : []) };
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

/**
 * Selection update: single, toggle, or range.
 * - `toggle`: Add/remove from set without clearing others.
 * - `range`: Select everything between `state.selected` and `path`.
 * - Default: Clear set, add only `path`.
 */
export function updateSelection(
  state: TreeState,
  rows: VisibleRow[],
  path: string,
  mode: "single" | "toggle" | "range" = "single",
): TreeState {
  let selection = new Set(state.selection);
  if (mode === "toggle") {
    if (selection.has(path)) selection.delete(path);
    else selection.add(path);
  } else if (mode === "range" && state.selected && state.selected !== path) {
    const startIdx = rows.findIndex((r) => r.entry.path === state.selected);
    const endIdx = rows.findIndex((r) => r.entry.path === path);
    if (startIdx >= 0 && endIdx >= 0) {
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      for (let i = lo; i <= hi; i++) {
        selection.add(rows[i].entry.path);
      }
    } else {
      selection = new Set([path]);
    }
  } else {
    selection = new Set([path]);
  }
  return { ...state, selected: path, selection };
}

/** Clear all selection. */
export function clearSelection(state: TreeState): TreeState {
  return { ...state, selected: null, selection: new Set() };
}

/**
 * Return the index in `rows` of the primary selected path (the focus
 * anchor), or -1 when nothing is selected.
 */
export function selectedIndex(
  state: TreeState,
  rows: VisibleRow[],
): number {
  if (!state.selected) return -1;
  return rows.findIndex((r) => r.entry.path === state.selected);
}

/**
 * Move the keyboard selection by `delta` rows (+1 = down, -1 = up).
 * Returns the new selected path (anchor) or null when empty.
 */
export function moveSelection(
  state: TreeState,
  rows: VisibleRow[],
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const cur = selectedIndex(state, rows);
  let next: number;
  if (cur < 0) {
    next = delta > 0 ? 0 : rows.length - 1;
  } else {
    next = Math.max(0, Math.min(rows.length - 1, cur + delta));
  }
  return rows[next].entry.path;
}

/**
 * Format a byte count for the tooltip / detail column.
 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
