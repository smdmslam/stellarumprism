# Project Protection Threat Model Skill

Use this skill when the user wants to analyze a software project's security posture, identify its real attack surface, and produce a concrete list of risks grounded in what the project can actually do.

The job is **not** to dump generic cybersecurity advice.
The job is to understand:
- what the system can read
- what it can write
- what it can execute
- what it can expose
- what it can leak
- where trust boundaries are weak or unclear

A useful protection analysis starts from real capabilities, not vague anxiety.

---

## Core principle

Do not start with “what security advice do I know?”
Start with “what powers does this system have, and what could go wrong if those powers are misused, bypassed, or confused?”

Translate:
- product features → security-relevant capabilities
- architecture boundaries → trust boundaries
- convenience shortcuts → abuse paths
- refactors → possible incompleteness or bypasses
- model assistance → untrusted output source
- local tooling → privilege surface

The goal is to produce a clear picture of:
1. what must be protected
2. what can act on it
3. where control is weak or missing
4. what failures would matter most

---

## Required inputs

Before assessing risk, gather as many of these as possible:

1. the repo itself
2. any architecture or product docs
3. the main runtime surfaces (desktop app, local server, CLI, Tauri backend, IPC, etc.)
4. any command-execution, file-write, or network-fetch paths
5. any auth, approval, permission, or policy layers
6. any secrets/config handling patterns
7. evidence from code, not only description, when the answer is inspectable

If the repo exists, read the real code paths before concluding that a protection exists universally.

---

## What to inventory first

### 1. Assets
Ask what needs protection.

Common assets:
- API keys and tokens
- local files and project code
- shell access and command execution ability
- user trust and approval decisions
- private prompts, logs, and transcripts
- backend commands and privileged operations
- local databases, caches, and settings
- network credentials and service endpoints

### 2. Capabilities
Ask what the system is able to do.

Common capability categories:
- read files
- write or overwrite files
- edit files in place
- run shell commands
- call local or remote HTTP endpoints
- persist session or artifact data
- invoke backend/native commands
- render model output to a trusted-looking UI

### 3. Trust boundaries
Ask where untrusted input crosses into more trusted execution or storage.

Common boundaries:
- user input → app logic
- model output → action proposal
- model output → executable path
- repo content → model context
- terminal output → UI interpretation
- renderer/frontend → backend/native layer
- local HTTP server → privileged actions
- saved settings/state → runtime behavior

### 4. Attack surface
Ask what externally or internally reachable surfaces exist.

Examples:
- local web server
- Tauri commands
- IPC handlers
- shell wrappers
- file import/export paths
- settings/import features
- markdown rendering
- update/install flows
- clipboard, drag/drop, or open-file handlers

---

## Threat-actor framing

Do not think only in terms of “hackers on the internet.”
Use a broader set of plausible threat sources.

### Common threat actors
- a malicious or compromised dependency
- a malicious repo or file opened by the user
- prompt injection hidden in code/comments/docs
- hostile terminal output crafted to mislead the user or agent
- an attacker reaching a local service exposed beyond localhost
- a normal user accidentally approving something dangerous
- a model generating unsafe commands or unsafe edits
- incomplete refactors creating ungated paths

### Rule
Many failures in AI-assisted tools come from trust confusion, not classic remote intrusion alone.

---

## High-value abuse cases

For each capability, ask how it could be abused.

### Command execution
- command injection
- approval bypass
- alternate execution path that skips policy checks
- shell-string interpolation instead of argv-safe execution
- dangerous commands hidden inside generated output

### File access
- out-of-workspace reads
- out-of-workspace writes
- path traversal
- destructive overwrites
- secret file exposure
- unsafe import/export locations

### Network access
- exfiltration of secrets or code
- fetches to attacker-controlled URLs
- SSRF-like behavior against local services
- silent outbound requests the user did not expect

### UI / rendering
- trusted-looking presentation of untrusted content
- markdown or HTML injection
- confusing approval prompts
- misleading summaries that hide risk

### Backend / native / IPC
- renderer can call privileged commands without strong checks
- argument validation is weak or absent
- capability checks live only in the UI, not the backend

### Secrets and logs
- secrets stored in repo or local state files
- secrets printed in logs, errors, or transcripts
- secrets passed into model context unnecessarily

---

## Analysis workflow

### Phase 1 — Identify real powers
List what the application can actually do.

Checklist:
- [ ] identify all file read/write/edit paths
- [ ] identify all command execution paths
- [ ] identify all HTTP/network fetch paths
- [ ] identify all privileged backend/native commands
- [ ] identify all persistence/logging/transcript paths

### Phase 2 — Map trust boundaries
Find where untrusted input crosses into trusted action.

Checklist:
- [ ] identify all user-controlled inputs
- [ ] identify all model-generated outputs that influence behavior
- [ ] identify all repo/content-derived inputs
- [ ] identify all renderer → backend boundaries
- [ ] identify all local service boundaries

### Phase 3 — Look for centralization failure
Ask whether protections are universal or only present in some paths.

Checklist:
- [ ] does all command execution flow through one gate?
- [ ] do all file mutations share the same scoping rules?
- [ ] do all privileged backend actions share the same permission checks?
- [ ] is validation centralized or scattered?
- [ ] do newer/refactored paths bypass older safeguards?

### Phase 4 — Identify abuse paths
Turn capabilities into plausible exploit scenarios.

Checklist:
- [ ] prompt injection path
- [ ] approval bypass path
- [ ] path traversal path
- [ ] secret exposure path
- [ ] dangerous implicit execution path
- [ ] localhost exposure / unsafe binding path
- [ ] logging or transcript leakage path

### Phase 5 — Rank findings
Rank by:
- severity if exploited
- exploitability
- blast radius
- likelihood of accidental triggering
- ease of remediation

---

## Rules for producing findings

### Rule 1 — Prefer observed facts over general fear
If the repo is inspectable, identify the exact code path.

### Rule 2 — Separate observed, inferred, and unverified claims
Do not blur them.
A protection conversation becomes much more useful when the status of each claim is explicit.

### Rule 3 — Favor structural findings over one-off nits
A missing centralized gate matters more than one sloppy caller.

### Rule 4 — Prioritize silent-danger failures
The worst failures are often the ones that look safe to the user while bypassing real control.

### Rule 5 — Refactors deserve suspicion
Recent architecture changes often create wiring gaps, duplicate logic, and bypass paths.

---

## Good finding shapes

Strong findings usually look like this:
- capability
- missing or partial control
- exploit or failure path
- why it matters
- suggested fix direction

### Example pattern
- The app can execute shell commands.
- Approval exists in some visible flows, but execution is not centrally enforced in one backend gate.
- A refactor or alternate action path could invoke execution without the same prompt or denylist.
- This matters because command execution is one of the highest-blast-radius powers in the system.
- Fix by centralizing all command execution in a single permissioned wrapper and treating all other paths as forbidden.

That is much better than “improve command security.”

---

## Common anti-patterns in fast-built systems

Watch especially for these:
- approval enforced in UI only
- validation enforced in UI only
- inconsistent path scoping
- duplicated wrappers with slightly different rules
- shell execution built incrementally in multiple places
- unredacted logs/debug panels
- secrets in config files or saved state
- localhost services binding to all interfaces
- model output treated as executable intent instead of untrusted text
- “temporary” bypasses that never got removed

---

## Output structure to aim for

A strong threat-model output usually includes:

1. system summary
2. key assets
3. key capabilities
4. trust boundaries
5. highest-risk abuse cases
6. concrete findings
7. immediate hardening directions

If the user wants action, hand off naturally into a prioritization plan.

---

## Reusable prompting patterns

### Pattern 1 — capability-first analysis
> Do not give generic advice yet. First identify what this system can read, write, execute, expose, and leak.

### Pattern 2 — trust-boundary analysis
> Map every place where untrusted input can influence trusted action, especially model output, repo content, terminal output, and frontend-to-backend calls.

### Pattern 3 — centralization audit
> Check whether protections are universal or only present in some code paths. Look for duplicate wrappers, refactor-era bypasses, and UI-only enforcement.

### Pattern 4 — abuse-case conversion
> For each powerful capability, name the realistic abuse path, the missing control, and the highest-leverage fix.

### Pattern 5 — observed vs inferred discipline
> Separate verified code observations from inferred risk and from unverified possibilities.

---

## What success looks like

A successful protection analysis causes the team to say some version of:
- now we know what the risky powers actually are
- now we know where the boundaries are weak
- now we know which controls are real and which are partial
- now we know what to fix first

If the result still sounds like a generic security blog post, it is not done.

---

## Final lesson

A good threat model does not start by naming scary concepts.
It starts by understanding the powers the system really has and the paths by which those powers could be misused.

That is the method this skill is meant to preserve.
