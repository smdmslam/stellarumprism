# UI Search Filtering Patterns Skill

Use this skill when designing, upgrading, or reviewing a search bar that filters visible UI items on the client side.

This file preserves a reusable method for implementing stronger in-app filtering behavior based on lessons that worked well across projects, including advanced CRM-card filtering patterns and Prism settings/skills search improvements.

Keep the `ui-search-filtering-` prefix for related future skills so they group naturally in `.prism/skills/` listings.

---

## Purpose

This skill exists to preserve a generalized method for building search/filter interfaces that feel:
- fast
- forgiving
- expressive
- composable with other filters
- understandable to users
- maintainable in code

The goal is not just to "search text."
The goal is to create filtering behavior that helps users find the right items quickly without making the UI feel brittle, noisy, or slow.

---

## When to use this skill

Use this skill when:
- filtering an already-loaded list of items in the UI
- improving a weak search bar that currently does only naive substring matching
- combining free-text search with tags, categories, toggles, or view modes
- designing settings search, skills search, notes search, CRM-card search, or similar interfaces
- deciding how to support exact phrases, multiple words, or richer query behavior

Do not treat this file as the default pattern for:
- large server-side indexed search systems
- database-level search architecture
- web-scale full-text retrieval
- ranking-heavy search engines

This skill is primarily for strong app-side filtering behavior.

---

## Core principle

A strong UI search bar should filter using a deliberate interpretation of user intent, not just a raw `includes(query)` check.

That usually means:
1. normalize the query
2. decide how to interpret it
3. search across multiple meaningful fields
4. combine the search with existing UI filters
5. sort and render the final filtered results

The search bar should act like a structured filtering layer, even when the user only sees a simple text box.

---

## High-level filtering flow

A strong default flow is:

1. user types into the search input
2. local input state updates immediately
3. a short debounce delays expensive filtering work
4. the debounced query is committed to app state
5. the filter logic normalizes the query
6. each item is tested against relevant fields
7. category/tag/toggle constraints are applied alongside text matching
8. optional semantic or intention-based matches are merged in
9. results are sorted
10. the filtered collection is rendered

This pattern keeps the UI responsive while preserving expressive behavior.

---

## Recommended query normalization

Before matching, normalize the query.

### Normalize at minimum
- trim whitespace
- lowercase the query
- collapse accidental spacing if needed
- treat empty input as no text filter

### Why
This removes superficial differences and keeps the matching behavior consistent.

### Example
- `"  Revenue Ops  "` → `"revenue ops"`
- `"CRM   workflow"` → `"crm workflow"`

---

## Recommended search modes

A robust filtering system often supports more than one interpretation mode.

### 1. `any`
Match if any search word or phrase is found.

Use when:
- users want broad recall
- exploratory searching is common
- missing a possible result is worse than showing extras

Example:
- query: `pipeline investor`
- item matches if it contains `pipeline` or `investor`

### 2. `all`
Match only if all query words or phrases are found.

Use when:
- users want narrower results
- queries often contain multiple required concepts
- precision matters more than breadth

Example:
- query: `pipeline investor`
- item must contain both `pipeline` and `investor`

### 3. `exact`
Match the exact phrase as typed.

Use when:
- users know the phrase they want
- title or label matching matters
- the UI should support explicit phrase search

Example:
- query: `"customer memory"`
- item must contain the exact phrase `customer memory`

### 4. optional `intention` / semantic mode
Allow results to come from semantic similarity or inferred relevance, not only literal substring matches.

Use when:
- a smarter search mode is valuable
- synonyms and concept-level matching matter
- the product already has an embedding or AI layer

### Rule
If multiple modes exist, keep behavior legible. Users should not feel the search is random.

---

## Interpreting the query string

The text input can carry more structure than it first appears.

### A strong default interpretation model
- quoted text → exact phrase mode
- comma-separated terms → treat as phrases or distinct filter clauses
- unquoted space-separated words → interpret according to `any` or `all` mode

### Example interpretations
- `sales pipeline` → two words
- `"sales pipeline"` → one exact phrase
- `sales pipeline, investor notes` → two phrase-like clauses

### Why this helps
It gives users more expressive power without requiring a complex advanced-search UI.

---

## Fields to search across

Search should usually inspect more than one field.

### Strong default candidates
- title / name
- body / content / description
- tags
- category
- aliases or alternate labels
- derived metadata that the user would reasonably expect to match

### Important rule
Search the fields that represent user meaning, not just whatever text is easiest to access.

### Example
For a skills/settings browser, good searchable fields might include:
- skill title
- summary
- tags
- category/group name
- file name if users see or reason about file names

For CRM cards, good fields might include:
- company name
- contact name
- notes preview
- tags
- stage/category

---

## Matching logic pattern

For each item, create normalized field strings and test whether the query units appear in any relevant field.

### Good implementation pattern
- normalize the item fields once per filtering pass
- keep a helper like `fieldsContain(text)`
- evaluate `any` / `all` / `exact` against those normalized fields

### Example shape
- `title.includes(text)`
- `content.includes(text)`
- `tags.includes(text)`
- `category.includes(text)`

### Rule
The text-matching logic should be centralized, not duplicated across multiple components.

---

## Performance guidance

Advanced filtering should still feel instant.

### Recommended practices
- debounce text input before committing the query
- use a short debounce, often around 150–300ms
- avoid reprocessing very large text blobs if only a preview slice is needed
- memoize filtering work where appropriate
- keep the matching logic simple and predictable unless a semantic layer is explicitly enabled

### Practical pattern
If an item has a very large content field, consider searching only the first meaningful portion for fast client-side filtering.

Example:
- search the first 1000–3000 characters of a body field
- include full title/tags/category regardless

### Rule
A search bar that is theoretically powerful but feels laggy will often be perceived as worse than a simpler one.

---

## Debounce pattern

A strong input pattern is:
- keep local input state for immediate typing responsiveness
- debounce updates to the shared search state
- flush immediately on Enter if desired
- clear immediately when the user clicks a clear button

### Why
This gives the user responsive typing while reducing repeated expensive filter recomputation.

### Recommended default
- `250ms` is a strong starting point

### Rule
Debounce the expensive work, not the visible typing feedback.

---

## Combining search with other filters

Text search is usually only one layer of the filtering system.

### Common companion filters
- selected category
- selected tags
- pinned/starred state
- recent-only mode
- focused-only mode
- item-type toggles
- visibility toggles

### Strong rule
Treat search as one predicate in a broader filter pipeline, not a separate disconnected feature.

### Good conceptual order
1. basic visibility/safety constraints
2. category or view-mode constraints
3. tag constraints
4. special-state constraints
5. text-search matching
6. sorting

### Why this matters
It keeps the behavior predictable and prevents confusing mismatches between search results and active UI filters.

---

## Semantic or AI-assisted matches

If the product supports semantic search, it should usually act as an optional extra layer, not a replacement for understandable literal search.

### Good hybrid pattern
- run the standard text filter logic
- separately compute semantic matches
- merge semantic matches into the result set when the mode calls for it

### Why
This preserves precision and legibility while still allowing smarter discovery.

### Rule
If semantic matches bypass strict text rules, that should be intentional and scoped to the appropriate search mode.

---

## Sorting after filtering

Filtering and sorting should be treated as separate steps.

### Good rule
First decide what matches.
Then decide how to order the matches.

### Possible sort choices
- recent first
- alphabetical
- pinned first
- relevance-like ordering
- category grouping

### Why
Mixing matching logic and sorting logic too early makes the system harder to reason about and maintain.

---

## UX guidance

A stronger search experience is not only about logic. It is also about how the behavior feels.

### Good UX traits
- immediate visible typing response
- forgiving matching
- no surprising disappearance of obviously relevant items
- stable results when typing incrementally
- clear reset behavior
- predictable interaction with other active filters

### Helpful affordances
- placeholder text that hints at supported behavior
- clear button
- optional mode selector if multiple search modes are exposed
- empty-state text that explains why nothing matched

### Rule
If the filtering system becomes more expressive, the UX should stay simple.

---

## Anti-patterns to avoid

### 1. Raw one-field matching only
Avoid filtering only a title field if users clearly expect tags, category, or content to count.

### 2. No debounce on expensive filtering
Avoid recomputing heavy filters on every keystroke if the item set is non-trivial.

### 3. Hidden search rules
Avoid clever parsing behavior that users cannot discover or predict.

### 4. Duplicated filtering logic in many places
Avoid copying slightly different filter rules into multiple components.

### 5. Search ignoring active filters
Avoid showing results that appear to violate selected category/tag constraints unless a special mode explicitly allows it.

### 6. Overloading semantic search silently
Avoid mixing AI matches into ordinary search without a clear mode or rationale.

### 7. Searching huge content bodies naively
Avoid unnecessary full-body scans if a preview slice is sufficient for the UI use case.

---

## Implementation checklist

Use this checklist when designing or upgrading a search bar.

### Query handling
- [ ] trim and normalize the query
- [ ] lowercase query and target fields
- [ ] handle empty input cleanly
- [ ] decide whether to support `any`, `all`, and `exact`
- [ ] decide whether quoted text should trigger exact matching
- [ ] decide whether comma-separated phrases are supported

### Match targets
- [ ] identify all fields users expect to be searchable
- [ ] normalize those fields consistently
- [ ] centralize the `fieldsContain(...)` logic

### Performance
- [ ] use local input state plus debounce
- [ ] choose a reasonable debounce duration
- [ ] avoid scanning unnecessarily large text fields
- [ ] memoize filtering when appropriate

### Filter composition
- [ ] define how text search interacts with category/tag/toggle filters
- [ ] define the predicate order clearly
- [ ] keep sorting as a separate step after filtering

### Optional intelligence layer
- [ ] decide whether semantic search exists
- [ ] keep semantic behavior scoped and intentional
- [ ] ensure ordinary text search remains understandable

### UX
- [ ] provide a clear input reset path
- [ ] ensure empty states are intelligible
- [ ] ensure results feel stable while typing
- [ ] ensure search behavior matches user expectations

---

## Reusable implementation shape

A strong implementation often separates responsibilities like this:

### Input component
Responsible for:
- local input state
- debounce timer
- Enter-to-search or immediate flush behavior
- clear/reset button

### App or container state
Responsible for:
- owning the committed query
- resetting related view state if needed
- coordinating text search with other filters

### Filtering hook or utility
Responsible for:
- normalization
- query parsing
- multi-field matching
- composing text search with category/tag/toggle predicates
- sorting results

### Rule
Keep UI interaction logic separate from the core filter engine.

---

## Generalized lesson from successful implementations

When an upgraded search bar works especially well, the success usually does not come from one trick.
It comes from combining several good patterns:
- a debounced input
- normalized query handling
- multi-field matching
- richer query interpretation
- clean composition with other filters
- performance discipline
- predictable UX

That combination is the reusable method.

---

## What to preserve after a successful filtering upgrade

When a search/filter improvement works well, do not preserve only the finished code.
Preserve the method too.

Save:
1. the generalized filtering skill
2. one or more project-specific examples
3. especially effective query-parsing rules
4. notable UX decisions
5. any performance lessons learned

### Checklist
- [ ] save the reusable method as a general skill
- [ ] save a concrete example if the implementation is especially instructive
- [ ] preserve naming conventions and mode definitions
- [ ] preserve performance and UX lessons

### Rule
The best implementation wins should compound into reusable product knowledge.

---

## Suggested future companion files

If this becomes a skill family later, keep the same prefix.

Examples:
- `ui-search-filtering-example-crm-cards.md`
- `ui-search-filtering-example-prism-skills.md`
- `ui-search-filtering-query-modes.md`
- `ui-search-filtering-ux-guidelines.md`

---

## Final lesson

A good search bar does not merely look through text.
It interprets intent, searches the right fields, cooperates with the rest of the UI, and returns results fast enough to feel effortless.

This skill exists to make that standard repeatable.
