# Prism

A substrate-gated AI development environment.

Prism is a desktop AI coding tool built on a different premise than chat-style assistants: every finding, every edit, every claim is grounded in deterministic checks (typecheck, AST resolution, test runner, HTTP probe, LSP) that the LLM cannot influence. The substrate runs first; the model interprets and acts on what it surfaces.

```text path=null start=null
.
├── substrate cells     deterministic checks the LLM cannot fake
│   ├── typecheck       project's actual compiler
│   ├── ast_query       symbol resolution via tsc compiler API
│   ├── run_tests       project's test suite
│   ├── http_fetch      single HTTP probe
│   ├── e2e_run         multi-step stateful flow with assertions
│   ├── lsp_diagnostics rust-analyzer / pyright / gopls / etc.
│   └── file_snippet    line-windowed file reader
│
├── consumers           LLM-driven workflows over the substrate
│   ├── /audit          read-only verifier, confidence-graded findings
│   ├── /fix            applies findings from the latest audit
│   ├── /build          plan → generate → verify → iterate
│   └── /refactor       same-symbol-aware identifier rename
│
├── prism-audit         standalone CLI: substrate as a CI gate
│
└── ui                  problems panel, inline snippets, approval flow
```

## Why this exists

Most AI coding tools let the model speak first and verify second (often poorly, sometimes never). Findings get reported with overconfident phrasing because the model has no other way to express itself. The result is a constant stream of plausible-but-wrong claims that you have to manually fact-check.

Prism inverts the order: deterministic substrate cells run first and produce evidence. The model only graduates a finding above `candidate` confidence when a substrate cell backs it up. Grep-only or LLM-only claims get downgraded automatically. The user sees the actual command the substrate ran, the actual exit code, the actual diagnostic — not the model's paraphrase.

That tradeoff (slower, narrower) buys real correctness guarantees that scale across languages.

## Quick start

```bash path=null start=null
# Install dependencies
pnpm install

# Run the desktop app in dev mode
pnpm tauri dev
```

Add an OpenRouter API key to `~/.config/prism/config.toml` (created on first launch):

```toml path=null start=null
[openrouter]
api_key = "sk-or-..."
```

Then in the running app:

```text path=null start=null
/audit                          # verify the working tree (read-only)
/audit HEAD~5..HEAD             # audit a specific git range
/fix                            # apply confirmed findings from the latest audit
/build add a /api/health route  # substrate-gated feature generation
/refactor oldName newName       # ast_query-verified identifier rename
/problems                       # toggle the right-side findings panel
```

See [docs/USAGE.md](docs/USAGE.md) for the full slash-command reference.

## CI integration

`prism-audit` is a standalone CLI that runs the substrate cells (no API key, no LLM) and emits the same JSON sidecar shape `/audit` produces:

```bash path=null start=null
cargo build --manifest-path src-tauri/Cargo.toml --release --bin prism-audit
./src-tauri/target/release/prism-audit --fail-on=error --format=github
```

Drop it into a workflow and CI will fail on confirmed errors. The sidecar is consumable by `/fix` so you can pull the same report into the desktop app and apply fixes interactively.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the substrate + consumers pattern, the confidence grader, design decisions
- **[docs/USAGE.md](docs/USAGE.md)** — slash commands, configuration, the CLI
- **[docs/SUBSTRATE.md](docs/SUBSTRATE.md)** — per-cell reference (what each cell does, when it runs, how to configure it)

## Status

Active development. The architecture (substrate + consumers + grader) is stable. Surface (UI, CLI flags, config keys) is still moving — anything not pinned by a test should be considered subject to change.

## License

TBD.
