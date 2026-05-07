# Feature catalog protocol (inventory → pillars → use cases)

**Use this when:** mapping everything a product ships; separating exhaustive truth from investor/user narrative; avoiding doc drift and LLM invention.

## Core rule

Build the **inventory from contracts first** (APIs, CLI flags, command registries, config keys, routes). Annotate with prose docs **after**. Never treat planning markdown alone as “shipped.”

## Three artifacts (keep separate)

1. **Inventory (exhaustive)** — Table or structured list: id, user-visible name, entry point (CLI / UI / API / slash), subsystem/module, evidence (`path` or symbol), status (`shipped` | `partial` | `internal`). For completeness and support—not pitch decks.

2. **Pillars (3–5)** — Short narrative “main promises.” Each pillar links to inventory rows by id. Curated; not a dump.

3. **Use cases** — Per pillar: persona, starting state, steps (exact commands/clicks), success criteria. Reference inventory ids so stories stay honest when code changes.

## Extraction order (repeat per repo)

1. **Surface APIs**: RPC/route/command handlers, GraphQL schema, OpenAPI, `invoke`/IPC lists, main binary `--help`.
2. **Registries**: Slash commands, feature flags, recipe/task definitions, plugin manifests.
3. **Integration points**: `invoke(`, `fetch(`, CLI subprocess wrappers—catch UI-only flows (billing, settings).
4. **Cross-check** README/USAGE against (1)–(3); flag mismatches as doc bugs or dead code.

## Clustering

Group rows by architecture layer (e.g. core engine, persistence, UI, commercial). Anything that doesn’t fit → explicit bucket: pillar candidate, power-user only, or internal.

## Pillars after inventory

Draft pillars **after** the inventory exists. If the pitch needs a capability not in the inventory, either add evidence or remove the claim.

## Anti-hallucination

- One optional **machine-readable manifest** (JSON/YAML) generated or hand-maintained; regenerate when registries change.
- Tag narrative docs with **last verified** date + **git ref**.
- Keep “not shipped” only in trackers that are clearly labeled (e.g. master plan), not mixed into customer-facing lists.

## Copy-paste checklist

- [ ] Enumerate handlers/commands from code
- [ ] Enumerate registries from code
- [ ] Merge into inventory sheet with evidence column
- [ ] Cluster → assign pillar tags
- [ ] Write 3–5 pillar bullets + links to ids
- [ ] Write 2–4 use cases per pillar with ids + verification steps
- [ ] Fix README/USAGE drift where needed
