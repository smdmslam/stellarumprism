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
 * 2. ASK mode — run the PROMPT block at the bottom of this comment.
 * 3. Approve `edit_file`; confirm preview shows “preview · more below” + fade.
 * 4. Click the diff **header** (not filename) → full hunk scrolls inside the card.
 *
 * Not imported by the app; safe to delete after testing.
 */

export const DEMO_VERSION = 2;

/** Single-line toggle for quick small-diff experiments. */
export function getDemoStatus(): string {
  return "diff-ui-ok";
}

/**
 * Multi-line block (~12 lines) so one replacement overflows the **preview**
 * height (~10rem) and forces “more below” + expand to see the rest in-place.
 */
export function previewFixtureBody(): string {
  return [
    "  // PREVIEW_BLOCK_V1 — agent replaces this whole return array in one edit",
    "  const row01 = 'north';",
    "  const row02 = 'east';",
    "  const row03 = 'south';",
    "  const row04 = 'west';",
    "  const row05 = 'alpha';",
    "  const row06 = 'bravo';",
    "  const row07 = 'charlie';",
    "  const row08 = 'delta';",
    "  const row09 = 'echo';",
    "  const row10 = 'foxtrot';",
    "  const row11 = 'golf';",
    "  const row12 = 'hotel';",
  ].join("\n");
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
 * Use edit_file on docs/agent-diff-ui-test.ts. Replace the entire body of
 * previewFixtureBody() so the `return [` array lists the same 12 const rows
 * but change every string value from the compass+NATO set to a new theme,
 * e.g. planets 'mercury' … 'neptune' for row01–row12, or Greek 'alpha' …
 * 'omega' (twelve names). Keep the same structure and
 * PREVIEW_BLOCK comment but bump the comment to PREVIEW_BLOCK_V2.
 *
 * One edit_file call is enough — you should see a long diff: preview clipped,
 * then click the diff card header (not the filename) for full scroll inside
 * the agent chat.
 * --- end PROMPT ---
 */
