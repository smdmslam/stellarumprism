// Small pure helpers factored out of agent.ts so Node tests can import
// them without dragging the full browser/Tauri controller graph.

import type { RuntimeProbe } from "./findings";

export function parseHttpFetchProbeForAgent(
  args: string,
  summary: string,
  ok: boolean,
  round: number,
): RuntimeProbe | null {
  let url = "";
  let method = "GET";
  try {
    const parsed = JSON.parse(args) as { url?: unknown; method?: unknown };
    if (typeof parsed.url === "string") url = parsed.url.trim();
    if (typeof parsed.method === "string" && parsed.method.trim()) {
      method = parsed.method.trim().toUpperCase();
    }
  } catch {
    // Non-JSON args — swallow and let url stay empty so we drop the probe.
  }
  if (!url) return null;
  return { url, method, summary, ok, round };
}

export function extractWriteArtifactDiff(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as {
      artifact?: { diff?: unknown; operation?: unknown };
    };
    if (
      parsed.artifact &&
      typeof parsed.artifact.diff === "string" &&
      parsed.artifact.diff.trim().length > 0
    ) {
      return parsed.artifact.diff;
    }
  } catch {
    // Ignore malformed payloads; caller falls back to approval preview.
  }
  return null;
}

export function inferWriteOperation(
  toolName: string,
  payload: string,
): "create" | "overwrite" | "edit" {
  if (toolName === "edit_file") return "edit";
  if (toolName !== "write_file") return "edit";
  try {
    const parsed = JSON.parse(payload) as { created?: unknown };
    return parsed.created === true ? "create" : "overwrite";
  } catch {
    return "overwrite";
  }
}
