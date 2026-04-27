import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectRigorViolation,
  scanForRigorMarkers,
} from "../src/grounded-rigor.ts";

// ---------------------------------------------------------------------------
// scanForRigorMarkers — pure detector. Marker presence only.
// ---------------------------------------------------------------------------

test("scan: detects bare \u2713 Observed", () => {
  const r = scanForRigorMarkers("\u2713 Observed\nThe file has 12 tests.");
  assert.equal(r.hasObservationClaim, true);
  assert.equal(r.counts["observed"], 1);
});

test("scan: detects ANSI-wrapped \u2713 Observed (the protocol's recommended form)", () => {
  // The protocol literally instructs the model to wrap labels in
  // dim ANSI: `\x1b[2m\u2713 Observed\x1b[0m`. We must catch that form
  // too — otherwise a well-behaving model gets a false negative.
  const r = scanForRigorMarkers("\x1b[2m\u2713 Observed\x1b[0m\nbody text here");
  assert.equal(r.hasObservationClaim, true);
  assert.equal(r.counts["observed"], 1);
});

test("scan: counts multiple \u2713 Observed labels", () => {
  const text = [
    "\u2713 Observed",
    "para 1",
    "",
    "\u2713 Observed",
    "para 2",
  ].join("\n");
  const r = scanForRigorMarkers(text);
  assert.equal(r.counts["observed"], 2);
});

test("scan: detects 'Verified total: N'", () => {
  const r = scanForRigorMarkers(
    "Some prose. Verified total: 556. Proof: 176 + 380 = 556.",
  );
  assert.equal(r.hasObservationClaim, true);
  assert.equal(r.counts["verified-total"], 1);
});

test("scan: 'Verified total' is case-insensitive (model wording drift safety)", () => {
  // We don't want a model that emits 'verified Total:' or
  // 'VERIFIED TOTAL:' to slip past. The protocol asks for one casing
  // but the rule we're enforcing is structural, not stylistic.
  const r = scanForRigorMarkers("verified total: 12");
  assert.equal(r.counts["verified-total"], 1);
});

test("scan: tool-success \u2713 glyphs are NOT counted as Observed claims", () => {
  // The agent terminal renders tool successes as `\u2713 read_file`
  // (and similar). Those are visual confirmations, not claim labels,
  // so the scanner must not count them. The 'Observed' word is the
  // distinguisher.
  const r = scanForRigorMarkers("\u2713 read_file\n  ok read 12 files");
  assert.equal(r.hasObservationClaim, false);
  assert.equal(r.counts["observed"], 0);
});

test("scan: empty / unrelated text returns no claims", () => {
  assert.equal(scanForRigorMarkers("").hasObservationClaim, false);
  assert.equal(
    scanForRigorMarkers("hello world, no labels here").hasObservationClaim,
    false,
  );
});

test("scan: '? Unverified' alone is not flagged (it's the safe label)", () => {
  // A response that uses ONLY ? Unverified labels is honest about
  // its uncertainty and should never trip the rigor warning.
  const r = scanForRigorMarkers("? Unverified\nI did not check this.");
  assert.equal(r.hasObservationClaim, false);
});

// ---------------------------------------------------------------------------
// detectRigorViolation — composes the rule (grounded + 0 tools + claims).
// ---------------------------------------------------------------------------

test("violation: grounded + 0 tools + Observed claim => violation", () => {
  const v = detectRigorViolation({
    groundedActive: true,
    toolCallCount: 0,
    response: "\u2713 Observed\nThe file has 12 tests.",
  });
  assert.notEqual(v, null);
  assert.match(v!.summary, /\u2713 Observed/);
});

test("violation: grounded + 0 tools + Verified-total => violation", () => {
  const v = detectRigorViolation({
    groundedActive: true,
    toolCallCount: 0,
    response: "Verified total: 42",
  });
  assert.notEqual(v, null);
  assert.match(v!.summary, /Verified total/);
});

test("violation: grounded + tools ran => no violation even with claims", () => {
  // Model did real tool work AND used \u2713 Observed labels. We trust
  // the protocol's contract; per-claim verification is out of scope.
  const v = detectRigorViolation({
    groundedActive: true,
    toolCallCount: 2,
    response: "\u2713 Observed\nI read foo.txt",
  });
  assert.equal(v, null);
});

test("violation: not grounded => never a violation (we don't police plain chat)", () => {
  // A non-grounded turn that happens to contain '\u2713 Observed' (e.g.
  // user pasted a transcript) must not trigger the warning.
  const v = detectRigorViolation({
    groundedActive: false,
    toolCallCount: 0,
    response: "\u2713 Observed",
  });
  assert.equal(v, null);
});

test("violation: grounded + 0 tools + no claim markers => no violation", () => {
  // Model behaved correctly: protocol fired, no tools ran, but the
  // model honestly used `? Unverified` and skipped `\u2713 Observed`.
  // That's the desired behavior, not a violation.
  const v = detectRigorViolation({
    groundedActive: true,
    toolCallCount: 0,
    response: "? Unverified\nI cannot answer without reading the file.",
  });
  assert.equal(v, null);
});

test("violation: summary is human-readable and stable", () => {
  // Stable wording matters because the warning surfaces in the
  // terminal and users will pattern-match on it across sessions.
  const v = detectRigorViolation({
    groundedActive: true,
    toolCallCount: 0,
    response: "\u2713 Observed\np1\n\u2713 Observed\np2\nVerified total: 99",
  });
  assert.notEqual(v, null);
  assert.equal(v!.summary, "2 \u2713 Observed, 1 Verified total");
});
