# Prism Skills — reference

Skills are durable behavioral guides the agent loads as ambient context. They're the layer above prompts, below tools: persistent expertise the user curates and engages on demand.

This document is the source of truth for the skill model, the size discipline, and how engagement works. Authors writing new skills should read it; users wondering why something hit a cap will land here from in-app messages.

## The model in one sentence

A skill is a small markdown file (`.md`) under `.prism/skills/` that, when **engaged** for a tab, gets included in the agent's context for that tab's turns until disengaged.

## Two distinct concepts — don't conflate

**Curation** is library hygiene. The Settings → Skills tab is the curator: browse, search, group by saved-search filter, mark which skills you've vetted as known-good. *Curation does not engage anything.*

**Engagement** is the runtime action. Open the Load modal, pick a skill (or a saved-search group), it engages for the active tab. A chip appears in the input bar's meta row. Click `×` on the chip to disengage. Engagement is **per-tab and ephemeral** — it lives in the tab's runtime state, clears when the tab closes, and is *not* persisted to localStorage or `session.json`. Curation choices persist; engagement choices don't.

If you want a skill to be "always on" across restarts, the right move today is to engage it explicitly each session via the Load modal. (A "default-engage these skills on tab open" preference may show up in a future version; it's deliberately not in v1 because engagement-as-permanent is how token costs spiral silently.)

## Size discipline — the rules

Skills are heavy. Every engaged skill rides on every turn until disengaged, paying token cost on each request. The discipline below exists to keep that cost predictable and to nudge skills toward being focused, reusable, principle-stated rather than encyclopedic.

These rules are calibrated against the **current corpus** (10 files, ~113 KB total, average ~12 KB, largest 16.9 KB). They're forcing functions, not arbitrary thresholds.

### Per-skill caps

- **Soft warn at 18 KB.** New skills over 18 KB show a yellow warning at engagement time (`"this skill is large; consider splitting into a family"`). The skill still engages — this is a nudge, not a refusal.
- **Hard cap at 32 KB.** Skills over 32 KB cannot be engaged. The Load modal refuses with a clear message naming the file and its size. To use it, split it into focused companions sharing a prefix (e.g. `vc-pitchdeck-framing.md` + `vc-pitchdeck-investor-language.md` instead of one monolithic `vc-pitchdeck.md`).

### Per-session budget

- **128 KB total** across all engaged skills in a tab. Comfortable headroom for the full `vc-pitchdeck-*` family (~99 KB) plus 1–2 more skills. Token-equivalent: ~32K tokens at the standard 4-chars-per-token estimate, which fits inside 128K context models with significant runway and is tight (but workable) on 32K models.
- When engaging a skill that would push the tab past the 128 KB budget, the Load modal refuses with a `"would exceed 128 KB skill budget — disable another first"` message. Prevents quiet over-engagement.

### Why these specific numbers

- **18 KB soft warn** sits just above the largest current skill (16.9 KB). Existing skills don't yellow-warn; new ones that grow past the corpus baseline do. The warn is a signal, not noise.
- **32 KB hard cap** gives almost 2× headroom over the largest current skill — generous enough that no real well-formed skill bumps it accidentally, tight enough to forbid encyclopedic dumps.
- **128 KB session budget** covers the full vc-pitchdeck family plus a couple more, but starts pushing back when someone tries to enable 10+ heavy skills at once.

### Future re-calibration

If the corpus average climbs significantly (say, average skill > 20 KB), or if real workflows routinely need to engage 10+ skills at once, revisit. Don't bake the numbers into so many places that adjusting them requires a refactor — they live in one place (`src/skill-limits.ts`) and can be tuned independently.

## Authoring guidelines

These complement the size caps. They're soft rules, not enforced.

- **One principle per skill.** "How to write strong investor language" is a skill. "Everything about pitch decks" is a skill family.
- **Use a shared prefix** for related skills (`vc-pitchdeck-*`, `ui-search-filtering-*`) so the file listing groups them naturally.
- **Front-load the "use this when" trigger.** The model needs to recognize when a skill applies. Skills whose first paragraph names the trigger explicitly are loaded with better instinct.
- **Avoid embedded code samples over ~10 lines.** They eat token budget. Prefer naming a pattern + a one-liner illustration; the agent can expand the sample on demand.
- **Don't repeat across skills.** If two skills both contain the same "rule of thumb," extract it into a third skill they both reference by name.

## Saved-search groups

A saved-search group is a named virtual collection defined by a search term. Toggling on a group means "engage every skill currently matching this term." The group's contents recompute live from the search term, so a new skill matching `vc` auto-joins the `vc` group on next render — no manual re-curation.

Saved groups persist in localStorage (curation-level), not in session state. Engaging a saved group via the Load modal is equivalent to engaging each of its current members — token budget rules apply to the union.

## What's not in v1 (deliberate)

- **Default-engage on tab open.** The settings toggles are curation flags ("vetted / favorited"), not "auto-engage." Engagement is always explicit per session.
- **Cross-tab engagement state.** Each tab is independent; engaging `vc-pitchdeck-framing` in tab A does not engage it in tab B.
- **Skill versioning.** A skill is whatever its `.md` file says today. If you want history, use git.
- **Skill dependencies.** No "this skill requires that skill." Express linkage in the prose ("see also `foo.md`") and let the user engage both.

## Pointers

- **Authoring**: drop a `.md` file in `.prism/skills/` (root) or under a subdirectory if you have multiple in a family. The Settings → Skills tab picks them up on next render.
- **Cap source of truth in code**: `src/skill-limits.ts` (constants + helpers).
- **Skill folder index**: `.prism/skills/README.md` lists the current families and their members.
