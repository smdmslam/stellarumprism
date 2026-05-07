---
name: Prism App Builder
description: Use when generating shippable web apps; adds security, billing, metering, SEO, testing, and launch checklists.
---

# Prism App Builder

This skill makes Prism produce launch-ready web apps, not prototypes. An app is "production-ready" only when it addresses safety, monetization, traceability, and growth — never just features.

## When to use

- Building new SaaS, AI tools, marketplaces, or consumer apps from scratch.
- Need a full-stack blueprint that includes business rails (auth, billing, metering, SEO, marketing), not just code.
- Auditing an existing app for shippability gaps.

## Refusal & risk flagging

**Decline outright:**

- Promises of regulated compliance (PCI, HIPAA, SOC 2). The skill scaffolds *toward* these but cannot certify.
- Apps in domains that need licensed expertise: medical advice, legal advice, retail financial advice.
- Anything that conflicts with provider terms (election manipulation, weapons sales, bulk content abuse).

**Always flag, never silently skip:**

- AI app without usage metering → **STOP**, propose a metering layer first.
- Payments without webhook tests → **STOP**, propose a webhook test plan.
- Sensitive data without RBAC + GDPR scaffolding → **STOP**, propose the missing safety layer.
- Public app without sitemap or basic SEO → **WARN**.

**Waivers** must be explicit and named ("Skip billing? Confirm."). Any waived pillar lands in the launch checklist's `⚠️ Missing/Waived` section so the gap survives the conversation.

## Required inputs (collect before generating)

- **App name** + one-line description.
- **Target users** (e.g. freelancers, enterprises, hobbyists).
- **App type** — SaaS / AI tool / marketplace / internal tool / consumer.
- **Auth model** — none / email-password / OAuth (Google, GitHub) / magic links / team-workspace.
- **Pricing model** — free / subscription (tiers?) / usage-based / one-time / enterprise.
- **AI / API providers** + rough usage estimate (e.g. ~10K tokens per action).
- **Data sensitivity** — none / personal / financial / health / files / team data.
- **Geography & language** — global / US-only / multi-language?
- **SEO priority** — low (internal) / medium / high (public launch).
- **Landing page** + **Docs/Help center** — yes/no (default yes for commercial).

These shape the scaffold: AI-heavy apps get metering hardened; team apps get RBAC; public apps get SEO defaults.

## Mandatory pillars (every app must address all 9)

1. **Core Product** — features, flows, MVP scope.
2. **Security** — auth, RBAC, input validation, rate limits, secrets, headers.
3. **Billing (Stripe)** — products, checkout, subscription states, webhooks, dunning.
4. **Usage Tracking** — metering, quotas, reconciliation, user-facing dashboard.
5. **Testing & Quality** — unit (auth, billing, metering), integration (webhooks), e2e (upgrade flow), strict TS, ESLint, pre-commit hooks.
6. **Data Lifecycle** — schema migrations, automated backups, GDPR data export, account deletion with cascade.
7. **Abuse & Content Safety** — (AI apps) prompt-injection awareness, content policy, abuse rate-limits separate from API rate-limits, terms-violation handling.
8. **SEO & Marketing** — metadata, sitemaps, landing page, FAQ, indexable content.
9. **Operations & Launch** — analytics (PostHog), error monitoring (Sentry), launch checklist with status flags.

Never skip a pillar silently. If the user pushes for a "quick prototype," restate refusal rules + name what's being waived in the checklist.

## Output contract (always structure the response this way)

### 1. App summary

Name · pitch · target users · core problem · business model.

### 2. Architecture

Frontend stack · backend · DB schema · auth provider · third-party integrations · deployment.
**Default stack:** Node/TypeScript + Next.js + PostgreSQL + Prisma + NextAuth + Vercel. Adapt to the user's chosen stack if they specified one.

### 3. Security model

Auth flow · RBAC · input validation · rate limits (60/min IP, 600/min authed user) · secrets management (env vars or Doppler) · headers (CSP, HTTPS redirect, CORS) · audit logging.

### 4. Billing model (Stripe)

Products + prices (e.g. Free $0, Pro $29/mo, Enterprise custom) · checkout flow · subscription states (`active`, `past_due`, `canceled`) · webhook event matrix (`invoice.paid`, `payment_failed`, `customer.subscription.updated`, `customer.deleted`) · dunning (retry schedule, grace periods, notifications).

### 5. Usage metering (if AI/API heavy)

Billable units (tokens, calls, credits) · free allowance per tier · meter event schema `(user_id, action, cost_usd, occurred_at)` · quota enforcement + upgrade prompts on overage · user-facing dashboard · internal ledger for cost reconciliation.

### 6. Testing & quality

Unit tests for auth boundaries, billing math, usage metering, data deletion. Integration tests for Stripe webhooks (use `stripe-mock` or recorded fixtures). E2E for the signup → upgrade → cancel path specifically. TypeScript strict mode + `noUncheckedIndexedAccess`. ESLint with project conventions. Pre-commit hooks (husky + lint-staged).

### 7. Data lifecycle

Migration framework (Prisma/Drizzle/Knex) + rollback strategy. Automated DB backups (schedule, retention, restore drill). User data export endpoint (GDPR portability: JSON download). Account deletion endpoint with cascade through subscriptions, usage logs, cached data. Hard-delete vs anonymization policy (be explicit about which fields).

### 8. Abuse & content safety (for AI apps)

Prompt-injection awareness — never treat user input as instructions to the LLM. Content policy: pass through to the provider's moderation (OpenAI Moderation API, Anthropic filters) OR run an in-process classifier. Abuse rate limits separate from API rate limits — per-user, per-IP, escalating. Terms-violation flow: warning → temporary suspension → ban. Audit log of moderation decisions for appeals.

### 9. SEO & content model

Public pages with indexable routes · metadata templates (dynamic title/description, OpenGraph, Twitter cards) · `sitemap.xml` + `robots.txt` (noindex for `/admin`, `/api`) · Schema.org structured data for products + FAQ · keyword themes + content plan · docs/help article stubs for onboarding.

### 10. Landing page

Menu (Home · Features · Pricing · FAQ · Login). Hero (headline, subhead, CTA). Sections (Problem/Solution · Features · Screenshots · Social Proof · Pricing · FAQ). Footer (legal, copyright). Voice: clear, benefit-focused, no jargon.

### 11. Estimated monthly cost (small / medium / large)

Three usage scenarios with breakdown:

- Hosting (Vercel/Render/Fly tier).
- Database (managed Postgres tier).
- LLM API calls — `tokens × price × estimated turns × users`.
- Stripe fees (typically 2.9% + 30¢ per transaction).
- Analytics + monitoring (PostHog + Sentry tier).
- **Total per scenario.**

Flag indeterminate items explicitly (e.g. "assumed 50 LLM turns/user/month — actual could 5×"). The point is to make unit economics visible *before* the bill arrives.

### 12. Launch checklist

- ✅ **Ready** — implemented items.
- ⚠️ **Missing/Waived** — gaps with reasons.
- 🚨 **High-risk** — critical warnings (untested webhooks, missing secrets management, no rate limits).
- **Production gate:** Ready / Needs Work / Not Ready.

## Using Prism's own tools

When this skill is engaged on a Prism-shaped project, lean on Prism's machinery rather than reinventing it:

- **`/audit <scope>`** after each major surface lands. Substrate cells (typecheck, run_tests, LSP) verify the new code; the audit JSON sidecar feeds the Problems panel and `/fix`.
- **`/build <feature>`** for substrate-gated implementations. Each step gets verified before the next dispatches.
- **`/protocol harden`** for a security review pass before launch.
- **`/skills load vc-pitchdeck-framing`** when the user is preparing investor materials after MVP.
- Skills compose — engaging this builder alongside a domain skill (e.g. a future `prism-billing-patterns` skill) gives the agent both the architecture mindset and the domain depth.

## Generated file tree (default Node/TypeScript stack)

Adapt to the user's chosen stack. For the default Next.js + Prisma + NextAuth setup:

```
package.json                            # stripe, @prisma/client, next-auth, posthog-node, @sentry/nextjs
prisma/
  schema.prisma                         # User, Subscription, UsageEvent, Session, AuditLog
  migrations/                           # versioned, never edited after merge
src/
  app/
    page.tsx                            # landing
    (auth)/login/page.tsx
    api/
      stripe/webhook/route.ts
      usage/export/route.ts             # GDPR data export
      account/delete/route.ts           # cascade delete
  lib/
    auth.ts                             # NextAuth config + helpers
    usage.ts                            # metering writes + quota checks
    cost.ts                             # cost-per-action constants for billing reconciliation
    moderation.ts                       # abuse + safety filters (AI apps only)
tests/
  unit/                                 # auth, billing math, metering, deletion cascade
  integration/                          # Stripe webhooks via stripe-mock
  e2e/                                  # signup → upgrade → cancel
public/robots.txt
src/app/sitemap.ts
.env.example                            # every secret named, no real values
README.md                               # setup, env vars, launch steps
```

## Defaults applied silently

- HTTPS enforced everywhere · input sanitization on every route · CSRF (NextAuth handles).
- Rate limits: 60/min per IP for public APIs, 600/min for authed users.
- Sentry + PostHog included in every scaffold (PostHog opt-in dialog, defaulted on).
- TypeScript strict mode + `noUncheckedIndexedAccess`.

## Hard warnings (never silent)

| Pattern | Response |
|---|---|
| AI app without metering | **STOP** — propose metering before continuing |
| Payments without webhook tests | **STOP** — propose webhook test plan |
| Sensitive data without RBAC + GDPR | **STOP** — propose the missing safety layer |
| Public app without sitemap | **WARN** — recommend SEO basics |
| "Just ship it" pressure | Restate refusal rules + list what's being skipped |

---
**Version:** 2.0 — single-file curated skill. Curation policy lives in `MASTER-Plan-II.md#5.9`.
