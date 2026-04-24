// Extract `@path` references from submitted agent prompts and fetch their
// contents via the `read_file_scoped` Tauri command, so we can inline them
// into the LLM context.

import { invoke } from "@tauri-apps/api/core";

export interface ResolvedFile {
  /** What the user typed after the @. */
  original: string;
  /** Absolute path that was read. */
  path: string;
  /** File contents (UTF-8, possibly truncated). */
  content: string;
  /** Size on disk in bytes. */
  size: number;
  /** True if Prism trimmed the content. */
  truncated: boolean;
}

export interface ResolvedFileError {
  original: string;
  error: string;
}

// Matches `@path` where the path uses only safe filename chars (letters,
// numbers, ./~/-_+/). Stops at whitespace. Email addresses are not matched
// because we require the @ to be at start-of-string or after whitespace.
//
// Paths containing spaces are intentionally not supported — use drag-drop
// for those instead.
const REF_RE = /(?:^|\s)@([A-Za-z0-9._~][A-Za-z0-9._~/+-]*)/g;

/** Extract the set of `@paths` referenced in a user message, in order. */
export function extractFileRefs(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const raw = m[1];
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/** Read each referenced path from disk via Rust. Errors are returned, not thrown. */
export async function resolveFileRefs(
  refs: string[],
  cwd: string,
): Promise<{ resolved: ResolvedFile[]; errors: ResolvedFileError[] }> {
  const resolved: ResolvedFile[] = [];
  const errors: ResolvedFileError[] = [];
  for (const original of refs) {
    try {
      const r = await invoke<ResolvedFile>("read_file_scoped", {
        cwd,
        path: original,
      });
      resolved.push(r);
    } catch (e) {
      errors.push({ original, error: String(e) });
    }
  }
  return { resolved, errors };
}
