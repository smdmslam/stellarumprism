# Internal note — the Perplexity Sonar × DeepSeek pairing

> **Audience:** internal only. Not for external positioning, deck, or marketing copy. The mechanism described here is part of why Prism's tool-loop produces unusually high-quality analyses; revealing it explicitly in customer-facing material would reduce the moat and would also misframe Prism as a "model wrapper" rather than a substrate.

## TL;DR

When a Prism agent turn produces a thoughtful, structure-rich analysis grounded in current external facts, the output is the product of **two specialised models running in a prescribed division of labor**, not one. Specifically:

- **Perplexity Sonar** is the only model authorised to fetch web evidence (the `web_search` tool, hardcoded to `perplexity/sonar` in `src-tauri/src/tools.rs::WEB_SEARCH_MODEL`). Sonar is a retrieval-augmented model whose strength is returning *short, citation-grounded prose anchored on live web sources* with inline `[1][2]` markers.
- **The synthesis model** (currently DeepSeek V3.2 by default; any capable tool-using model in the router can play this role) is the model the user is "talking to" and the one that decides when to call tools. Its strength is *structuring*, *categorising*, *narrating*, *outputting tables / ASCII diagrams / multi-section markdown*. It does NOT freely reason from training; it interprets the tool results that come back from Sonar (and from the rest of the substrate).

Neither model alone produces the result the pair produces. That's the whole point.

## Why the pairing works

### What Sonar can't do alone

Sonar returns prose grounded in 5–10 web sources with citation markers. It is not optimised for:

- holding a 22 KB user-supplied document in long context across a multi-turn conversation;
- generating ASCII architecture diagrams;
- producing a workflow-phase market-sizing table;
- categorising a list of competitors into Primary / Secondary / Third tiers with explanatory framing;
- noticing that a specific result conflicts with a project-doc claim and flagging it.

Asked to do these on its own, Sonar's output collapses into a flat answer with citations. The structural intelligence isn't there.

### What the synthesis model can't do alone

A pure synthesis model (DeepSeek, Haiku, Llama-3.3 — any of them) can produce all of the structural moves listed above, but is *worse* at generating fresh factual claims than its training cutoff allows. Asked to "list 10 competitors in the AI code-verification space, 2026," a synthesis model alone will:

- confidently invent product names that don't exist or got renamed since cutoff,
- assign plausible-sounding F1 scores or token counts that aren't real,
- miss the past-month entrants entirely.

The audit prompt explicitly forbids this in other contexts (the AUDIT prompt has a long anti-fabrication block). For market-research turns the same risk applies and the same fix works: **do not let the synthesis model invent facts; force it to interpret tool results.**

### The combination

When the synthesis model is given the right system prompt + the `web_search` tool + Sonar as its evidence backend, it does what each model is best at:

1. The user asks a question that requires fresh + grounded + structured output.
2. The synthesis model decides what to search and issues 1–N `web_search` calls.
3. Each call routes to Sonar via OpenRouter; Sonar returns citation-anchored prose as a tool result.
4. The synthesis model receives all the tool results plus any user-supplied documents (e.g. a `read_file` of the auditor doc) in its context window and synthesises the final response.
5. Citation markers from Sonar are preserved verbatim per the system prompt's `web_search` rules; structure (categories, tables, ASCII diagrams, framing) is the synthesis model's contribution.

The user sees one coherent answer, but it's a two-model pipeline.

## Token economics + why this is cheap

Sonar runs on Perplexity's infra; we pay per-call (passed through via OpenRouter). DeepSeek V3.2 is currently ~$0.28 per million tokens via OpenRouter; Haiku 4.5 is ~$1/M input / $5/M output; the larger Grok-4-Fast or GPT-5.4 are 10–30× pricier per token.

The pairing's economic advantage:

- The **expensive cognitive work** (structuring, narrative coherence, multi-document synthesis) is handled by a *commodity* synthesis model (DeepSeek) at $0.28/MTok. It only needs to be smart enough to interpret tool results and write structured prose — not smart enough to hold all the world's facts.
- The **fact-grounding work** is handed off to Sonar, which has to be retrieval-augmented and live-web-aware but doesn't have to be a frontier reasoner.
- Neither tier needs frontier pricing.

This is the per-turn version of the durability claim from `vc-prism-auditor.md`'s "Why this is durable" section. The pairing pattern *is* the substrate moat applied to a single turn.

## Why this generalises (the pattern, not the specific models)

The Sonar × DeepSeek pairing is a specific instance of a more general design pattern: **specialised tool model + general synthesis model**. The same pattern explains why the rest of Prism's substrate works:

- `typecheck` is a "tool model" with one job (compile + parse diagnostics) that the synthesis model interprets.
- `lsp_diagnostics` is a "tool model" backed by `rust-analyzer` / `pyright` / `gopls`.
- `schema_inspect` is a "tool model" backed by `prisma migrate status` / `alembic check` / etc.
- `e2e_run` is a "tool model" backed by HTTP + assertion machinery.
- `web_search` is a "tool model" backed by Perplexity Sonar.

In every case, the synthesis model's job is *not* to produce the deterministic check; its job is to **decide when to call the check and how to interpret the result**. The synthesis model is interchangeable; the tool models are pinned to whichever provider does that one job best.

## Substitution rules

- The synthesis model is **swappable**. Today's default is DeepSeek V3.2 because of price/quality. Tomorrow it might be Qwen 3.5 / Llama 4 / Haiku 5 / whatever wins on cost-quality at synthesis. The router (`src/models.ts`) is a single-file change; the substrate is unchanged.
- Sonar is **less swappable** because the only practical alternative for grounded web search at this quality + price is Perplexity itself. If a competitor releases a true Sonar replacement, we route to whoever is cheaper.
- The pairing pattern is **architectural**, not contractual. We could swap both models tomorrow and the pattern would still produce the same shape of output.

## Why we don't reveal this in customer-facing material

Three reasons:

1. **It misframes the product.** Prism is a *substrate*, not a model wrapper. Telling investors "we route web search to Perplexity and synthesis to DeepSeek" leads them to ask "so this is a model orchestrator?" The honest answer is "no, this is the same tool-loop pattern applied to one specific tool (`web_search`); we have six other tools doing the same thing." But by then the framing damage is done.
2. **It reduces the moat.** Anyone can wire up Sonar + DeepSeek with the right system prompt. The moat is the *full substrate* (typecheck, ast_query, run_tests, http_fetch, e2e_run, lsp_diagnostics, schema_inspect, web_search) plus the deterministic grader plus the consumer-mode design plus the markdown artifact pipeline. Surfacing one piece in isolation cheapens the whole story.
3. **It pins us to providers we'd rather treat as commodities.** Marketing the Sonar pairing creates an external expectation; if Sonar's pricing or quality drifts, we're stuck explaining a change. Internal architectural notes can shift; public positioning can't.

The general claim — "Prism inherits the aggregate quality of the open model ecosystem rather than being pinned to one lab" — is the right external statement. The specific pairing recipes are how we deliver on that claim today, and they're allowed to evolve quietly.

## Practical operator notes

- If output quality drops, check Sonar status BEFORE assuming the synthesis model is the issue. A degraded Sonar response (truncated, no citations, or wrong-decade results) cascades into bad synthesis. The audit prompt instructs the model to flag inconsistent web results inline; that flag is the canary.
- The synthesis model's `web_search` discipline is enforced by the system-prompt block in `config.rs::default_system_prompt` (rules 4–7 specifically). If we switch synthesis models, those rules need to survive into the new model's prompt verbatim.
- Sonar's citation markers (`[1][2][3]`) must NOT be renumbered or stripped by the synthesis model. The default system prompt says so explicitly. Any future synthesis-model swap must preserve that contract.

---

*Internal document. Owner: Steven Morales. Last updated: 2026-04-25. Do not surface in pitch decks, marketing copy, or external blog posts; cross-reference from `docs/vc-pitchdeck.md` Slide 7 (comprehensive context) and `docs/vc-prism-auditor.md`'s "Why this is durable" section instead.*
