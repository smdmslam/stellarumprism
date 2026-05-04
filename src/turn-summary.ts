// Helpers for the per-turn xterm chrome the agent renders at the end of
// a query: the "Files Modified" footer, the "[done in Ns · N tools · model]"
// summary, and the cleanup of tool-call summary lines that duplicate the
// path already shown on the args line.
//
// Kept as pure functions in their own module so they're trivial to unit
// test and so future agent surfaces (a /history viewer, the saved-chat
// renderer, etc.) can format the same footers consistently.

// ---------------------------------------------------------------------------
// Write-tool path extraction (Files Modified footer)
// ---------------------------------------------------------------------------

/** Tool names that mutate a file on disk. Membership decides whether
 * `onToolCall` should track the call into the per-turn write list. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "delete_directory",
  "move_path",
  "create_directory",
]);

export interface WriteEntry {
  /** Tool that produced the write (`write_file` or `edit_file`). */
  tool: string;
  /** Path the model passed in args, verbatim. May be relative or absolute. */
  path: string;
  /** Whether the call succeeded. Failed writes still get tracked so the
   *  user can see "the model tried to edit X and failed" rather than a
   *  silently-dropped attempt. */
  ok: boolean;
  /** Estimated line changes. */
  stats?: { added: number; removed: number };
}

/**
 * Pull the `path` arg out of a write-tool's argument JSON. Returns null
 * when the args don't carry a string `path` field (malformed / missing
 * — caller should skip rather than emit an empty footer line).
 *
 * Tolerant of malformed JSON: a parse error is treated the same as a
 * missing field. The agent loop never silently drops a tracked write
 * just because args were unusable; we simply omit it from the footer.
 */
export function extractWritePath(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson) as {
      path?: unknown;
      source?: unknown;
      destination?: unknown;
    };
    if (typeof parsed.path === "string" && parsed.path.trim().length > 0) {
      return parsed.path;
    }
    if (typeof parsed.source === "string" && parsed.source.trim().length > 0) {
      return `${parsed.source} \u2192 ${parsed.destination ?? "?"}`;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/**
 * Estimate line changes (+N -M) from a tool's arguments.
 * For `edit_file`, we compare line counts of the replaced snippet vs the new one.
 * For `write_file`, we treat it as adding all lines in the new content.
 */
export function calculateWriteStats(
  tool: string,
  argsJson: string,
): { added: number; removed: number } | undefined {
  try {
    const parsed = JSON.parse(argsJson);
    if (tool === "edit_file") {
      const oldStr = String(parsed.old_string || "");
      const newStr = String(parsed.new_string || "");
      const removed = oldStr.split("\n").length;
      const added = newStr.split("\n").length;
      return { added, removed };
    }
    if (tool === "write_file") {
      const content = String(parsed.content || "");
      const added = content.split("\n").length;
      return { added, removed: 0 };
    }
  } catch {
    /* ignore malformed */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool summary path-stripping
// ---------------------------------------------------------------------------

/**
 * The path-touching tools all return summaries shaped like
 *   "<verb> <path> (<info>)"
 * (e.g. `read /Users/.../foo.ts (1.2 KB)`, `edited /path (3 replacements)`).
 *
 * The path is also rendered on the args line above, so showing it again
 * inside the summary is pure noise. This helper rewrites the summary to
 * "<verb> <info>" \u2014 keeping the verb (read / created / overwrote / edited
 * / listed) and the parenthetical, dropping the path that came between.
 *
 * For tools whose summary doesn't follow that shape (e.g. grep,
 * web_search, http_fetch, run_shell), the original summary is returned
 * unchanged so we never lose information.
 */
const PATH_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "read_file_snippet",
  "write_file",
  "edit_file",
  "list_directory",
  "list_directory_tree",
  "delete_file",
  "delete_directory",
  "move_path",
  "create_directory",
]);

const PATH_SUMMARY_RE = /^(\w+)\s+.+?\s*\(([^()]+)\)\s*$/;

export interface CleanSummary {
  verb: string;
  pill?: string;
  full: string;
}

export function cleanToolSummary(toolName: string, summary: string): CleanSummary {
  if (!PATH_TOOLS.has(toolName)) {
    return { verb: "", full: summary };
  }
  const m = PATH_SUMMARY_RE.exec(summary);
  if (!m) {
    return { verb: "", full: summary };
  }
  const verb = m[1].toLowerCase();
  const info = m[2];
  return { verb, pill: info, full: `${verb} ${info}` };
}

// ---------------------------------------------------------------------------
// Elapsed time formatting
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds as a compact human-readable string.
 *
 *   <1s     => "<1s"          (avoids printing "0.0s" for sub-100ms turns)
 *   <60s    => "4.2s"         (one decimal place for granular short turns)
 *   <60m    => "2m12s"        (whole seconds; minutes are coarse enough)
 *   >=60m   => "1h03m"        (hours show two-digit minutes for alignment)
 *
 * The output is meant for the dim turn footer; readability matters more
 * than precision past one significant figure.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return "<1s";
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  if (totalMin < 60) return `${totalMin}m${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hr}h${min.toString().padStart(2, "0")}m`;
}

// ---------------------------------------------------------------------------
// Footer composition
// ---------------------------------------------------------------------------

export interface TurnSummary {
  elapsedMs: number;
  toolCount: number;
  model: string;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * Compose the dim turn-footer line that closes every agent turn. Reads
 * something like `[done in 4.2s \u00b7 3 tools \u00b7 qwen3-next]` so the user has
 * a stable scroll-back anchor at the end of each turn.
 *
 * Returns just the inner string \u2014 the caller wraps it in ANSI dim and
 * line breaks. Keeping it raw makes the function trivial to unit-test
 * and keeps ANSI concerns in the rendering layer.
 */
export function formatTurnFooter(s: TurnSummary): string {
  const parts: string[] = [`done in ${formatElapsed(s.elapsedMs)}`];
  if (s.toolCount > 0) {
    parts.push(`${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`);
  }
  if (s.totalTokens) {
    const t = s.totalTokens >= 1000 ? `${(s.totalTokens / 1000).toFixed(1)}k` : s.totalTokens;
    parts.push(`${t} tokens`);
  }
  if (s.model) parts.push(s.model);
  return `[${parts.join(" \u00b7 ")}]`;
}

/**
 * Compose the multi-line "files modified" footer for turns that ran at
 * least one write_file/edit_file. Returns an array of plain lines (no
 * ANSI) so the renderer owns presentation. Caller wraps in dim + paints
 * the heading.
 *
 * Layout:
 *   "files modified (N)"
 *   "  PATH    TOOL"
 *   "  PATH    TOOL"
 *
 * Padding aligns the tool column for scannability when the user has a
 * short list of changed files \u2014 with longer paths it degrades to a
 * single space, which is acceptable.
 */
export function formatFilesModifiedFooter(writes: WriteEntry[]): string[] {
  if (writes.length === 0) return [];

  // Deduplicate by path. If the same file was modified multiple times, we
  // only care about its final status in this summary.
  const uniqueWrites = new Map<string, WriteEntry>();
  for (const w of writes) {
    uniqueWrites.set(w.path, w);
  }

  // Sort by path for a stable, predictable list.
  const sorted = Array.from(uniqueWrites.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  const heading = `files modified (${sorted.length})`;
  // Compute a soft alignment column. Cap at 60 so a single very long
  // path doesn't push the tool column off the right edge of the
  // terminal. Below that cap, line up consistently.
  const maxPath = Math.min(
    60,
    sorted.reduce((m, w) => Math.max(m, w.path.length), 0),
  );
  const lines = sorted.map((w) => {
    const padded =
      w.path.length >= maxPath
        ? w.path
        : w.path + " ".repeat(maxPath - w.path.length);
    const status = w.ok ? "" : " (failed)";
    return `  ${padded}  ${w.tool}${status}`;
  });
  return [heading, ...lines];
}
