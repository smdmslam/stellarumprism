# Project Protection Skills Index

This index groups the `project-protection-` skill family so it is easy to browse, load, and use as a coherent system inside Prism.

All related files intentionally share the same filename prefix so they cluster naturally in `.prism/skills/` listings.

---

## Purpose

These skills were created to preserve a reusable method for analyzing a software project's security posture and turning that analysis into a practical protection plan.

The goal is not only to list generic security advice.
The goal is to preserve the reusable method:
- how to identify what must be protected
- how to identify what the system can do
- how to identify trust boundaries and risky flows
- how to detect insecure patterns common in fast-built or vibe-coded systems
- how to translate findings into a prioritized implementation plan
- how to apply that method specifically to Prism-style AI-assisted developer tools

This skill family should be used whenever reviewing a project for security hardening, trust-boundary clarity, or protection planning.

---

## Skill family

### 1. `project-protection-threat-model.md`
**Use for:** the general analysis method.

**What it contains:**
- how to identify assets, capabilities, boundaries, and attack surfaces
- how to enumerate likely threat actors and abuse cases
- how to distinguish observed facts from inferred risk
- how to turn broad concern into a structured findings list

**Use this when:**
- the project was built quickly and needs structured hardening
- security work feels vague or overwhelming
- you want a clean inventory before proposing fixes

---

### 2. `project-protection-priority-plan.md`
**Use for:** converting findings into action.

**What it contains:**
- how to rank findings by risk, effort, exploitability, and blast radius
- how to identify highest-impact, easiest-first fixes
- how to group work into phased implementation plans
- how to favor central controls over scattered patches

**Use this when:**
- you already have findings and need a plan
- the team needs a practical hardening roadmap
- you want to avoid random security chores with no prioritization

---

### 3. `project-protection-prism-patterns.md`
**Use for:** Prism-specific protection guidance.

**What it contains:**
- the security implications of a tool that can read files, write files, run commands, and fetch network resources
- Prism-specific trust-boundary rules
- likely bypass patterns and refactor-era gaps
- implementation patterns that fit this repo and product shape

**Use this when:**
- the project is Prism itself
- the project resembles Prism in capability or architecture
- you want the general method adapted to an AI-assisted developer tool

---

## Recommended order of use

A strong default sequence is:

1. `project-protection-threat-model.md`
   - identify the attack surface, assets, trust boundaries, and abuse cases
2. `project-protection-prism-patterns.md`
   - adapt the analysis to Prism-specific risks and architecture patterns
3. `project-protection-priority-plan.md`
   - turn the findings into the most useful implementation order

This sequence can be compressed, but the order is intentionally logical.

---

## Quick usage by situation

### If the project was vibe-coded quickly
Start with:
- `project-protection-threat-model.md`
- `project-protection-prism-patterns.md`
- `project-protection-priority-plan.md`

### If you already know the app has risky powers
Start with:
- `project-protection-prism-patterns.md`
- `project-protection-priority-plan.md`

### If the team wants “highest impact, easiest first”
Start with:
- `project-protection-priority-plan.md`
- then backfill any missing structure from `project-protection-threat-model.md`

### If the discussion keeps drifting into generic advice
Start with:
- `project-protection-threat-model.md`
- then use `project-protection-prism-patterns.md` to pull the work back toward repo reality

---

## Suggested invocation patterns

These skills can be used explicitly or implicitly.

### Explicit use
Example:
> Use `project-protection-threat-model.md` and `project-protection-prism-patterns.md` to analyze this repo and identify the highest-risk trust boundaries.

### Planning-first use
Example:
> Use `project-protection-priority-plan.md` to turn these findings into a today / this week / later hardening plan.

### Repo-specific use
Example:
> Read `project-protection-prism-patterns.md` and audit Prism for approval bypasses, unsafe execution paths, and unscoped file access.

### End-to-end use
Example:
> Use the `project-protection-` skill family to review this project, list concrete risks, and propose the fastest high-impact security improvements.

---

## What this family preserves

This file family preserves more than a generic security checklist.
It preserves:
- a threat-modeling method
- a prioritization method
- a product-specific adaptation for Prism-like systems
- a disciplined way to go from concern → findings → plan

That is the durable value.

---

## Naming convention

All related files should continue using the `project-protection-` prefix so the family stays visually grouped in directory listings.

Current family:
- `project-protection-index.md`
- `project-protection-threat-model.md`
- `project-protection-priority-plan.md`
- `project-protection-prism-patterns.md`

If future companion files are added, they should preserve this naming style.

---

## Final lesson

Security hardening is not one idea.
It is a repeatable method for identifying what matters, where the risk lives, and what to fix first.

This index exists so that method stays easy to find and reuse.
