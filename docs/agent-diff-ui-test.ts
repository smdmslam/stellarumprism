/**
 * Prism — manual test fixture for the agent chat inline diff card.
 *
 * How to use:
 * 1. Set shell cwd to the repo root (or use @docs/agent-diff-ui-test.ts in the prompt).
 * 2. In ASK mode, run the prompt below; approve the edit when asked.
 * 3. After the tool succeeds, expand the diff card in the agent panel to inspect
 *    line numbers, +/- lines, and hunk headers.
 *
 * Not imported by the app; safe to delete after testing.
 */

export const DEMO_VERSION = 1;

/** Single line we intentionally tweak during diff UI tests. */
export function getDemoStatus(): string {
  return "ready";
}

/**
 * EDIT ZONE — replace this block’s inner string in one edit_file call
 * to see a multi-line hunk in the diff card.
 */
export function describeDemo(): string {
  return [
    "Line one: unchanged anchor.",
    "Line two: CHANGE_ME_TO_SEE_DIFF",
    "Line three: trailing context.",
  ].join("\n");
}
