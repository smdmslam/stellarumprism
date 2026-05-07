# VC Pitch Deck Slide Patterns Skill

Use this skill when drafting or revising a VC pitch deck and you want reusable slide formulas that can be adapted across companies, products, and markets.

This file is a companion to:
- `./.prism/skills/vc-pitchdeck-framing.md`
- `./.prism/skills/vc-pitchdeck-framing-example-prism.md`
- `./.prism/skills/vc-pitchdeck-workflow-checklist.md`
- `./.prism/skills/vc-pitchdeck-investor-language.md`

Keep the `vc-pitchdeck-` prefix for related skills so they group naturally in folder listings.

---

## Purpose

A strong pitch deck is not just a collection of facts. It is a sequence of slide patterns, each doing a specific job in building investor belief.

This skill captures common slide types that work well in venture decks, along with:
- what each slide is trying to achieve
- what language pattern it should use
- what should appear on the slide
- what should be avoided

Use these patterns as templates, not rigid rules.

---

## Pattern 1 — Cover / category line

### Job
State what kind of company this is in one sentence.
The investor should know the category claim immediately.

### Formula
- company name
- category-defining line
- short subline if needed

### Example structure
- `Prism`
- `The verification layer for AI-built software.`
- `AI generates the code. Prism makes it safe to ship.`

### What makes it work
- short
- category-defining
- easy to repeat
- sounds larger than a feature

### Avoid
- opening with product details
- opening with technical inventory
- vague taglines with no category signal

---

## Pattern 2 — Market shift

### Job
Explain what changed in the world that makes the company matter now.

### Formula
- headline with contrast or imbalance
- 1–3 lines explaining the shift
- one line tying the shift to urgency

### Example structure
- `Software creation accelerated. Verification did not.`
- AI is increasing the volume of production code.
- Trust and verification have not scaled at the same rate.
- The bottleneck has moved.

### What makes it work
- names the macro tailwind
- creates inevitability
- makes the company feel like a response to a real market movement

### Avoid
- generic “the world is changing” language
- long history lessons
- TAM statistics before the shift is understood

---

## Pattern 3 — Painful problem

### Job
Make the failure mode easy to grasp and emotionally real.

### Formula
- short headline naming the problem
- specific forms the problem takes
- one punchline stating why it is dangerous or costly

### Example structure
- `AI code fails silently.`
- incomplete refactors
- broken callers
- stale imports
- hidden regressions that survive until merge or production
- `The most dangerous bugs are the ones that look finished.`

### What makes it work
- concrete
- memorable
- easy to visualize
- costly enough to justify buying something

### Avoid
- vague productivity language
- abstract engineering pain with no concrete failure

---

## Pattern 4 — Core insight

### Job
Show the company sees something others miss.

### Formula
- aphoristic or contrast-based headline
- 2–4 lines explaining the insight
- one sentence defining the implication

### Example structure
- `The editor should not grade its own homework.`
- The same system that generates the change is not the right system to certify it.
- Generation and verification are different jobs.
- `That is why Prism exists.`

### What makes it work
- sounds like a truth, not a slogan
- creates category separation
- gives the company intellectual legitimacy

### Avoid
- jargon-heavy explanation
- too many nested concepts

---

## Pattern 5 — Solution / company role

### Job
Define what the company is and where it sits in the workflow.

### Formula
- headline naming the role
- short description of where it fits
- evidence-oriented line about how it works conceptually

### Example structure
- `Prism is the second pass before production.`
- Run Prism after AI-generated work.
- It checks the change against reality: compiler, tests, runtime, structure.
- `Prism asks what can be proven.`

### What makes it work
- gives the company a clear job
- locates it in the workflow
- sounds infrastructural rather than cosmetic

### Avoid
- overexplaining implementation
- turning the slide into a feature catalog

---

## Pattern 6 — Value / buyer benefit

### Job
Translate the product into buyer outcomes.

### Formula
- headline about trust, cost, speed, safety, or leverage
- short sub-sections by user or buyer type
- one punchline showing why spending happens

### Example structure
- `Prism turns AI coding into a system teams can trust.`
- For developers: ship faster with less fear.
- For teams: reduce review load and catch regressions earlier.
- For enterprises: add an auditable control layer.
- `Prism increases AI adoption by reducing AI risk.`

### What makes it work
- shows who benefits
- turns product into budget logic
- connects user value to buyer value

### Avoid
- generic “improves productivity” language without specifics
- only talking about users, not buyers

---

## Pattern 7 — Economic or strategic significance

### Job
Show why the company strengthens as the market trend grows.

### Formula
- headline tying demand to a broader trend
- explanation of the growth logic
- line framing the company as a control point

### Example structure
- `Every AI-generated diff creates demand for verification.`
- As AI writes more code, trust and gating become more necessary.
- Prism sits between generation and production.
- `This is where trust becomes recurring spend.`

### What makes it work
- links market growth to company growth
- explains why timing matters
- gives the business a compounding logic

### Avoid
- claiming scale without explaining why demand grows
- weak “big market” statements with no mechanism

---

## Pattern 8 — Wedge

### Job
Show where the company enters the market first and why that entry point is sharp.

### Formula
- headline naming the initial pain point
- a few examples of that pain point
- one line connecting wedge to expansion

### Example structure
- `Start where the pain is sharpest: incomplete AI refactors.`
- missed callers
- stale imports
- half-rewired systems
- hidden assumptions across files
- `A sharp wedge wins adoption. Then expands.`

### What makes it work
- shows focus
- makes adoption believable
- creates a path into a bigger story

### Avoid
- pretending the company does everything on day one
- making the wedge so narrow it feels tiny and terminal

---

## Pattern 9 — Why we win / moat

### Job
Explain why this company is structurally advantaged.

### Formula
- headline stating the asymmetry
- 3–5 bullets on why the architecture or workflow is different
- one compounding line

### Example structure
- `Competitors built editors. We built the verification substrate.`
- deterministic engine below the model
- persistent project memory
- shared foundation across workflows
- model-agnostic routing
- repo-native artifacts that accumulate
- `Trust compounds.`

### What makes it work
- sounds structural
- separates architecture from features
- suggests incumbents are aimed elsewhere

### Avoid
- feature-by-feature bragging
- vague “best team” or “first-mover” claims without substance

---

## Pattern 10 — Product surface / platform expansion

### Job
Show that the initial wedge expands into a broader product surface.

### Formula
- headline about one foundation / multiple workflows
- “today” versus “next” structure
- line showing the wedge-to-platform logic

### Example structure
- `One substrate. Multiple workflows.`
- Today: audit, fix, build, test-gen, CI gate
- Next: review PR, explain, policy controls, deeper runtime verification
- `The wedge is verification. The platform is trusted AI software development.`

### What makes it work
- shows breadth without losing focus
- makes the company feel larger than the entry point
- supports venture scale

### Avoid
- chaotic feature lists
- roadmap inflation with no relation to core architecture

---

## Pattern 11 — Why now

### Job
Explain why this company should exist now rather than earlier or later.

### Formula
- headline about timing
- 2–4 concrete reasons
- one line on the open window

### Example structure
- `The timing window is open.`
- AI code volume is real.
- Whole-repo verification is now affordable.
- No category leader owns this layer yet.
- `The need arrived before the category was claimed.`

### What makes it work
- creates urgency
- ties product possibility to market timing
- suggests a category grab is available

### Avoid
- generic “AI is hot” statements
- historical overviews disconnected from product timing

---

## Pattern 12 — Market

### Job
Show that the opportunity is large enough without letting numbers dominate the story.

### Formula
- headline connecting the company to multiple budget categories
- 2–4 lines or bullets on adjacent markets / spend
- one line tying all of them together

### Example structure
- `Prism sits inside multiple large and growing markets.`
- AI code tools
- code review and quality gates
- application security and testing
- software trust infrastructure
- `If AI touches software creation, Prism has a market.`

### What makes it work
- positions the company at an intersection
- avoids reducing the argument to TAM math alone
- sounds large but not inflated

### Avoid
- giant unsupported TAM numbers on a slide by themselves
- leading with market size before the problem feels real

---

## Pattern 13 — Competition

### Job
Define the company's category boundary through contrast with adjacent players.

### Formula
- headline with contrast
- table or list of categories / examples / primary jobs
- closing line naming your lane

### Example structure
- `Others help create code. Prism helps trust it.`
- AI editors → generate and edit code
- PR review bots → review changes near merge
- static analysis → scan for rules and security
- AI terminals → general development assistance
- `Prism owns the verification layer after generation and before production.`

### What makes it work
- acknowledges the market honestly
- differentiates clearly
- avoids direct mudslinging

### Avoid
- pretending there is no competition
- too much detail on rival features

---

## Pattern 14 — Proof / traction

### Job
Reduce risk by showing that the product is real and the thesis is being validated.

### Formula
- headline saying this exists and is working
- 4–7 concrete proof points
- one line that closes the credibility gap

### Example structure
- `Built, working, and already validating the thesis.`
- MVP shipped
- multiple workflows live on the same foundation
- real bugs found in dogfooding
- test-backed product maturity
- artifacts already flowing through CI and product surfaces
- `This is not a concept deck.`

### What makes it work
- de-risks execution
- shows the company has moved beyond idea stage
- supports belief in the roadmap

### Avoid
- overclaiming traction if still early
- hiding weak numbers behind adjectives

---

## Pattern 15 — Business model

### Job
Explain how money is made and why spending should recur.

### Formula
- headline on recurring spend or buyer logic
- simple pricing table or buyer segmentation
- one line linking spend to the market shift

### Example structure
- `Verification is recurring software spend.`
- Individual / Team / Enterprise
- simple pricing or packaging
- `As AI-generated code volume rises, verification spend rises with it.`

### What makes it work
- simple
- credible
- connected to the core thesis

### Avoid
- overly complex pricing detail
- unsupported revenue projections on the slide itself

---

## Pattern 16 — Vision

### Job
Show the company’s ultimate role if it wins.

### Formula
- headline about the future state of the market
- 2–4 lines describing what the market will require
- one line naming the company’s long-term role

### Example structure
- `Every AI-built company will need a trust layer.`
- The first wave helped teams write faster.
- The next wave decides what is safe to ship.
- `Prism is building the control plane for software trust.`

### What makes it work
- enlarges the company beyond the current feature set
- creates aspiration without losing logic
- ends the strategic arc well

### Avoid
- empty futurism
- vague “world where” statements disconnected from workflow reality

---

## Pattern 17 — Ask

### Job
State what is being raised and what it unlocks.

### Formula
- headline about the round and ambition
- short bullets on use of funds or milestone unlocks
- final closing line

### Example structure
- `We are raising a seed round to own the verification category.`
- accelerate product development
- expand across CI, IDE, and enterprise environments
- win design partners and early pilots
- `AI writes the code. Prism decides when it is ready.`

### What makes it work
- sounds focused
- ties money to momentum
- closes on a category-defining sentence

### Avoid
- vague asks
- financial detail overload if the deck is meant to open the conversation

---

## Pattern selection guidance

Not every deck needs every pattern.
Choose based on what the company most needs to prove.

### If the company is too technical
Emphasize:
- market shift
- problem
- insight
- value
- strategic significance

### If the company sounds too narrow
Emphasize:
- wedge
- platform expansion
- market
- vision

### If the company sounds easy to copy
Emphasize:
- why we win / moat
- proof
- architectural asymmetry
- compounding advantages

### If the company lacks urgency
Emphasize:
- market shift
- why now
- painful problem
- control point language

---

## Common sequencing mistakes

Avoid these ordering errors:
- product demo before category definition
- TAM before painful problem
- features before insight
- ask before moat or proof
- competition before explaining your own role clearly

The order of information matters because belief is cumulative.

---

## Final lesson

Each slide pattern should do one persuasive job.
A great deck works because every slide advances belief in sequence.

This skill exists to make those patterns reusable.
