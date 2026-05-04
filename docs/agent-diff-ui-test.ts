/**
 * Prism — manual test fixture for the agent chat inline diff card
 * (preview clip vs full accordion / scroll).
 *
 * **Preview vs full:** The collapsed card shows ~6 rows (+ hunk header); click the
 * **header** to expand. Full diff stays **inside the agent panel** — same card,
 * body grows with scroll (`max-height: min(70vh, 28rem)`), not a separate window.
 *
 * How to test:
 * 1. Shell cwd = repo root (or attach `@docs/agent-diff-ui-test.ts`).
 * 2. ASK mode — run the PROMPT block at the bottom of this file (verbatim workflow).
 * 3. Approve `edit_file`; confirm preview shows “preview · more below” + fade.
 * 4. Click the diff **header** (not filename) → full hunk scrolls inside the card.
 *
 * **If `edit_file` says old_string not found:** the model retyped the file instead
 * of copying it. Re-run with the prompt that forces `read_file` first and a
 * paste from tool output.
 *
 * Not imported by the app; safe to delete after testing.
 */

export const DEMO_VERSION = 2;

/** Single-line toggle for quick small-diff experiments. */
export function getDemoStatus(): string {
  return "diff-ui-ok";
}

/**
 * Editable block: whole array is one `old_string` target (see PROMPT). Keep 12
 * string lines so the diff is tall enough to overflow the preview clip.
 */
const PREVIEW_FIXTURE_LINES: string[] = [
  "  // PREVIEW_BLOCK_V2 — replace this whole const in one edit (see file footer)",
  "  const row01 = 'Mercury';",
  "  const row02 = 'Venus';",
  "  const row03 = 'Earth';",
  "  const row04 = 'Mars';",
  "  const row05 = 'Jupiter';",
  "  const row06 = 'Saturn';",
  "  const row07 = 'Uranus';",
  "  const row08 = 'Neptune';",
  "  const row09 = 'Pluto';",
  "  const row10 = 'Ceres';",
  "  const row11 = 'Eris';",
  "  const row12 = 'Haumea';",
];

/**
 * Multi-line block (~12 lines) so one replacement overflows the **preview**
 * height (~10rem) and forces “more below” + expand to see the rest in-place.
 */
export function previewFixtureBody(): string {
  return PREVIEW_FIXTURE_LINES.join("\n");
}

/**
 * EDIT ZONE — thin wrapper so the fixture stays valid TS after edits.
 */
export function describeDemo(): string {
  return ["fixture:", previewFixtureBody()].join("\n");
}

/*
 * --- PROMPT (paste into agent, ASK mode) ---
 *
 * 1) Call read_file on docs/agent-diff-ui-test.ts and read the full file.
 * 2) Call edit_file on the same path. You MUST set old_string by COPY-PASTING
 *    from the read_file output only — the complete `const PREVIEW_FIXTURE_LINES`
 *    declaration, from the line that starts with `const PREVIEW_FIXTURE_LINES`
 *    through the closing `];` (inclusive). Do not retype or paraphrase; that
 *    causes "old_string not found".
 * 3) new_string: same const name and TypeScript shape, but change every value
 *    string to a new theme (e.g. planets 'mercury'…'neptune' for row01–row12),
 *    and change the first line’s comment to PREVIEW_BLOCK_V2.
 * 4) One edit_file call. Then check the diff card: preview clip, then click the
 *    diff header (not the filename) for full scroll in the agent panel.
 * --- end PROMPT ---
 */
