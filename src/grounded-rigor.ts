// Grounded-Chat rigor enforcement.
//
// The Grounded-Chat protocol (`verified-mode.ts`) instructs the model to
// label every claim with one of:
//
//   ✓ Observed   — verified from a tool result or file read THIS turn
//   ~ Inferred   — reasoned from observations
//   ? Unverified — plausible but not checked
//
// And, for COUNT questions, to emit a final "Verified total: N" line ONLY
// if it actually computed the number from source this turn.
//
// In practice the model can ignore the protocol and stamp ✓ Observed (or
// "Verified total") on fabricated content. We saw this live: a Kimi K2.5
// turn produced "Verified total: 556" + ✓ Observed paragraphs when the
// previous turn (no protocol) had explicitly said the file didn't exist
// — and no read_file tool call ran in the protocol turn either.
//
// We can't police per-claim truth from the frontend (we don't know which
// sentences were grounded in which file). But we CAN enforce a global
// invariant: if the protocol fired and zero tools executed this turn,
// then NO claim can legitimately wear ✓ Observed or "Verified total".
// Either label is a structural rigor violation and the user deserves to
// know about it before they trust the answer.
//
// This module is the pure detection layer. The agent controller wires
// the warning emission.

/**
 * Markers a Grounded-Chat-active turn must NOT carry when zero tools
 * ran. Each entry is a human-readable kind + a regex.
 *
 * The regexes are deliberately tolerant about ANSI dim/reset wrappers
 * because the protocol itself instructs the model to wrap labels in
 * `\x1b[2m … \x1b[0m`. We don't want a false negative just because the
 * model emitted the suggested ANSI form.
 */
const RIGOR_MARKERS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // ✓ Observed (with or without ANSI wrap). Match the glyph + the
  // word "Observed" within ~8 chars to allow `\x1b[2m` between them
  // without matching unrelated checkmarks (e.g. tool success glyphs).
  { kind: "observed", pattern: /\u2713[^\n]{0,12}\bObserved\b/ },
  // "Verified total: N" — the COUNT addendum's strongest claim.
  // Only the count addendum mandates this exact phrasing, so any
  // appearance is the model promising it computed N from source.
  { kind: "verified-total", pattern: /\bVerified total\s*:/i },
];

/** Outcome of scanning a response for rigor markers. */
export interface RigorScan {
  /** True iff at least one ✓ Observed or Verified-total marker appears. */
  hasObservationClaim: boolean;
  /** Per-marker counts for diagnostics + future UX (e.g. inline strike-through). */
  counts: Record<string, number>;
}

/**
 * Scan an assistant response for Grounded-Chat rigor markers.
 *
 * Pure function — takes the raw response string (post-stream, ANSI
 * codes intact) and returns a structural summary. Caller decides
 * whether the result constitutes a violation based on tool-call
 * count and whether the protocol was active.
 */
export function scanForRigorMarkers(response: string): RigorScan {
  const counts: Record<string, number> = {};
  let hasObservationClaim = false;
  for (const m of RIGOR_MARKERS) {
    // Use a fresh global flag to count occurrences without mutating
    // the source pattern (which is shared module state).
    const g = new RegExp(m.pattern.source, m.pattern.flags + "g");
    const matches = response.match(g);
    const n = matches?.length ?? 0;
    counts[m.kind] = n;
    if (n > 0) hasObservationClaim = true;
  }
  return { hasObservationClaim, counts };
}

/**
 * Decide whether a completed turn violates the Grounded-Chat rigor
 * contract. Returns null when the turn is fine (or when grounded
 * mode wasn't active, in which case we don't police ✓ glyphs at all).
 *
 * The rule is intentionally simple and global:
 *   grounded mode active + zero tools ran + at least one observation-
 *   claim marker in the response = violation.
 *
 * We do NOT try to attribute claims to specific tool calls or files;
 * that would require parsing the response semantically and would be
 * brittle. The global rule catches the worst class of fabrication
 * (model invents ✓ Observed claims with no underlying tool work) and
 * leaves nuanced grounding to the model's own discipline.
 */
export interface RigorViolation {
  scan: RigorScan;
  /** Human-readable summary, e.g. "1 ✓ Observed, 1 Verified total". */
  summary: string;
}

export function detectRigorViolation(args: {
  groundedActive: boolean;
  toolCallCount: number;
  response: string;
}): RigorViolation | null {
  if (!args.groundedActive) return null;
  if (args.toolCallCount > 0) return null;
  const scan = scanForRigorMarkers(args.response);
  if (!scan.hasObservationClaim) return null;
  // Build a compact summary for the warning line. Order is stable
  // (observed first, then verified-total) so the message reads the
  // same way every time and is easy to recognize.
  const parts: string[] = [];
  if ((scan.counts["observed"] ?? 0) > 0) {
    parts.push(`${scan.counts["observed"]} \u2713 Observed`);
  }
  if ((scan.counts["verified-total"] ?? 0) > 0) {
    parts.push(`${scan.counts["verified-total"]} Verified total`);
  }
  return { scan, summary: parts.join(", ") };
}
