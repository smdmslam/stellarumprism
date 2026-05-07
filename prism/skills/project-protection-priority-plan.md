# Project Protection Priority Plan Skill

Use this skill when the user already has security findings, concerns, or rough observations and wants to turn them into a practical hardening plan.

The job is **not** to produce a giant backlog with no ordering.
The job is to decide what should be fixed first, why, and in what sequence so the project becomes materially safer as quickly as possible.

A useful protection plan is not just “most severe first.”
It balances severity, exploitability, blast radius, implementation effort, and control centrality.

---

## Core principle

Do not ask only “what is bad?”
Ask “what single change would reduce the most risk across the most paths with the least effort?”

Translate:
- many scattered bugs → one missing central control
- repeated risky callers → one wrapper problem
- local convenience shortcut → systemic policy bypass
- strong policy in some places → incomplete enforcement
- vague security ambition → phased implementation plan

The goal is to produce:
1. the highest-impact immediate fixes
2. the best centralization fixes
3. the clearest sequencing
4. a plan the team can actually execute

---

## Ranking dimensions

For each finding, assess these dimensions.

### 1. Severity
If exploited or triggered, how bad is the outcome?

Examples of high severity:
- arbitrary command execution
- arbitrary file overwrite
- secret exfiltration
- privilege escalation through backend/native commands

### 2. Exploitability
How easy is it to trigger?

Examples of high exploitability:
- one-click or no-confirmation path
- UI-only guard with backend bypass
- action reachable from ordinary content or prompt flow

### 3. Blast radius
How much of the system or user environment can be affected?

Examples of high blast radius:
- shell access
- home-directory file access
- unrestricted network fetch with credential exposure
- secrets appearing in logs or transcripts

### 4. Likelihood
How likely is accidental or routine triggering?

Examples:
- model suggestions frequently passing through this path
- users commonly approving unclear prompts
- ordinary repo content can influence the behavior

### 5. Remediation leverage
How much risk does the fix remove relative to the work?

Examples of high leverage:
- one centralized wrapper replacing many scattered checks
- one path-scoping rule covering all file writes
- one schema validation layer protecting all backend commands

### 6. Implementation effort
How hard is the fix to ship safely?

Examples of lower effort:
- bind local services to localhost only
- redact secrets in a central logger/output formatter
- require explicit confirmation before out-of-workspace writes

---

## Priority biases

Use these biases on purpose.

### Bias 1 — Central controls beat scattered patches
Prefer fixing the shared wrapper over patching ten callers.

### Bias 2 — Dangerous powers come first
Command execution, file mutation, secret handling, and privileged backend actions usually outrank cosmetic or edge-case issues.

### Bias 3 — Silent-danger failures outrank noisy ones
A path that looks safe but bypasses policy is usually more urgent than a clearly rough edge.

### Bias 4 — Easy high-impact wins should happen early
Do not postpone simple risk reductions just because bigger work also exists.

### Bias 5 — Partial protections deserve scrutiny
A team often feels safer than it is when a protection exists in some but not all flows.

---

## Strong implementation order

A good default ordering for many fast-built apps is:

1. stop the biggest unsafe powers from flowing through ungated paths
2. scope access to the smallest reasonable surface
3. protect secrets from exposure
4. validate all boundary inputs
5. improve observability and incident control
6. clean up deeper architecture debt afterward

This order often beats starting with abstract policy documents.

---

## Planning workflow

### Phase 1 — Group findings by control area
Typical groups:
- command execution
- file access
- network access
- backend/native permissions
- secrets and redaction
- local server exposure
- logging and transcripts
- dependency and supply-chain risk

### Phase 2 — Identify central fixes
For each group, ask:
- is there one shared wrapper or boundary where this can be fixed once?
- is the current policy duplicated or inconsistent?
- can we make the safe path the default path?

### Phase 3 — Split into horizons
A useful plan usually has at least three horizons:

#### Today
Small, high-impact, low-coordination fixes.

#### This week
Moderate refactors, centralization work, validation, and guardrails.

#### Later
Broader architecture cleanup, deep testing, incident workflows, and advanced hardening.

### Phase 4 — State the rationale
For each planned item, say why it belongs in that horizon.
A plan is stronger when the ordering is explainable.

---

## What usually belongs in “today”

These are common immediate wins:
- move secrets out of code/config and redact them from logs
- ensure local services bind only to localhost
- require confirmation for dangerous actions not already gated
- default file access to the workspace only
- block obviously destructive command patterns centrally
- stop direct execution of model-generated actions

These are often disproportionately valuable because they reduce real exposure quickly.

---

## What usually belongs in “this week”

These are common short-horizon structural fixes:
- centralize command execution behind one backend gate
- centralize file mutation rules and path validation
- add schema validation for backend/native commands and IPC
- ensure permission checks live in the backend, not only the UI
- centralize secret redaction before logs, UI panels, and model context
- audit recent refactors for alternate paths and bypasses

These are the moves that turn scattered safety into reliable safety.

---

## What usually belongs in “later”

These are important but often less immediate:
- advanced audit logging and review tooling
- safe mode / feature flags / kill switches
- deeper dependency hardening and update policy
- incident-response drills and recovery docs
- richer automated abuse-case tests
- more formal authz models if remote/multi-user features grow

Do not ignore these.
But do not let them displace urgent central-risk work either.

---

## Good plan shape

Strong planned items usually look like this:
- control area
- concrete change
- why it matters
- why now
- expected risk reduction

### Example shape
- **Command execution**
- Route all command runs through one backend wrapper that enforces approval, denylist rules, logging, and argv-safe execution.
- This matters because command execution is the highest-blast-radius capability in the app.
- This belongs in the first implementation horizon because partial enforcement is not enough.
- Expected outcome: alternate execution paths stop being silent bypasses.

That is much better than “improve execution security.”

---

## Anti-patterns in prioritization

Avoid these common planning failures:

### 1. Severity-only ranking
A theoretically severe issue with low reach and high remediation cost may not outrank an easy fix that removes risk from ten paths today.

### 2. Patch-per-caller thinking
If ten callers are unsafe, the real issue is often the boundary design.

### 3. Planning without ownership
A plan should imply where the change lives: wrapper, backend command layer, logger, validator, settings model, etc.

### 4. Generic action verbs
“Improve,” “strengthen,” and “harden” are too vague unless tied to a concrete mechanism.

### 5. Overvaluing policy prose
A project usually gets safer first by changing defaults and wrappers, not by writing a broad policy doc.

---

## Reusable prompting patterns

### Pattern 1 — highest impact first
> Rank these findings by risk reduction per unit of effort, not only by abstract severity.

### Pattern 2 — centralization first
> Identify which findings are really symptoms of one missing centralized control and propose the wrapper or boundary fix first.

### Pattern 3 — phased plan
> Convert these findings into a today / this week / later plan with one-sentence rationale for each item.

### Pattern 4 — dangerous powers first
> Prioritize command execution, file mutation, secret handling, and privileged backend actions before lower-risk cleanup.

### Pattern 5 — make it shippable
> Turn this security review into a short list of concrete implementation tasks the team could actually do next.

---

## What success looks like

A successful prioritization pass causes the team to say some version of:
- now we know what to do first
- now we know which changes remove the most risk
- now we know where centralization matters more than patching callers
- now we have a hardening plan that fits real engineering work

If the result is still a long unordered list of concerns, it is not done.

---

## Final lesson

Security work becomes tractable when findings are translated into centralized, high-leverage, well-sequenced implementation moves.

That is the method this skill is meant to preserve.
