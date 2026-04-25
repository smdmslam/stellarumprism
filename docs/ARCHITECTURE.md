# Prism Architecture

Three layers, each with one job. The whole product is a working argument that this separation is the right one for AI coding tools.

```text path=null start=null
        ┌──────────────────────────────────────────────────┐
        │  Consumers                                       │
        │  /audit  /fix  /build  /refactor    prism-audit  │   LLM (or zero LLM
        │                                                  │   for the CLI) drives
        └──────────────────────────────────────────────────┘   workflows here.
                            │   tool calls
                            ▼
        ┌──────────────────────────────────────────────────┐
        │  Substrate cells                                 │
        │  typecheck   ast_query   run_tests               │   Deterministic
        │  http_fetch  e2e_run     lsp_diagnostics         │   ground-truth checks.
        │  file_snippet                                    │   No LLM influence.
        └──────────────────────────────────────────────────┘
                            │   shell out / IPC / process
                            ▼
        ┌──────────────────────────────────────────────────┐
        │  Project under inspection                        │
        │  (the user's repo: tsc, cargo, pytest,           │   Real compilers,
        │   rust-analyzer, the dev server, etc.)           │   real test runners,
        └──────────────────────────────────────────────────┘   real HTTP servers.
```

## The substrate layer

A **substrate cell** is a piece of Rust code that runs a real check against the project and returns structured evidence. The contract is narrow:

- Deterministic for a given repo state. The LLM cannot influence what it returns.
- Returns evidence in a unified `Diagnostic` shape (`source`, `file`, `line`, `severity`, `message`) so consumers don't need per-cell translation.
- Read-only. Cells inspect; consumers (gated by approval) edit.
- Substrate failure ≠ project failure. A timeout or "command not found" is `ok: false` on the cell, not a finding against the project.

The cells we ship today:

| Cell | What it runs | Source label |
| --- | --- | --- |
| `typecheck` | `tsc --noEmit` / `cargo check` / `go build` / `pyright` | `typecheck` |
| `ast_query` | TS compiler API (Node helper) for symbol resolution | `ast` |
| `run_tests` | Project's test suite (auto-detected) | `test` |
| `http_fetch` | One HTTP request via reqwest | `runtime` |
| `e2e_run` | Multi-step flow with extract + assert | `runtime` |
| `lsp_diagnostics` | rust-analyzer / pyright / gopls / typescript-language-server | `lsp` |
| `file_snippet` | Line-windowed file read | (read-only helper) |

Adding a new cell is a recipe, not a design problem: implement the entry point, register it in `tools.rs`, give it a JSON schema, optionally wire a config knob. Each cell lives in its own file under `src-tauri/src/`.

See [SUBSTRATE.md](SUBSTRATE.md) for per-cell semantics and configuration.

## The consumer layer

A **consumer** is a workflow that calls substrate cells via tool use. Today's consumers all share the same agent loop, the same approval flow for writes, and the same JSON sidecar contract — they differ only in their system prompt and (sometimes) their default model.

| Consumer | Job | Source restriction | Writes? |
| --- | --- | --- | --- |
| `/audit` | Verify the project against the substrate; emit findings | All cells | No |
| `/fix` | Apply findings from the latest audit | Read + edit_file | Yes (approval) |
| `/build` | Plan → generate → verify → iterate | All cells | Yes (approval) |
| `/refactor` | Same-symbol-aware identifier rename | ast_query + edit_file | Yes (approval) |

Adding a consumer is also a recipe:
1. Add a mode entry in `src/modes.ts`
2. Add a system prompt + default model in `src-tauri/src/agent.rs`
3. Add a parser/prompt builder in `src/<consumer>.ts`
4. Wire one slash-command handler in `src/workspace.ts`

The `prism-audit` CLI is a fifth consumer with no LLM at all — it just runs the substrate cells in sequence and emits the same JSON shape. The architecture proves itself when you can swap the LLM out for a hardcoded sequence and the rest of the pipeline keeps working.

## The confidence grader

Substrate evidence has a tier:

- `confirmed`: backed by `typecheck`, `lsp`, `runtime`, or `test`. The compiler / type system / test runner / live endpoint said so.
- `probable`: backed by `ast`. Structural analysis.
- `candidate`: grep-only or LLM-only. Lead, not proof.

The grader is the deterministic component (`gradeFinding` in `src/findings.ts`) that assigns this tier from a finding's evidence trail — **not** from the LLM's claim. The architectural rule baked into it:

> The LLM cannot raise a finding above `candidate` confidence on its own.

A finding the model cites with `severity=error` but `evidence: source=grep` gets downgraded to `[candidate warning]` automatically. The original claim is preserved in the evidence trail for transparency. This is how Prism survives prompt drift and model misalignment: the substrate decides what counts as proof, not the model.

## Approval flow

Every write tool call (`write_file`, `edit_file`) goes through a per-call approval gate before execution. The user sees a preview card with `--- old / +++ new` markers and either approves once, approves for the session, or rejects. Rejection produces a tool-result message the model sees and can react to ("user rejected this; ask for guidance").

The flow is the same for every consumer. `/fix` and `/refactor` and `/build` all share the same gate — there's no special-case bypass.

## The data model

One canonical shape, used everywhere:

```ts path=null start=null
interface AuditReport {
  schema_version: 1;
  tool: "prism-second-pass";
  generated_at: string;
  scope: string | null;
  model: string;
  summary: { errors: number; warnings: number; info: number; total: number };
  findings: Finding[];
  runtime_probes: RuntimeProbe[];
  substrate_runs: SubstrateRun[];
  raw_transcript: string;
}
```

Defined in `src/findings.ts` (TypeScript) and produced by `aggregate_audit_report()` in `src-tauri/src/diagnostics.rs` (Rust, for the CLI). Both paths emit the same JSON. `/fix` consumes either interchangeably.

Why this matters: Prism's GUI, CLI, and any future consumer (a CI viewer, an IDE plugin, a web dashboard) all reason about the same artifact. There's no parallel data model.

## The workspace spine

Everything described above is per-turn. The **workspace spine** is the
per-project, on-disk index that lets the next turn (or the next tab, or the
next app launch) pick up where the last one left off.

```text path=null start=null
<cwd>/.prism/
  state.json              versioned index: last_audit, last_build,
                          recent_files, layout
  second-pass/            audit reports (markdown + JSON sidecar)
    audit-<ts>.md
    audit-<ts>.json
  builds/                 build/new/refactor/fix/test-gen reports
    build-<ts>.md
    build-<ts>.json
```

`/save`d chats default to `~/Documents/Prism/Chats/<title>.md` rather than
`.prism/`, since they're typically user-curated artifacts that outlive the
project's `.prism/` cache.

`state.json` is a **pointer** index, not a copy of the underlying reports.
It stores `path` + the salient summary fields (severity counts, build
status, verification one-liner) so the Problems panel and `/last` render
without a second disk read; consumers that need the full report follow
`path` and load the markdown / JSON.

Writes are atomic (tmp + rename) and idempotent. Hydration is
cwd-change-driven (triggered by OSC 7), so a brief window before the shell
reports its cwd doesn't paint a stale UI. A corrupt `state.json` is
treated as "no usable state" and is rewritten on the next successful
audit/build instead of bricking the frontend.

`save_chat` / `load_chat` round-trip the agent's message history through a
YAML-frontmatter + `## User` / `## Assistant` markdown shape. `/load`
reseeds the session via a `seed_from_messages` reset on `SessionState`,
adopts the saved title, and reports the model recorded at save time.

## The IDE surface

The spine + the substrate + the consumer layer compose into a small IDE
shape on top of the terminal. None of these are required to use Prism
(`/audit` and `/fix` work fine in a bare terminal); they're affordances
that ride on the same canonical artifacts.

- **File tree.** Lazy-loaded, `.gitignore`-aware, served by a Tauri
  `list_directory_tree` command. Path-scoped to cwd; never reads outside.
- **Editor surface.** A CodeMirror buffer (`src/file-editor.ts`) replaces
  the old read-only preview. Plain-text v1: line numbers, undo/redo,
  default keymap, oneDark theme. Backed by Rust `read_file_text` /
  `write_file_text` with size + binary caps and mtime-based optimistic
  concurrency on save (the open-time mtime is the token; a stale token
  aborts the write).
- **Inline diagnostics.** A CodeMirror `StateField` + `StateEffect` pair
  renders the latest `AuditReport` findings as line tints, wavy mark
  decorations, and gutter markers colored by severity. The workspace
  filters `lastAuditReport.findings` by path suffix on `openFileInEditor`
  and refreshes after every audit completion. Same data model as the
  Problems panel — no parallel diagnostic shape.
- **Resizable layout.** Sidebar, problems-panel, and file-preview pane
  sizes live in CSS custom properties. Pointer drag, double-click snap,
  and Cmd+Opt+[ / ] keyboard nudge mutate them; commits persist into
  `state.json.layout`. Hydration is clamped on apply so a bad state file
  can't make panes unreachable.
- **Build-report pipeline.** `BUILD_SYSTEM_PROMPT` instructs the model to
  emit a `BUILD COMPLETED` / `BUILD INCOMPLETE` block at the end of every
  build/new/refactor/fix/test-gen turn. `src/build-report.ts` is a
  tolerant parser (regex-based, parallel to `findings.ts`) that emits a
  `BuildReport` and renders markdown + JSON. `onBuildComplete` in the
  agent controller fires for any of those modes; the workspace persists
  the sidecar and updates `state.last_build`. If no recognizable block is
  emitted, a stub `incomplete` report is written so the spine stays
  consistent.

## What this architecture buys you

1. **False positives stay candidate.** The grader refuses to graduate a finding without substrate backing, regardless of how confidently the LLM phrases it.
2. **Substrate diversity.** Adding LSP, runtime probing, or e2e flows is a one-cell change; consumers don't need to know.
3. **Consumer diversity.** `/audit`, `/fix`, `/build`, `/refactor` are 600-1000 line files each. They share infrastructure, not bugs.
4. **Deterministic CI gate.** `prism-audit` proves the substrate is useful without the LLM. The same JSON sidecar `/fix` consumes drops out of CI.
5. **One data model.** GUI, CLI, sidecar, panel, editor squiggles — all the same `AuditReport`.
6. **Persistent spine.** Every workspace has a versioned, atomic-written index of its last audit + last build + layout. Tab reload, app relaunch, second tab in the same project all see the same state.

## What this architecture costs

1. **Latency.** A `/audit` round trip includes one or more substrate calls, each shelling out to a real compiler. On a cold rust-analyzer, this is tens of seconds.
2. **Setup friction.** Detection misdetections (a `tsconfig.app.json` not picked up, an LSP server not on PATH) produce surprising "clean" results. The substrate trace surfaces these now, but only if you read the report.
3. **Narrower scope per turn.** A consumer that wants to do something the substrate doesn't cover (e.g. design feedback, prose rewriting) has to either fall back to candidate-only output or wait for a new substrate cell.

These are intentional. The product is "AI coding you can trust at the cost of speed," not "AI coding fast at the cost of correctness."

## File layout

```text path=null start=null
src-tauri/src/
  diagnostics.rs      typecheck + run_tests + ast_query + aggregator
  lsp.rs              LSP JSON-RPC client + session orchestrator
  e2e.rs              E2E flow runner (templating, extract, assert)
  tools.rs            tool schema + dispatch + write approval rails
  agent.rs            system prompts, OpenRouter streaming, tool loop
  config.rs           ~/.config/prism/config.toml + ConfigState
  second_pass.rs      audit-report read/write under .prism/second-pass/
  workspace_state.rs  state.json + .prism/builds/ read/write commands
  save_chat.rs        chat → markdown serializer (/save)
  load_chat.rs        markdown → chat parser (/load) + session reseed
  file_ref.rs         scoped file ops: snippet, full-file read/write,
                      directory listing for the file tree
  bin/prism_audit.rs  the CLI

src/
  workspace.ts        per-tab UI: terminal, problems panel, file tree,
                      editor overlay, layout dividers, slash handlers
  agent.ts            frontend agent controller, tool capture, audit
                      complete + build complete callbacks
  findings.ts         AuditReport shape + parser + grader + renderers
  build-report.ts     BuildReport shape + parser + renderers
  problems.ts         problems panel pure helpers (filter, group, render)
  file-editor.ts      CodeMirror buffer + diagnostics StateField + gutter
  file-tree.ts        sidebar tree state + lazy-load helpers
  snippet.ts          inline file viewer (line-numbered HTML)
  fix.ts              /fix arg parser + selector + prompt builder
  build.ts            /build arg parser + prompt framing
  refactor.ts         /refactor arg parser + prompt framing
  modes.ts            consumer mode registry (UX metadata only)
  slash-commands.ts   slash-command registry (autocomplete + /help)
  editor.ts           CodeMirror input editor + slash autocomplete sources
```

Hot paths:
- A new substrate cell → `src-tauri/src/<cell>.rs` + register in `tools.rs` + dispatch in `agent.rs`
- A new consumer → `src/<consumer>.ts` + mode entry + system prompt in `agent.rs` + slash handler in `workspace.ts`
- A new finding-rendering surface → start in `src/findings.ts` (the data is canonical there)
- A new field on the workspace spine → extend `WorkspaceState` in `src-tauri/src/workspace_state.rs` (additive fields don't bump the schema version) + the mirroring TS interface in `src/workspace.ts`

## Tests

- 138+ Rust unit tests cover substrate parsing, detection, framing, dispatch, and prompt-contract assertions
- 117+ TypeScript tests cover findings parsing, grader behavior, problems panel rendering, and consumer arg parsers

The prompt-contract tests (`agent::prompt_tests`) deliberately pin substrate-discipline language in the system prompts so future copy edits can't silently regress the "ast_query is required for same-symbol resolution" / "typecheck is mandatory after edits" / "do NOT use replace_all=true" rules.
