// Skill size discipline.
//
// Single source of truth for the per-skill and per-session caps that
// govern engagement. Calibrated against the current corpus
// (10 files, ~113 KB, avg ~12 KB, largest 16.9 KB) so the warn line
// sits above the existing baseline and the hard cap leaves ~2× headroom.
//
// See `docs/skills.md` for the rationale and re-calibration rules. The
// numbers below are deliberately the only place callers should read
// these values; updating one constant updates every consumer.

/**
 * Per-skill warn threshold. Skills larger than this trigger a yellow
 * notice at engagement time but still engage. Set just above the
 * current largest skill so existing files don't fire false-positive
 * warnings.
 */
export const SKILL_SOFT_WARN_BYTES = 18 * 1024;

/**
 * Per-skill hard cap. Skills larger than this cannot be engaged at
 * all; the Load modal refuses with a message that names the file and
 * its size and points the user at splitting it into a family.
 */
export const SKILL_HARD_CAP_BYTES = 32 * 1024;

/**
 * Per-session (per-tab) total budget across all engaged skills. Sized
 * to cover the full `vc-pitchdeck-*` family (~99 KB) plus a couple
 * more, while pushing back when someone tries to engage 10+ heavy
 * skills at once.
 */
export const SESSION_SKILL_BUDGET_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------
// Engagement-decision helper
// ---------------------------------------------------------------------------

/**
 * Outcome of asking "can this candidate engage right now?". The
 * Load modal renders the result directly: `ok` engages, `warn` shows
 * a yellow notice and engages, `block` refuses with the named reason.
 *
 * Returning a structured result instead of throwing keeps the helper
 * pure + testable and lets the caller render different chrome per
 * outcome (yellow toast vs red modal).
 */
export type EngagementDecision =
  | { kind: "ok" }
  | { kind: "warn"; reason: string }
  | { kind: "block"; reason: string };

/**
 * Decide whether a candidate skill can be engaged given the current
 * already-engaged set's total bytes.
 *
 * Order of checks: hard cap on the candidate first (a 50 KB file is
 * always invalid, regardless of budget), then session budget (would
 * the engaged total exceed 128 KB?), then soft warn (over 18 KB but
 * within budget). The first failing rule wins.
 *
 * `candidatePath` is included in the rejection messages so the user
 * doesn't have to chase down which file is the offender when several
 * are in flight (e.g. engaging a saved-search group with multiple
 * matches).
 */
export function decideEngagement(args: {
  candidatePath: string;
  candidateBytes: number;
  alreadyEngagedBytes: number;
}): EngagementDecision {
  const name = lastPathSegment(args.candidatePath);

  // Per-skill hard cap. A single file too large to engage at all,
  // independent of session state.
  if (args.candidateBytes > SKILL_HARD_CAP_BYTES) {
    return {
      kind: "block",
      reason: `${name} is ${formatKB(args.candidateBytes)} \u2014 over the ${formatKB(
        SKILL_HARD_CAP_BYTES,
      )} per-skill cap. Split it into focused companions sharing a prefix.`,
    };
  }

  // Per-session budget. Engaging this skill would push the tab's
  // total past the budget — refuse and tell the user how much they'd
  // need to free up.
  const projectedTotal = args.alreadyEngagedBytes + args.candidateBytes;
  if (projectedTotal > SESSION_SKILL_BUDGET_BYTES) {
    const overBy = projectedTotal - SESSION_SKILL_BUDGET_BYTES;
    return {
      kind: "block",
      reason: `engaging ${name} (${formatKB(args.candidateBytes)}) would push this tab to ${formatKB(
        projectedTotal,
      )}, over the ${formatKB(
        SESSION_SKILL_BUDGET_BYTES,
      )} session budget. Disable another skill (need to free ${formatKB(overBy)}).`,
    };
  }

  // Per-skill soft warn. Engagement proceeds; caller surfaces the
  // notice in non-blocking chrome (yellow toast, dim chip border).
  if (args.candidateBytes > SKILL_SOFT_WARN_BYTES) {
    return {
      kind: "warn",
      reason: `${name} is ${formatKB(
        args.candidateBytes,
      )} \u2014 large for a skill. Consider splitting into a family.`,
    };
  }

  return { kind: "ok" };
}

/**
 * Format a byte count as a compact human-readable KB string.
 * Sub-kilobyte values render as "<1 KB" rather than "0.0 KB" so the
 * UI never lies about precision. One decimal place is enough for the
 * sizes this module deals with (caps in the 18-128 KB range).
 */
export function formatKB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1) return "<1 KB";
  return `${kb.toFixed(1)} KB`;
}

/** Best-effort filename extraction. Tolerant of mixed slashes; falls
 *  back to the full path if no separator is present. */
function lastPathSegment(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
