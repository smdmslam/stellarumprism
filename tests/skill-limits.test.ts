import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_SKILL_BUDGET_BYTES,
  SKILL_HARD_CAP_BYTES,
  SKILL_SOFT_WARN_BYTES,
  decideEngagement,
  formatKB,
} from "../src/skill-limits.ts";

const KB = 1024;

// ---------------------------------------------------------------------------
// formatKB
// ---------------------------------------------------------------------------

test("formatKB: sub-kilobyte renders as '<1 KB' (no precision lie)", () => {
  assert.equal(formatKB(0), "<1 KB");
  assert.equal(formatKB(500), "<1 KB");
});

test("formatKB: one decimal place for typical sizes", () => {
  assert.equal(formatKB(18 * KB), "18.0 KB");
  assert.equal(formatKB(16.9 * KB), "16.9 KB");
  assert.equal(formatKB(128 * KB), "128.0 KB");
});

test("formatKB: bogus input falls back to '0 KB' rather than throwing", () => {
  assert.equal(formatKB(NaN), "0 KB");
  assert.equal(formatKB(-1), "0 KB");
  assert.equal(formatKB(Infinity), "0 KB");
});

// ---------------------------------------------------------------------------
// decideEngagement — happy path
// ---------------------------------------------------------------------------

test("decideEngagement: small skill on empty session => ok", () => {
  const d = decideEngagement({
    candidatePath: "/path/foo.md",
    candidateBytes: 5 * KB,
    alreadyEngagedBytes: 0,
  });
  assert.equal(d.kind, "ok");
});

test("decideEngagement: existing largest current skill (16.9 KB) does NOT warn", () => {
  // Real corpus regression: the soft warn was deliberately set above
  // the largest existing skill so authors don't see noise on files
  // that already passed review. If this ever flips, recalibrate.
  const d = decideEngagement({
    candidatePath: "vc-pitchdeck-speaker-notes.md",
    candidateBytes: Math.floor(16.9 * KB),
    alreadyEngagedBytes: 0,
  });
  assert.equal(d.kind, "ok");
});

// ---------------------------------------------------------------------------
// decideEngagement — soft warn
// ---------------------------------------------------------------------------

test("decideEngagement: skill just over 18 KB warns but engages", () => {
  const d = decideEngagement({
    candidatePath: "/path/big.md",
    candidateBytes: SKILL_SOFT_WARN_BYTES + 1,
    alreadyEngagedBytes: 0,
  });
  assert.equal(d.kind, "warn");
  // Reason should name the file (basename only) so the user can
  // identify the offender without parsing a full path.
  if (d.kind === "warn") assert.match(d.reason, /big\.md/);
});

test("decideEngagement: warn message names the skill basename, not full path", () => {
  // Defensive: if decideEngagement ever leaks a full /Users/.../path,
  // the chip / toast UI gets long and ugly. Pin basename behavior.
  const d = decideEngagement({
    candidatePath: "/Users/me/Code/proj/.prism/skills/big.md",
    candidateBytes: 20 * KB,
    alreadyEngagedBytes: 0,
  });
  assert.equal(d.kind, "warn");
  if (d.kind === "warn") {
    assert.match(d.reason, /big\.md/);
    assert.doesNotMatch(d.reason, /\/Users/);
  }
});

// ---------------------------------------------------------------------------
// decideEngagement — hard cap
// ---------------------------------------------------------------------------

test("decideEngagement: skill over 32 KB hard-blocks, even with empty session", () => {
  // The hard cap is per-skill: it doesn't matter whether the budget
  // is empty, the file is too big to engage at all.
  const d = decideEngagement({
    candidatePath: "/path/giant.md",
    candidateBytes: SKILL_HARD_CAP_BYTES + 1,
    alreadyEngagedBytes: 0,
  });
  assert.equal(d.kind, "block");
});

test("decideEngagement: hard-cap reason gives a path forward (split into companions)", () => {
  // The reason text is part of the contract \u2014 the message has to
  // give the user a path forward, not just \"no.\" The phrasing
  // 'split into focused companions sharing a prefix' is the actionable
  // suggestion; tests pin the verb (\"split\") + the concept
  // (\"companions sharing a prefix\") rather than a single word so the
  // helper can be reworded without breaking this contract.
  const d = decideEngagement({
    candidatePath: "/path/giant.md",
    candidateBytes: 50 * KB,
    alreadyEngagedBytes: 0,
  });
  assert.equal(d.kind, "block");
  if (d.kind === "block") {
    assert.match(d.reason, /split/i);
    assert.match(d.reason, /companions|family|prefix/i);
  }
});

// ---------------------------------------------------------------------------
// decideEngagement — session budget
// ---------------------------------------------------------------------------

test("decideEngagement: full vc-pitchdeck family (99 KB) + small skill fits in budget", () => {
  // Real-corpus regression: this is the canonical happy-path workflow.
  // If the budget ever drops below this, real users get blocked.
  const d = decideEngagement({
    candidatePath: "/path/extra.md",
    candidateBytes: 10 * KB,
    alreadyEngagedBytes: 99 * KB,
  });
  assert.equal(d.kind, "ok");
});

test("decideEngagement: pushing past 128 KB blocks with a 'free up X' message", () => {
  const d = decideEngagement({
    candidatePath: "/path/heavy.md",
    candidateBytes: 30 * KB,
    alreadyEngagedBytes: 110 * KB,
  });
  assert.equal(d.kind, "block");
  if (d.kind === "block") {
    // The message must tell the user how much they need to free up
    // (delta over budget) so they can disable the right thing.
    assert.match(d.reason, /free/i);
    assert.match(d.reason, /KB/);
  }
});

test("decideEngagement: hard cap takes precedence over session budget", () => {
  // A 50 KB skill is unfit regardless of budget. The hard-cap rule
  // must fire first so the message is about the file itself, not
  // about \"disable another\" \u2014 disabling others wouldn't help.
  const d = decideEngagement({
    candidatePath: "/path/huge.md",
    candidateBytes: 50 * KB,
    alreadyEngagedBytes: 0,
  });
  assert.equal(d.kind, "block");
  if (d.kind === "block") {
    assert.match(d.reason, /per-skill cap/i);
    assert.doesNotMatch(d.reason, /session budget/i);
  }
});

test("decideEngagement: exact-cap edge cases use strict-greater-than semantics", () => {
  // Exactly at the cap = allowed. Strictly over = blocked or warned.
  // Pinning this avoids subtle off-by-one drift if someone refactors
  // the comparison operators later.
  const atSoft = decideEngagement({
    candidatePath: "x.md",
    candidateBytes: SKILL_SOFT_WARN_BYTES,
    alreadyEngagedBytes: 0,
  });
  assert.equal(atSoft.kind, "ok");

  const atHard = decideEngagement({
    candidatePath: "x.md",
    candidateBytes: SKILL_HARD_CAP_BYTES,
    alreadyEngagedBytes: 0,
  });
  assert.equal(atHard.kind, "warn"); // 32 KB is above warn but at cap

  const atBudget = decideEngagement({
    candidatePath: "x.md",
    candidateBytes: 28 * KB,
    alreadyEngagedBytes: SESSION_SKILL_BUDGET_BYTES - 28 * KB,
  });
  assert.equal(atBudget.kind, "warn"); // exactly fills the budget = ok-with-warn
});
