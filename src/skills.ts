// Skills foundation, frontend half (`MASTER-Plan-II#7.1`).
//
// Wraps the two Tauri commands `list_skills` and `read_skill` (defined
// in `src-tauri/src/skills.rs`) and exposes a Markdown renderer for
// `/skills`. Both engagement tracks (intentional Load + chip, and
// LLM-aware toggle) consume `listSkills()` to learn what's in the
// corpus; the bodies are pulled lazily via `readSkill()` only when a
// skill is actually engaged.
//
// Description-derivation rules live on the Rust side so the LLM-aware
// manifest (Track B) and the curation UI (already-shipped) see the
// same string. The `description` field returned here is the canonical
// form — short, human-readable, ready to paste into a markdown table
// or a system-prompt manifest line.
//
// Naming note: backend uses snake_case for the command ids
// (`list_skills`, `read_skill`); frontend wrappers re-export them as
// camelCase to match the rest of the TS surface.

import { invoke } from "@tauri-apps/api/core";

import { formatKB } from "./skill-limits";

/**
 * One row from `list_skills`. Cheap to fetch (body NOT included), so
 * the LLM-aware manifest can be reassembled per-turn without disk I/O
 * pain. `sizeBytes` is exposed so the frontend can run the same
 * `decideEngagement` check against the per-session budget that the
 * curation UI already does.
 */
export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  sizeBytes: number;
}

/**
 * One full skill body, returned by `read_skill`. Subject to the per-
 * skill 32 KB hard cap; oversized files reject before hitting this
 * type. Used by both intentional engagement (Track A) and the LLM-
 * driven `read_skill` tool (Track B).
 */
export interface SkillBody {
  slug: string;
  name: string;
  description: string;
  body: string;
  sizeBytes: number;
}

/** Cheap manifest of every skill under `<cwd>/prism/skills/*.md` (with legacy fallback). */
export async function listSkills(cwd: string): Promise<SkillSummary[]> {
  return await invoke<SkillSummary[]>("list_skills", { cwd });
}

/** Read one skill's full body. Errors on unknown slug or oversize. */
export async function readSkill(cwd: string, slug: string): Promise<SkillBody> {
  return await invoke<SkillBody>("read_skill", { cwd, slug });
}

/**
 * Render the skill library as a Markdown table for the agent stage.
 * Mirrors `renderModelsMarkdown` so users hitting `/skills` see the
 * same shape they get from `/models`. Includes the file size so users
 * can sanity-check token weight before engaging large skills.
 *
 * Empty-state is rendered explicitly with a pointer at the README so
 * users have a clear next step instead of staring at a blank table.
 */
export function renderSkillsMarkdown(skills: SkillSummary[]): string {
  if (skills.length === 0) {
    return (
      "### Skills\n\n" +
      "_No skills found in `prism/skills/`._\n\n" +
      "Drop a markdown file in `prism/skills/<slug>.md` to add one. " +
      "See `prism/skills/README.md` for the format and `docs/skills.md` " +
      "for size discipline + authoring rules."
    );
  }
  const out: string[] = [];
  out.push("### Skills\n\n");
  out.push(`_${skills.length} skill${skills.length === 1 ? "" : "s"} in \`prism/skills/\`._\n\n`);
  out.push("| Skill | Description | Size |\n");
  out.push("| :--- | :--- | ---: |\n");
  for (const s of skills) {
    const slug = `\`${s.slug}\``;
    // Newlines in descriptions would break the markdown table row;
    // collapse them to spaces so the table stays one-row-per-skill.
    const description = s.description.replace(/\s+/g, " ").trim();
    const size = formatKB(s.sizeBytes);
    out.push(`| ${slug} | ${escapeTableCell(description)} | ${size} |\n`);
  }
  return out.join("");
}

/**
 * Escape characters that would break a Markdown table cell. Pipes and
 * trailing backslashes are the only ones that matter in practice;
 * angle brackets and HTML are passed through so descriptions can keep
 * inline emphasis if the author wrote any.
 */
function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\\$/, "\\\\");
}
