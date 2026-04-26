# VC Pitch Deck Framing Skill

Use this skill when the user wants to create, rewrite, or sharpen a venture-capital pitch deck from existing product docs, prior decks, architecture notes, market research, or codebase materials.

The job is **not** to merely describe the product. The job is to make the investor immediately understand **why owning this company matters**.

A fundable deck is not a feature list. It is a value-transfer argument.

---

## Core principle

Do not lead with what the product *is*.
Lead with what the investor *gets* because the product exists.

Translate:
- features → economic value
- architecture → defensibility
- workflow → budget line
- product behavior → market power
- technical differentiation → moat
- narrow use case → wedge into larger platform

The investor must feel:
1. this company sits at a valuable control point
2. demand grows with a real market shift
3. the wedge is sharp enough to win adoption
4. the expansion path is large
5. competitors will take time to catch up

---

## Required inputs

Before drafting, gather as many of these as possible:

1. the current or prior pitch deck
2. the main product positioning doc
3. any architecture / strategy / competition docs
4. evidence of traction, shipped product, dogfooding, or usage
5. pricing assumptions if they exist
6. market data only if needed to support the narrative

If source material exists in the repo, read it end-to-end when possible rather than relying on retrieval fragments.

---

## Framing rules

### 1. Start with the market shift
Open with the change in the world that makes the company inevitable.

Examples:
- software creation accelerated; verification did not
- AI increased code volume; trust did not keep pace
- generation became abundant; proof became scarce

This sets up the company as a response to a macro shift, not a niche utility.

### 2. Name the painful failure clearly
Describe the expensive, frequent, emotionally resonant failure mode.

Good deck problems are:
- concrete
- easy to visualize
- costly
- already happening

Avoid vague framing like:
- developers need better productivity
- teams want smarter tooling

Prefer:
- AI-generated work looks complete when it is not
- hidden defects survive until merge or production
- the same agent that wrote the change is grading its own work

### 3. Separate the job from neighboring categories
Define what adjacent tools do, then define Prism's distinct job.

Pattern:
- editors generate
- assistants help write
- review bots comment near merge
- static tools scan for rules
- Prism verifies what is safe to ship

This creates a category boundary.

### 4. State the insight as an aphorism
Compress the thesis into a short, repeatable sentence.

Good examples:
- The editor should not grade its own homework.
- Software creation accelerated. Verification did not.
- AI writes the code. Prism decides when it is ready.

The best deck lines should sound easy to repeat after the meeting.

### 5. Present the wedge before the platform
The initial use case must be narrow, painful, and urgent.
Then widen the story into the broader market.

Pattern:
- wedge: incomplete AI refactors / second-pass verification
- expansion: PR review, CI gates, build, test-gen, explain, enterprise policy
- destination: trusted operating layer / control plane / trust layer

### 6. Recast technical depth as defensibility
Do not dump implementation details early.
Instead convert them into strategic meaning.

Translate like this:
- substrate cells → deterministic verification engine
- markdown artifacts → durable institutional memory
- model router → vendor resilience + cost elasticity
- shared tooling across workflows → compounding platform economics
- full-document reads → comprehensive context competitors cannot match easily

### 7. Make the product sound like infrastructure, not a trick
Investor-friendly nouns:
- layer
- control point
- control plane
- trust layer
- system of record
- verification substrate
- gating layer

Avoid making the company sound like a clever plugin unless the user explicitly wants that tone.

### 8. Show why the company matters more as AI adoption rises
The strongest venture sentence is often of the form:

> the more X grows, the more Y becomes necessary

Examples:
- the more code AI writes, the more verification the stack requires
- the more machine-generated software enters production, the more trust infrastructure becomes mandatory

Tie the company's demand curve to a growing macro behavior.

---

## Slide-writing rules

### Use the Jobs-style slide rhythm when requested
If the user asks for a Steve Jobs / Apple style deck:
- one claim per slide
- short headline
- minimal body copy
- strong contrast
- memorable phrasing
- no dense paragraphs unless explicitly requested

A good slide often has:
1. a headline claim
2. 1–3 short supporting lines or bullets
3. one punchline

### Lead with value, not implementation
Do **not** open the deck with:
- number of tools
- test counts
- architecture diagrams
- technical benchmark details
- UI features

Those can appear later under proof, defensibility, or product surface.

### Good slide progression
A strong default order is:
1. cover / category line
2. market shift
3. painful problem
4. core insight
5. solution
6. user / buyer value
7. why this matters economically
8. wedge
9. moat / why this wins
10. product surface / expansion
11. why now
12. market
13. competition
14. proof / traction
15. business model
16. vision
17. ask

This can be compressed or expanded, but preserve the logic.

### Every slide should earn its place
Ask of each slide:
- does this deepen belief?
- does this make the company feel bigger, sharper, or more defensible?
- is this investor-relevant, or merely product-descriptive?

If it is merely descriptive, cut or rewrite it.

---

## Transformation rules: from technical doc to investor deck

When reading source material, extract and transform as follows.

### A. Problem extraction
Look for:
- real incidents
- repeated bug patterns
- failure modes users already accept as normal
- examples with emotional force

Turn them into:
- a clear problem slide
- a wedge slide
- a proof-of-need talking point

### B. Architecture extraction
Look for:
- what is structurally different about the product
- what had to be built first
- what competitors would struggle to retrofit

Turn them into:
- moat slide
- why-now slide
- competitive differentiation

### C. Workflow extraction
Look for:
- where the product sits in a real process
- what expensive human labor it reduces
- how it changes adoption of adjacent tools

Turn them into:
- value slide
- economic logic slide
- expansion path slide

### D. Market extraction
Look for:
- broad category growth
- adjacent spend categories
- behavior shifts already underway

Turn them into:
- market slide
- urgency slide
- strategic inevitability framing

### E. Proof extraction
Look for:
- shipped product
- test coverage
- bug finds
- live workflows
- design pilots
- active usage

Turn them into:
- proof / traction slide
- de-risking claims

---

## What to avoid

Avoid these common failure modes:

### 1. Product brochure mode
Bad:
- lists of tools
- lists of features
- too many implementation details
- UI walkthrough disguised as strategy

### 2. Generic AI deck language
Bad:
- revolutionizing software development
- empowering developers
- transforming workflows
- intelligent code assistance

These phrases are weak unless tied to a specific economic claim.

### 3. Overclaiming
Unless the repo or evidence supports it, avoid:
- nobody does this
- no competition exists
- impossible to copy
- every developer uses AI

Prefer:
- no clear category leader has emerged
- most tools optimize for generation first
- verification remains underserved
- current products focus primarily on writing, not proving

### 4. Leading with TAM too early
TAM supports the story. It is not the story.
Lead with the pain, the shift, and the control point first.

### 5. Letting the deck sound like a devtools demo
This is especially important for technical founders.
The deck should make the company sound strategically inevitable, not merely technically impressive.

---

## Reusable prompting patterns

These are high-value prompt patterns worth reusing.

### Pattern 1 — redirect from feature list to value
Use analogies that force the model to think in consequences, not specs.

Example approach:
> A new weapon is not compelling because of the spec sheet. It is compelling because of what it can do, at what distance, with what effect. Do the same here: explain why owning this product creates value, not merely what it is.

### Pattern 2 — enforce slide style
Example approach:
> Think Steve Jobs. Each slide should feel like one hard statement. POW. Make the point in seconds.

### Pattern 3 — investor diction
Example approach:
> Make obvious why owning this company gives a competitive edge, why users derive value, why competitors will take time to catch up, and why the market is large enough to matter.

### Pattern 4 — separate analysis from artifact
First discuss:
- what is wrong with the current deck
- what the investor should feel instead
- what narrative spine the deck needs

Only then draft the new deck.

### Pattern 5 — use whole-document context
If the repo has multiple relevant docs, read them before drafting.
The deck should synthesize from:
- prior deck
- product positioning doc
- competition doc
- strategy doc
- market research if necessary

This improves coherence and reduces generic output.

---

## Recommended workflow

1. Read the current deck and identify why it feels descriptive rather than investable.
2. Read the main product/strategy docs end-to-end.
3. Identify the true company-level thesis:
   - control point
   - market shift
   - wedge
   - moat
   - expansion
4. Explain the new narrative spine in plain English before writing slides.
5. Draft a new slide sequence optimized for investor belief, not technical completeness.
6. Keep slides sparse; move depth into speaker notes if needed.
7. If TAM, pricing, or traction numbers are weak or provisional, keep wording broad and credible.
8. Use calmer wording instead of brittle absolutes.
9. End with a line that summarizes the company's role in the market.

---

## Preferred one-line framings

Use or adapt lines like these when they fit the company:

- The verification layer for AI-built software.
- AI generates the code. Prism makes it safe to ship.
- The second pass before production.
- The control plane for software trust in the AI era.
- Others help create code. Prism helps trust it.
- Competitors built editors. We built the trust layer.

These work because they are short, contrastive, and category-defining.

---

## Artifact guidance

When possible, produce two outputs:

1. the sparse deck itself
2. a companion notes file with speaker guidance, rationale, and optional supporting detail

Suggested filenames:
- `docs/vc-pitchdeck-<n>.md`
- `docs/vc-pitchdeck-<n>-notes.md`

If preserving lessons from a successful session, also save a reusable skill like this one under:
- `./.prism/skills/`

---

## What success looks like

A successful pitch deck rewrite causes the founder to say some version of:
- this finally sounds investable
- this gets to value fast
- this makes the company feel bigger than the feature set
- this explains why the market pull strengthens as AI grows
- this makes the wedge, moat, and expansion path obvious

If the result still reads like a system overview, it is not done.

---

## Case-study lesson from Prism

In this repository, the strong deck did **not** come from inventing new facts.
It came from reframing existing facts.

The shift was:
- from application description → company value
- from technical inventory → strategic position
- from feature list → control point
- from refactor auditor only → verification layer for AI-built software
- from narrow capability → wedge into trusted infrastructure

That is the core lesson this skill is meant to preserve.
