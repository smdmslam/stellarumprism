# Prism Usage

Practical reference for everything you can type or invoke.

- [Slash commands](#slash-commands)
- [Modes](#modes)
- [Configuration](#configuration)
- [The Problems panel](#the-problems-panel)
- [The prism-audit CLI](#the-prism-audit-cli)
- [@-path file references](#-path-file-references)

## Slash commands

Type `/` in the input bar to open the autocomplete popup. Tab/Enter to accept; Esc to dismiss.

| Command | What it does |
| --- | --- |
| `/ask <question>` | Force the next submission into agent mode |
| `/cmd <line>` | Force the next submission into shell mode |
| `/audit [scope]` | Read-only verification (see [/audit](#audit) below) |
| `/fix [selector]` | Apply confirmed findings from the latest audit |
| `/build <feature>` | Substrate-gated feature generation |
| `/refactor <old> <new>` | ast_query-verified identifier rename |
| `/problems [show\|hide\|toggle\|clear]` | Toggle the right-side findings panel |
| `/model <slug-or-alias>` | Switch the agent model |
| `/models` | List available models |
| `/new` (alias `/clear`) | Start a fresh chat in this tab |
| `/history` | Print the current tab's user/assistant history |
| `/save` | Save the chat to a markdown file |
| `/cd <path>` | Change shell directory (with path autocomplete) |
| `/verify on\|off\|<model>` | Toggle the reviewer pass / set its model |
| `/help` | Print this list inline |

### `/audit`

Read-only verification. Runs the substrate cells (typecheck, ast_query, optionally run_tests / lsp_diagnostics / http_fetch / e2e_run depending on the diff), parses output into a structured findings list, and writes a report under `<repo>/.prism/second-pass/`.

```text path=null start=null
/audit                          # working tree vs HEAD
/audit HEAD~3                   # last 3 commits as one refactor
/audit HEAD~5..HEAD             # range
/audit @src/pages               # path scope (one file or dir)
/audit --max-rounds=120         # bigger budget for very wide audits
```

Outputs:
- ANSI summary in xterm
- `<repo>/.prism/second-pass/audit-<ts>.md` — human-readable
- `<repo>/.prism/second-pass/audit-<ts>.json` — machine-readable, consumed by `/fix`
- Auto-opens the right-side **Problems panel** with grouped findings

### `/fix`

Reads the latest audit JSON sidecar and applies findings via `edit_file` (each gated on user approval).

```text path=null start=null
/fix                            # all confirmed findings
/fix all                        # explicit form of the above
/fix 1,3                        # specific 1-based indices
/fix 1-5                        # range
/fix #F2,#F4                    # explicit Finding ids
/fix --include=probable         # widen the confidence floor
/fix --include=all              # include candidate-tier (use sparingly)
/fix --report=<path>            # target a specific sidecar instead of the latest
/fix --max-rounds=80            # bigger budget
```

`--include` defaults to `confirmed` (substrate-backed only). Widen at your own risk.

### `/build`

Multi-step substrate-gated generation. Plan → typecheck baseline → execute (read+edit+verify) → iterate → BUILD REPORT.

```text path=null start=null
/build add a /api/health endpoint that returns { ok: true }
/build wire google auth via the next-auth package
/build --max-rounds=200 implement the multi-tenant migration
```

Every edit goes through approval. Every typecheck-touching edit gets verified before the next step. For HTTP-touching features, the agent reaches for `http_fetch` (single endpoint) or `e2e_run` (stateful flow) automatically.

### `/refactor`

Same-symbol-aware identifier rename. Uses `ast_query` to verify each candidate site resolves to the same declaration before editing.

```text path=null start=null
/refactor oldName newName                       # project-wide
/refactor oldName newName --scope=src/auth.ts   # scoped to one file/dir
/refactor oldName newName --max-rounds=120
```

V1 only handles bare identifiers (`[A-Za-z_$][A-Za-z0-9_$]*`). Member access (`Foo.bar`), CSS selectors, and import-path moves are not yet supported and will be rejected with a precise error.

### `/problems`

Toggle the right-side findings panel.

```text path=null start=null
/problems            # toggle (default)
/problems show       # alias: open
/problems hide       # alias: close
/problems clear      # drop the cached report and reset filters
```

The panel auto-opens after `/audit` completes.

### `/cd` (with path autocomplete)

```text path=null start=null
/cd <Tab>                       # browse cwd
/cd Development/<Tab>           # browse subdirectory
```

Cmd+Backspace deletes back to the previous `/` so you can recover from a bad pick in one keystroke. If you type a non-matching prefix, the popup falls back to listing the parent directory rather than closing.

## Modes

Each mode is a persona-switched agent turn: same tools, same session, different system prompt. The slash command dispatches into the corresponding mode. You can also invoke a mode directly via `agent_query` if you're scripting against the Tauri command surface.

| Mode | Slash | Default model | Tool-round floor |
| --- | --- | --- | --- |
| `audit` | `/audit`, `/second-pass` | `x-ai/grok-4-fast` (2M context) | 60 |
| `fix` | `/fix` | `anthropic/claude-haiku-4.5` | 60 |
| `build` | `/build` | `anthropic/claude-haiku-4.5` | 100 |
| `refactor` | `/refactor` | `anthropic/claude-haiku-4.5` | 80 |

Override with `/model <slug-or-alias>` for the session, or per-call with `--model` (where supported).

## Configuration

`~/.config/prism/config.toml` (created on first launch with a starter template).

```toml path=null start=null
[openrouter]
api_key = "sk-or-..."                 # required
default_model = "anthropic/claude-haiku-4.5"
# base_url = "https://openrouter.ai/api/v1"

[agent]
# Rolling history budget per chat tab. Older messages drop after this.
max_context_blocks = 5

# Per-call cap on tool-call rounds. Modes can raise this floor; user
# config can only raise it further.
max_tool_rounds = 40

# Substrate timeouts (seconds).
typecheck_timeout_secs = 60
test_timeout_secs = 120
lsp_timeout_secs = 30

# Optional argv overrides. Win over auto-detection.
# typecheck_command = ["pnpm", "exec", "--", "tsc", "-p", "tsconfig.app.json", "--noEmit"]
# test_command      = ["pnpm", "test", "--reporter=json"]
# lsp_command       = ["rust-analyzer"]

# Dev server URL the runtime probe targets. Auto-detected from project
# shape when unset (vite -> :5173, next -> :3000, django -> :8000, etc.).
# dev_server_url = "http://localhost:5173"

[agent.verifier]
enabled = true
model = "anthropic/claude-haiku-4.5"
min_chars = 200
```

Apply changes with `/model <slug>` or `/verify <option>`; the rest take effect on the next agent query.

## The Problems panel

The right-side panel that auto-opens after `/audit`. Grouped by file, with severity + confidence chips at the top.

- **Click a finding** to expand an inline code snippet around the finding line (15 lines of context, target line highlighted)
- **Hover a row → click `⧉`** to copy `path:line` to clipboard
- **Toggle filter chips** to show/hide errors, warnings, info, or confirmed/probable/candidate findings
- **Esc** closes the panel; `/problems show` reopens with the same filter state
- **Runtime probes section** below the findings shows every `http_fetch` / `e2e_run` the audit ran

## The prism-audit CLI

Substrate-only audit, no LLM, no API key. Designed for CI.

```bash path=null start=null
# Build once
cargo build --manifest-path src-tauri/Cargo.toml --release --bin prism-audit
PRISM_AUDIT=./src-tauri/target/release/prism-audit

# Run from any project directory
$PRISM_AUDIT --help
$PRISM_AUDIT                          # human-readable, exit 2 on errors
$PRISM_AUDIT --format=json            # machine-readable
$PRISM_AUDIT --format=github          # GitHub Actions annotations
$PRISM_AUDIT --fail-on=warning        # exit 2 on errors OR warnings
$PRISM_AUDIT --skip-tests --skip-lsp  # only typecheck
$PRISM_AUDIT --output=audit.json      # write the JSON sidecar
```

### GitHub Actions example

```yaml path=null start=null
- name: Prism audit
  run: |
    ./prism-audit --fail-on=error --format=github
```

The `github` format emits `::error file=src/foo.ts,line=42::Cannot find name 'bar'` so GitHub renders annotations directly on the PR diff.

### CLI exit codes

| Code | Meaning |
| --- | --- |
| 0 | No findings exceeded the `--fail-on` threshold |
| 2 | Findings exceeded the threshold OR usage error |

Default policy: `--fail-on=error`.

### CLI ↔ GUI interop

The CLI and GUI emit the same JSON shape. So you can:

```bash path=null start=null
# In CI:
prism-audit --output=.prism/second-pass/audit-ci.json --fail-on=error
```

Then in the desktop app:

```text path=null start=null
/fix --report=.prism/second-pass/audit-ci.json
```

`/fix` consumes the CI-produced sidecar identically to a GUI-produced one.

## @-path file references

Inside any agent prompt, `@<path>` attaches the file's contents to the turn's context.

```text path=null start=null
@README.md what does this project do?
explain @src/findings.ts in two sentences
```

Path autocomplete pops up after the `@`. Same Cmd+Backspace recovery shortcut as `/cd`.

Limits: 256 KB per file, binary-detected (NUL-byte sniff). Multiple `@-refs` per turn are fine; the agent loop handles them as separate context items.
