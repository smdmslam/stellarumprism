# VC Pitch Deck Speaker Notes Skill

Use this skill when turning a strong, sparse pitch deck into a compelling spoken presentation for investors.

This file is a companion to:
- `./.prism/skills/vc-pitchdeck-framing.md`
- `./.prism/skills/vc-pitchdeck-framing-example-prism.md`
- `./.prism/skills/vc-pitchdeck-workflow-checklist.md`
- `./.prism/skills/vc-pitchdeck-investor-language.md`
- `./.prism/skills/vc-pitchdeck-slide-patterns.md`
- `./.prism/skills/vc-pitchdeck-redflags.md`

Keep the `vc-pitchdeck-` prefix for related skills so they group naturally in folder listings.

---

## Purpose

A sparse deck works only if the spoken narrative carries the missing depth.

The slides should create:
- clarity
- contrast
- memory
- pacing

The spoken notes should provide:
- context
- evidence
- nuance
- transitions
- confidence

The deck is not the full argument.
It is the visible spine of the argument.

---

## Core rule

Do not read the slide aloud.
The investor can already see it.

Instead, use the slide as the headline and speak to:
- why it matters
- what it implies
- what example proves it
- what transition it creates into the next slide

A good note set prevents the founder from either:
- repeating the slide verbatim
- wandering into detail unrelated to the slide's job

---

## What speaker notes should do

For each slide, notes should answer four questions:

1. What is the hidden meaning of this slide?
2. What evidence or example should I mention aloud?
3. What investor concern does this slide quietly answer?
4. How do I transition to the next slide?

If the notes do not help with these four things, they are probably too thin or too dense.

---

## The right tone

Speaker notes should sound:
- calm
- precise
- confident
- strategic
- founder-native
- unhurried

They should not sound:
- over-rehearsed
- slogan-heavy
- robotic
- hypey
- defensive
- over-explanatory

Investor confidence often comes more from delivery discipline than from raw volume of detail.

---

## The basic note structure per slide

A good default pattern is:

### 1. Opening sentence
A short spoken line that expands the slide without repeating it exactly.

### 2. Explanation
Two to four sentences explaining why the slide matters.

### 3. Example or proof point
One concrete example, incident, metric, or observation.

### 4. Transition
One sentence that naturally sets up the next slide.

This is usually enough.
Do not overbuild notes unless the founder specifically wants a near-script.

---

## What belongs in speaker notes rather than on the slide

Use notes for:
- nuance in competitive positioning
- how the founder discovered the problem
- specific incidents or anecdotes
- details behind proof points
- caveats around market sizing
- objections the investor might be forming
- connective logic between slides
- wording that is too long or subtle for the visible slide

Use slides for:
- headline claims
- memorable contrast lines
- simple lists
- category lines
- clean visual anchors

If the slide is carrying too much spoken burden, simplify it.
If the founder keeps over-talking, sharpen the notes.

---

## Common speaker-note mistakes

### Mistake 1 — Reading the slide
Why it hurts:
- wastes time
- lowers energy
- makes the founder sound less fluent

Fix:
Use the slide as the headline and add the missing meaning.

### Mistake 2 — Going too technical too early
Why it hurts:
- breaks narrative pacing
- causes investors to lose the thread
- answers diligence questions before conviction exists

Fix:
Keep early notes focused on:
- the shift
- the pain
- the insight
- the company role

Save implementation depth for later or for Q&A.

### Mistake 3 — Talking past the slide's job
Why it hurts:
Every slide should do one persuasive job.
If the notes wander, the deck loses rhythm.

Fix:
Ask for each slide:
- what should the investor believe after this slide?
Keep the note tightly tied to that outcome.

### Mistake 4 — Overselling
Why it hurts:
Overheated delivery can make even good slides feel weaker.

Fix:
Use calm confidence.
Say less, but make it sharper.

### Mistake 5 — No transition discipline
Why it hurts:
Without transitions, the deck feels like disconnected claims.

Fix:
End each note with a bridge into the next slide.

---

## Slide-by-slide note guidance

These patterns assume a standard VC deck arc.
Adjust as needed.

---

## 1. Cover / category line

### Purpose of the spoken note
Make the category line feel real, not merely elegant.

### What to say
- state in plain English what kind of company this is
- explain the market role quickly
- optionally anchor the company in one sentence of context

### What to avoid
- biography
- origin story too early
- product detail overload

### Good spoken move
> We think of Prism as the verification layer that sits between AI-generated code and production. The reason that matters is simple: software can now be created much faster than it can be trusted.

### Transition
> That shift — creation accelerating faster than trust — is the reason the category exists now.

---

## 2. Market shift

### Purpose of the spoken note
Convince the investor this is a response to a real external change, not a founder-invented niche.

### What to say
- explain what changed recently
- connect the market change to the bottleneck
- show why the old workflow no longer works cleanly

### Good spoken move
> The important change is not that AI can write code. Everyone knows that now. The deeper change is that code generation has scaled much faster than verification, so the bottleneck has moved downstream.

### Transition
> Once that bottleneck moves, the next question is what failure shows up in practice.

---

## 3. Painful problem

### Purpose of the spoken note
Make the problem concrete and emotionally believable.

### What to say
- describe the failure mode in real terms
- use a concrete example if one exists
- explain why the problem survives normal review

### Good spoken move
> The failure mode we care about is incomplete AI-generated work that looks finished enough to merge. That is more dangerous than obviously broken code, because it survives first-pass review and creates latent risk.

### Good evidence to mention
- a real refactor incident
- a bug found after tests passed
- dogfooding examples

### Transition
> What matters is that this is not a single-tool issue. It is structural.

---

## 4. Core insight

### Purpose of the spoken note
Explain the deeper truth behind the product.

### What to say
- articulate why the current architecture of adjacent tools is insufficient
- make the distinction between generation and verification
- frame the insight as inevitable, not just clever

### Good spoken move
> Our core view is that the same system that generates a change is structurally the wrong system to certify that the change is complete. Generation and verification are separate jobs.

### Transition
> Once you take that seriously, the product has to sit in a different place in the workflow.

---

## 5. Solution / company role

### Purpose of the spoken note
Explain exactly where the company fits and why that position matters.

### What to say
- describe where Prism enters the workflow
- explain what it evaluates against reality
- keep implementation language conceptual, not overly detailed

### Good spoken move
> Prism is the second pass before production. It runs after AI-generated work and checks that work against things the model cannot fake — compiler output, tests, runtime behavior, structural resolution.

### Transition
> That matters because it changes AI coding from something clever into something organizations can trust.

---

## 6. Value / buyer benefit

### Purpose of the spoken note
Turn the solution into spending logic.

### What to say
- who benefits
- why they care
- why the benefit justifies recurring spend

### Good spoken move
> For developers, this reduces fear. For teams, it lowers review burden and catches risk earlier. For enterprises, it creates a control layer around machine-generated changes. That is why this is not just a dev convenience feature.

### Transition
> The more AI-generated work enters the stack, the more necessary that control layer becomes.

---

## 7. Strategic significance / control point

### Purpose of the spoken note
Show how the company grows stronger as the market trend grows.

### What to say
- explain why demand scales with the broader shift
- explain why the workflow position is strategically valuable
- link this to recurring budget formation

### Good spoken move
> Every AI-generated diff increases the need for verification. So unlike tools that are threatened by better generation, Prism benefits from better generation because better generation means more output that still has to be trusted.

### Transition
> We start with a narrow, painful wedge where this problem is already obvious.

---

## 8. Wedge

### Purpose of the spoken note
Show the company can enter the market through a sharp, believable pain point.

### What to say
- identify the first use case clearly
- explain why this pain is acute enough to drive adoption
- connect it to future expansion

### Good spoken move
> We start with incomplete AI refactors because that is where the pain is already sharp, visible, and expensive. It is a narrow enough entry point to win, but broad enough to expand from.

### Transition
> The reason we can expand from that wedge is that the underlying system was built at the substrate level.

---

## 9. Moat / why we win

### Purpose of the spoken note
Explain why this company is structurally advantaged.

### What to say
- describe the architectural difference simply
- explain what competitors would have to change to catch up
- mention any compounding mechanism

### Good spoken move
> The key asymmetry is that most competitors started as editors and are trying to add verification later. We built the verification substrate first, so every new workflow compounds on the same foundation.

### Transition
> That shared foundation is why the product can already support more than one workflow.

---

## 10. Product surface / expansion

### Purpose of the spoken note
Show that the wedge opens into a broader platform logically rather than artificially.

### What to say
- mention current workflows
- mention natural adjacent workflows
- explain why the expansion is low-friction because of shared architecture

### Good spoken move
> Once the substrate exists, the product surface broadens naturally. Audit is the wedge, but fix, build, review, test generation, and policy gating can all ride the same underlying engine.

### Transition
> That expansion matters especially because the timing window is unusually favorable right now.

---

## 11. Why now

### Purpose of the spoken note
Make the timing feel open and actionable.

### What to say
- name the market change
- name the enabling technology or economics
- explain why the category is still available to win

### Good spoken move
> Three things changed: AI code volume is now real, whole-repo verification is now affordable, and no category leader has yet claimed this layer cleanly.

### Transition
> That timing is what makes the market large enough to matter, not just interesting in theory.

---

## 12. Market

### Purpose of the spoken note
Show the opportunity is broad without getting lost in spreadsheet talk.

### What to say
- tie the company to adjacent markets or budget lines
- show how spend emerges from the workflow problem
- stay disciplined if numbers are still provisional

### Good spoken move
> We think this sits at the intersection of AI coding, code review, software quality, and trust infrastructure. The exact market sizing can be argued, but the important point is that this becomes a recurring spend category as AI-created software expands.

### Transition
> The best way to make that concrete is to show how we sit relative to adjacent categories today.

---

## 13. Competition

### Purpose of the spoken note
Clarify the lane without sounding naive or combative.

### What to say
- acknowledge adjacent players honestly
- define what job they do well
- define the different job Prism does

### Good spoken move
> We do not think the market is empty. We think the existing products are optimized for a different primary job — mostly generation, editing, or near-merge review. Our claim is that verification after generation and before production is a distinct layer.

### Transition
> And importantly, this is not just a category claim — the product already exists and is doing real work.

---

## 14. Proof / traction

### Purpose of the spoken note
Lower execution risk and make the thesis feel real.

### What to say
- explain what is already shipped
- mention evidence of real use or validation
- keep claims proportional to stage

### Good spoken move
> This is not a concept deck. The substrate is live, multiple workflows already run on it, and our own usage has surfaced real bugs that validate the underlying need.

### Transition
> Because the workflow is real, the pricing and business model are straightforward.

---

## 15. Business model

### Purpose of the spoken note
Make the monetization feel natural and not overcomplicated.

### What to say
- who pays
- why they pay
- why it should recur
- optionally how the company moves from individual to team to enterprise

### Good spoken move
> The business model is simple: individuals pay for confidence, teams pay for shared workflow control, and enterprises pay for policy, governance, and trust infrastructure. As AI-generated code volume grows, that spend should become more recurring, not less.

### Transition
> If we are right, the long-term role of the company becomes much larger than the initial wedge.

---

## 16. Vision

### Purpose of the spoken note
Expand from current product to long-term category role.

### What to say
- describe the future state of the market
- show what the market will require if current trends continue
- place the company in that future state

### Good spoken move
> We think every AI-built company will eventually need a trust layer the same way cloud-native companies needed observability and security layers. Our ambition is to become that control plane for software trust.

### Transition
> That is the reason for the round and what it is intended to unlock.

---

## 17. Ask

### Purpose of the spoken note
State the fundraising purpose clearly and confidently.

### What to say
- what is being raised
- what it unlocks over the next phase
- why this is the right moment

### Good spoken move
> We are raising to accelerate product development, expand the verification workflows across more surfaces, and establish category leadership while the window is still open.

### Closing move
End with a short restatement of the company role.
Example:
> AI writes the code. Prism decides when it is ready.

---

## Handling sparse slides well

If the deck is intentionally minimal, do not panic-fill the silence.

Instead:
- let the headline land
- speak one level deeper than the slide
- use one concrete example, not five
- move cleanly to the next point

Sparse slides create authority when the speaker sounds in command of the missing context.

---

## How detailed notes should be

Use one of three note levels depending on the founder.

### Level 1 — bullets only
Best for confident speakers who do not want scripting.

### Level 2 — structured prompts
Best for founders who want guidance but still want natural delivery.

### Level 3 — near-script
Best when the founder wants rehearsal support or is new to fundraising.

Default to Level 2 unless asked otherwise.

---

## Q&A preparation notes

Speaker notes should also prepare for likely questions.
For each major slide, quietly note likely investor follow-ups such as:
- why now?
- why you?
- why isn't this a feature inside an incumbent?
- who pays first?
- what is the wedge exactly?
- what proof exists already?
- what would have to be true for this to become big?

If the founder can answer those cleanly, the spoken deck improves even before Q&A begins.

---

## Recommended companion usage

Use the deck-related skills together:
- `vc-pitchdeck-framing.md` for the strategic framing
- `vc-pitchdeck-framing-example-prism.md` for the case study
- `vc-pitchdeck-workflow-checklist.md` for execution order
- `vc-pitchdeck-investor-language.md` for better wording
- `vc-pitchdeck-slide-patterns.md` for slide formulas
- `vc-pitchdeck-redflags.md` for review and correction
- `vc-pitchdeck-speaker-notes.md` for spoken delivery

This creates a full stack:
- how to think
- how to structure
- how to write
- how to review
- how to present

---

## Final lesson

A sparse deck does not reduce the need for explanation.
It shifts the explanation into the founder's voice.

This skill exists to help make that voice disciplined, persuasive, and memorable.
