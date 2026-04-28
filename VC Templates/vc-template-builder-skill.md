# VC Template Builder Skill

Use this skill when the goal is to create a reusable pitch-deck template inspired by a reference company, investor, studio, media brand, or design-forward organization.

This skill captures the repeatable process for turning a real-world example brand into a structured template system that can be reused for future decks.

Keep the `vc-template-builder-` filename prefix for related companion skills so they group naturally in `.prism/skills/` listings.

---

## Goal

Produce a reusable template that does **not** copy the source brand mechanically, but instead translates its style into a practical pitch-deck system.

A good output should preserve:
- visual character
- messaging posture
- narrative structure
- slide patterns
- tone and pacing
- applicability to future decks

A good output should avoid:
- trademark mimicry
- direct copying of proprietary assets
- shallow aesthetic imitation without strategic logic
- vague style descriptions that cannot be operationalized

---

## What this skill is for

Use this process when a user says things like:
- “Make a pitch deck template based on a16z / Sequoia / Benchmark / Apple / Stripe.”
- “Use this company as an example style reference.”
- “Turn this brand into a reusable deck template.”
- “Research their style, then make a template.”
- “Create a family of VC-inspired pitch deck templates.”

This skill is best when the task is **template creation from reference**, not just deck writing.

---

## Core principle

Do not ask only:
> What does this brand look like?

Also ask:
> How does this brand make ideas feel?
> How does this brand structure narrative?
> What is the repeatable system underneath the surface style?

The goal is to extract a **template logic**, not a mood board.

---

## Standard workflow

Follow these phases in order.

1. Define the objective
2. Select and validate the reference company
3. Decide whether live web research is needed
4. Perform first-pass style research
5. Synthesize initial style direction
6. Perform second-pass source-specific research
7. Convert findings into template principles
8. Create the structured template artifact
9. Save outputs clearly
10. Capture reusable method for future templates

---

## Phase 1 — Define the objective

Before researching, clarify what the user wants from the reference.

### Questions to answer
- Is the user asking for visual inspiration, narrative inspiration, or both?
- Is the template meant for VC decks specifically, or also partner decks / thesis decks / product decks?
- Is the goal to emulate prestige, clarity, boldness, editorial polish, or technical depth?
- Is the user asking for a single template, or a template family?

### Checklist
- [ ] confirm the reference company or brand
- [ ] confirm the deck type
- [ ] confirm whether the goal is style, structure, tone, or all three
- [ ] confirm whether outputs should be saved to files

### Rule
If the user says “use X as a template,” do not assume they mean visual style only.
Clarify or infer the strategic intent.

---

## Phase 2 — Select and validate the reference company

Choose a reference that is actually useful as a deck-template model.

### Good references usually have
- recognizable brand language
- clear point of view
- strong editorial or design consistency
- strong public-facing materials
- enough public evidence to research

### Weak references usually have
- inconsistent brand presence
- little public material
- weak visual identity
- unclear investor-facing language

### Checklist
- [ ] confirm the company is a strong reference candidate
- [ ] check whether public-facing materials likely exist
- [ ] identify whether the brand is useful for visual style, narrative style, or both

### Rule
Do not force a brand into a template model if there is too little material to support it.

---

## Phase 3 — Decide whether live web research is needed

Use live web research when the task depends on current real-world brand/style evidence.

### Research is especially useful for
- current brand expression
- site design patterns
- public reports
- social thumbnails
- podcast/video cover art
- articles and editorial layouts
- visible positioning language

### You may not need live research if
- the user wants only a conceptual template direction
- the style is already well known and the user wants speed over precision
- there is already a strong local artifact to use as the source

### Checklist
- [ ] decide whether current public brand behavior matters
- [ ] use web search when freshness matters
- [ ] avoid pretending to know current brand expression without evidence

### Rule
When the user asks for “current” or “live” style analysis, use live web search.

---

## Phase 4 — First-pass style research

Start broad.
The first pass should identify the overall brand feel before diving into specific assets.

### Research targets
- brand style
- website tone
- typography signals
- color or contrast system
- editorial posture
- messaging style
- overall visual character

### Example query patterns
- `[brand] brand style website typography color editorial design`
- `site:[brand domain] [brand] report PDF design branding presentation style`
- `[brand] website design brand identity newsletter podcast visual style`

### Output of phase 4
Produce a concise synthesis of:
- what the brand feels like
- the strongest visible traits
- what this likely means for a deck template

### Checklist
- [ ] identify 3-7 strong style signals
- [ ] identify whether the brand is restrained, bold, playful, technical, editorial, etc.
- [ ] identify likely implications for slide design and narrative tone

### Rule
Do not overclaim specifics if the first-pass evidence is broad or indirect.

---

## Phase 5 — Synthesize the initial style direction

After first-pass research, translate observations into template language.

### Output should include
- brand attributes
- design principles
- tone guidance
- likely slide behavior
- what to avoid

### Good synthesis format
- “This brand feels like…”
- “Therefore the deck should…”
- “Avoid…”

### Checklist
- [ ] convert observations into practical rules
- [ ] make the synthesis usable before doing deeper research
- [ ] state clearly which points are direct observations vs. inferences

### Rule
A template direction should already be useful after this phase, even if not yet final.

---

## Phase 6 — Second-pass source-specific research

Go deeper into the actual public artifacts.

### Research targets
- key site pages
- article layouts
- long-form reports
- “big ideas” / annual predictions / thesis pages
- podcast covers
- YouTube thumbnails
- social graphics
- slide decks or public presentations
- PDF reports if available

### What to extract
- recurring page structure
- hero-image behavior
- typography hierarchy
- headline style
- density of information
- light vs dark modes
- how media is framed
- how claims are made
- how thumbnails/covers balance text and image

### Checklist
- [ ] inspect site pages
- [ ] inspect public reports or thesis pages
- [ ] inspect article-page patterns
- [ ] inspect social/podcast/video visual patterns
- [ ] inspect public PDFs/slides if any exist
- [ ] note what is present and what is absent

### Rule
If PDFs are not clearly available, say so. Do not invent them.

---

## Phase 7 — Convert findings into template principles

This is the key transformation step.
The goal is to turn research into a reusable deck system.

### Required outputs
1. Core aesthetic summary
2. Brand attributes
3. Layout rules
4. Typography rules
5. Color rules
6. Image / proof-element rules
7. Messaging rules
8. Narrative arc
9. Slide-by-slide structure
10. Do / don’t guidance

### Translation examples
- “single-column web editorial pages” → use spacious, simple slide composition
- “bold prediction headlines” → every slide headline should make a claim
- “dark podcast covers with strong type” → use dramatic divider slides sparingly
- “data-heavy reports” → charts and market visuals should carry meaning, not decoration

### Checklist
- [ ] convert each major observation into a repeatable template rule
- [ ] separate body-slide style from hero/divider-slide style if needed
- [ ] ensure the messaging system matches the visual system

### Rule
Never stop at description. Every observation should become a design or writing rule.

---

## Phase 8 — Create the structured template artifact

Write a saved template document that another person or agent could reuse later.

### Recommended template file structure
```md
# [Brand]-Inspired Pitch Deck Template

## Brand Attributes
## Core Design Principles
## Visual System
### Layout Rules
### Typography Rules
### Color System
### Imagery and Proof Elements
## Messaging System
### Tone
### Headline Rules
### Narrative Arc
## Slide-by-Slide Template Structure
## Reusable Slide Rules
## Do / Don't Guide
## Sample Headline Bank
## Usage Notes
## Future Variants
```

### Checklist
- [ ] give the file a clear name
- [ ] make the file fully reusable without the original conversation
- [ ] include examples where useful
- [ ] make the structure scannable

### Rule
The saved template should stand on its own as a durable artifact.

---

## Phase 9 — Save outputs clearly

Store outputs in obvious locations and with stable names.

### Suggested path pattern
- `VC Templates/[brand]-template.md`
- `VC Templates/[brand]-research.md`
- `VC Templates/[brand]-notes.md`

### Checklist
- [ ] save the structured template file
- [ ] optionally save research notes separately
- [ ] confirm the path back to the user

### Rule
File names should be human-readable and easy to browse later.

---

## Phase 10 — Capture reusable method

If the process worked well, preserve it as reusable institutional knowledge.

### Save or update
- a general template-builder skill
- brand-specific template artifacts
- prompt recipes that worked
- optional brand-family index files

### Checklist
- [ ] preserve the method, not just the output
- [ ] update skill-family indexes if needed
- [ ] make future reuse easier

### Rule
Successful one-off template work should compound into a repeatable system.

---

## Recommended response pattern in live sessions

A strong live-session sequence looks like this:

1. confirm the reference brand
2. explain whether internet research is worthwhile
3. do a first-pass web search
4. synthesize the initial style direction
5. do a second-pass source-specific search
6. synthesize a stronger style system
7. create the structured template file
8. save it to the agreed folder

This sequence worked well for the a16z example and should be reused.

---

## Quality bar for a finished brand-inspired template

A finished template is strong if it:
- feels clearly derived from the reference brand
- avoids direct copying
- includes both visual and narrative guidance
- can be reused across multiple startups
- gives clear slide structure
- contains enough rules that another agent could execute it consistently

A finished template is weak if it:
- only lists adjectives
- only lists colors and fonts
- copies a brand superficially
- lacks narrative guidance
- cannot be used without extra explanation

---

## Research caution

Do not represent speculative claims as direct brand facts.

Use distinctions like:
- observed from live results
- inferred from recurring patterns
- not clearly verified

This matters especially when discussing:
- exact typography
- exact color palette
- official PDFs
- internal brand systems
- claimed design intent

---

## Reusable prompt patterns

### Prompt pattern 1 — broad research
> Pull live web search on [brand]'s current brand and style.

### Prompt pattern 2 — second pass
> Do the second pass on: site pages, public reports, article-page patterns, social thumbnails, podcast covers, and any public PDFs/slides.

### Prompt pattern 3 — template creation
> Great. Let’s create the full structured template.

### Prompt pattern 4 — method capture
> Now that we have a process that works, create a template builder skill that includes all these steps.

---

## Suggested companion skills to add later

If this family grows, create companions such as:
- `vc-template-builder-research-queries.md`
- `vc-template-builder-brand-signal-checklist.md`
- `vc-template-builder-example-a16z.md`
- `vc-template-builder-output-schema.md`

---

## Final lesson

A useful brand-inspired pitch deck template is not made by copying a brand’s surface design.
It is made by extracting the brand’s repeatable logic for:
- attention
- credibility
- narrative
- hierarchy
- proof
- visual restraint or emphasis

That logic is what turns research into a reusable template system.
