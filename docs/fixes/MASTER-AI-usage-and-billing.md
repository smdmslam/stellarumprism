# MASTER AI Usage and Billing
Date: 2026-04-29
Project: StellarumPrism

Purpose: define the usage-metering, cost-visibility, pricing-readiness, and
Stripe-preparation work needed so Prism can understand and control AI spend
before introducing subscriptions.

This document exists because AI cost has become concrete, not theoretical:
recent OpenRouter credit exhaustion showed that Prism can burn through credits
much faster than many other apps, especially when expensive models or multi-step
agent/tool workflows are involved.

---

## Why this work is urgent

Prism is not a simple “one prompt in, one response out” application.
A single user-visible task may involve:
- a primary model call
- multiple tool decisions
- retries
- verifier/reviewer calls
- web-search backend calls
- long-context reading
- future recipe/protocol/skill-triggered model work

That means cost can hide inside the workflow unless usage is instrumented well.

Recent practical concerns:
- OpenRouter out-of-tokens errors are already happening
- this app can spend in days what other apps spend in a year
- some features may need to be paused, downgraded, or rerouted until economics
  are understood
- expensive models like `openai/gpt-5.4` may be useful as benchmarks but not as
  safe defaults

So the immediate need is not just “billing integration.”
It is:
1. usage visibility
2. cost attribution
3. economic decision support
4. subscription readiness

---

## Main goals

### 1. Make AI spend legible
Prism should be able to explain:
- what used tokens
- which model/provider incurred cost
- which feature or workflow triggered it
- which user/session/project generated it
- why a particular day or workflow was expensive

### 2. Capture nearly all AI-related cost surfaces
Very little spend should escape attribution.
That includes not just visible user chat turns, but any hidden or supporting AI
calls involved in completing the task.

### 3. Support product-level prudence
Usage data should help answer questions like:
- Which models are too expensive as defaults?
- Which features create disproportionate cost?
- Which workflows should route to cheaper alternatives?
- Should some features be parked until margins are safer?

### 4. Prepare for subscriptions and Stripe later
By the time Stripe arrives, the underlying usage model should already exist.
Stripe should attach to an existing cost/entitlement system, not force a major
retrofit.

---

## Core principle

Track usage in terms of both:
- **raw AI cost signals** (tokens, prices, duration, provider, model)
- **product-facing units** (turns, audits, builds, searches, premium turns)

The first is needed for real economics.
The second is needed for subscription design.

---

## What must be tracked

## 1. Per-model-call event data
Every model-backed call should emit a durable usage event.

Suggested fields:
- event id
- timestamp
- account id
- user id
- workspace/project id
- chat/session id
- feature/mode
  - `chat`
  - `audit`
  - `build`
  - `fix`
  - `refactor`
  - protocol/recipe
  - skill execution
  - verifier/reviewer
  - tool backend
- model slug
- provider
- request type
- prompt/input tokens
- completion/output tokens
- total tokens
- reasoning tokens if available
- cached tokens if available
- image/file count if relevant
- request duration
- success/failure/cancel
- retry indicator
- parent action id / turn id
- estimated cost
- pricing snapshot id or embedded pricing basis

Acceptance standard:
- every call can be reconstructed later without relying on vague logs

---

## 2. AI cost surfaces that should not escape tracking

### Foreground calls
- normal user chat turns
- explicit slash-command runs
- mode-specific runs like `/audit`, `/build`, `/fix`, `/refactor`

### Background/supporting calls
- verifier calls
- reviewer calls
- retries after tool errors or malformed responses
- follow-up completions inside a single user-visible action
- summarization or condensation calls if added later
- planner/critic/helper-model calls if ever introduced

### Tool-backed AI calls
- `web_search` via `perplexity/sonar`
- any future tool whose backend is model-powered

### High-cost special cases
- long-context turns
- vision/image turns
- premium-model turns
- calls with unusually large outputs

Acceptance standard:
- a single user-visible task can be decomposed into all underlying AI usage

---

## 3. Historical pricing capture

Because OpenRouter pricing can change over time, Prism should not rely only on
current live prices when reconstructing historical cost.

At call time, store enough to reconstruct cost later:
- model slug
- provider
- price per million input tokens
- price per million output tokens
- reasoning/cached/image pricing if relevant and available
- timestamp of pricing snapshot
- source/version of pricing data

Why this matters:
- historical reports stay accurate
- plan economics can be analyzed retroactively
- cost spikes can be understood in context

---

## 4. Aggregation views Prism should support

### By time
- per session
- per day
- per week
- per month

### By identity
- per user
- per account
- per workspace/project

### By model economics
- per model
- per provider
- premium vs budget usage mix

### By product workflow
- per mode (`chat`, `audit`, `build`, etc.)
- per slash command
- per protocol/skill
- per tool type

### By anomaly detection
- sudden spend spikes
- unusually costly chats
- repeated retries
- heavy users
- heavy premium-model use

Acceptance standard:
- Prism can answer “where did the money go?” quickly and reliably

---

## 5. Product-facing usage units for future pricing

Tokens matter internally, but subscription plans often need friendlier units.
Prism should track candidate pricing units now, even if final pricing is not yet
decided.

Candidate units:
- agent turns
- premium-model turns
- audits
- builds
- fixes
- refactors
- web searches
- protocol runs
- long-context turns
- image/vision turns
- file-edit proposals
- approvals triggered

These may later support plan designs like:
- free / hobby / pro / team
- monthly included premium turns
- included audits/builds per month
- extra charges for premium models
- soft caps / hard caps / degraded-mode fallbacks

Acceptance standard:
- future pricing decisions can be grounded in real historical usage patterns

---

## 6. User-facing visibility before billing exists

Before Stripe or subscriptions are added, Prism should still make heavy usage
visible enough that users do not get blindsided.

Potential UX surfaces:
- current-session usage summary
- current-chat model/cost summary
- current-month estimated spend
- “this workflow is using a premium model” warning
- “this conversation is becoming expensive” warning
- model picker surfaces that communicate relative cost clearly

Why this matters:
- users can self-regulate before hitting provider-credit exhaustion
- expensive defaults become visible
- trust improves when spend is explainable

---

## 7. Cost-aware routing and feature prudence

Usage instrumentation is not just for reporting. It should inform routing and
product decisions.

Questions Prism should eventually answer with data:
- Is `openai/gpt-5.4` worth its cost for default daily use?
- Which cheaper models are close enough in Prism's actual workflows?
- Which modes are safe to keep premium?
- Which should default to cheaper models?
- Are there features whose economics are too poor to keep active right now?
- Should some expensive flows warn, require confirmation, or be temporarily
  parked?

This is directly connected to model-alternative evaluation.
If a lower-cost model performs close enough in the agent window, it may be the
correct default even if it is not the absolute best model overall.

---

## 8. Stripe and subscription readiness

Stripe should come after metering and aggregation, not before.

Preparatory architecture to define:
- subscription owner model
  - individual
  - team/workspace
- plan entitlements
- quota counters
- premium-feature gates
- overage behavior
  - hard stop
  - soft warning
  - degraded fallback model
  - metered overage billing
- billing-period rollups
- invoice/reconciliation support
- webhook handling requirements
- failure modes when billing state is unclear

Acceptance standard:
- Stripe can be added as a payment layer on top of a mature usage system

---

## Recommended implementation order

### Phase A — instrumentation first
1. Define unified usage event schema
2. Emit events for all primary model calls
3. Emit events for supporting/background/tool-backed calls
4. Persist historical pricing basis

### Phase B — observability
5. Build aggregation queries/reports
6. Add internal views for cost by model / mode / user / session
7. Identify cost spikes and top offenders

### Phase C — user visibility
8. Add lightweight user-facing usage summaries
9. Add warnings for premium or unusually expensive workflows
10. Improve model-cost signaling in model selection UI

### Phase D — economic decision-making
11. Compare expensive defaults against cheaper alternatives
12. Change routing/defaults where economics demand it
13. Park or limit features if usage data shows unsustainable burn

### Phase E — billing readiness
14. Define plan entitlements and quotas
15. Add enforcement hooks
16. Integrate Stripe once the underlying metering model is stable

---

## Relationship to model strategy

This work is tightly linked to the model shortlist work.

Reasons:
- if premium models are too expensive, Prism needs credible alternatives
- if cheaper models are close enough in real workflows, they may be the right
  defaults
- pricing strategy depends on understanding where premium quality truly matters
- some modes may justify frontier models while others should never default to
  them

Relevant companion file:
- `docs/fixes/MASTER-AI-model-list.md`

---

## Bottom line

Prism should treat AI usage tracking as core infrastructure, not administrative
cleanup.

The immediate business need is:
- know where spend is happening
- make it visible
- reduce surprise
- support prudent feature/default decisions
- prepare for future subscriptions without retrofitting the whole app later
