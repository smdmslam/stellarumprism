// Initial recipe catalog. Source-controlled; not user-authored in v1.
// Adding a new recipe is one entry in the RECIPES array — the runner
// and the hidden /protocol slash command pick it up automatically.

import type { Recipe } from "./types";

export const RECIPES: Recipe[] = [
  {
    id: "refactor-cohesion-review",
    label: "Refactor Cohesion Review",
    blurb:
      "Review recent commits for invariant leaks, helper stubs, and " +
      "schema round-trip mismatches.",
    category: "review",
    steps: [
      {
        kind: "slash",
        label: "Cohesion review of last 20 commits",
        command: "/review 20",
      },
      {
        kind: "shell",
        label: "pnpm typecheck",
        script: "typecheck",
        timeoutSecs: 180,
      },
      {
        kind: "shell",
        label: "pnpm test",
        script: "test",
        timeoutSecs: 240,
      },
    ],
  },
  {
    id: "harden",
    label: "Harden",
    blurb:
      "Anti-hacker / batten-down-the-hatches sweep: security audit + " +
      "dependency vulnerabilities.",
    category: "security",
    steps: [
      {
        kind: "slash",
        label: "Security audit (working tree)",
        command: "/audit",
      },
      {
        kind: "shell",
        label: "pnpm audit (dependency CVEs)",
        script: "audit",
        timeoutSecs: 120,
        // Dependency advisories are diagnostic; a non-zero exit
        // (vulnerabilities found) shouldn't abort the consolidated
        // report \u2014 the user wants to see them, not skip them.
        onFailure: "continue",
      },
    ],
  },
  {
    id: "pre-ship-check",
    label: "Pre-Ship Check",
    blurb:
      "Catch the embarrassing stuff before deploying: typecheck, build, " +
      "tests, and a final audit.",
    category: "ship",
    steps: [
      {
        kind: "shell",
        label: "pnpm typecheck",
        script: "typecheck",
        timeoutSecs: 180,
        // Failing typecheck means the rest of the recipe will compound
        // noise; abort and surface the typecheck failure.
        onFailure: "abort",
      },
      {
        kind: "shell",
        label: "pnpm build",
        script: "build",
        timeoutSecs: 300,
        onFailure: "abort",
      },
      {
        kind: "shell",
        label: "pnpm test",
        script: "test",
        timeoutSecs: 300,
        onFailure: "continue",
      },
      {
        kind: "slash",
        label: "Final audit pass",
        command: "/audit",
      },
    ],
  },
  {
    id: "wiring-gap-audit",
    label: "Wiring Gap Audit",
    blurb:
      "Find recently-wired symbols that resolve but whose body is a " +
      "stub or no-op (the expandTilde class).",
    category: "wiring",
    steps: [
      {
        kind: "slash",
        label: "Cohesion review focused on helper bodies",
        command: "/review 20",
      },
      {
        kind: "slash",
        label: "Audit recently-touched files",
        command: "/audit HEAD~5..HEAD",
      },
    ],
  },
];

/** Resolve a recipe by id. Returns null if no match. */
export function findRecipe(id: string): Recipe | null {
  const trimmed = id.trim().toLowerCase();
  return RECIPES.find((r) => r.id.toLowerCase() === trimmed) ?? null;
}
