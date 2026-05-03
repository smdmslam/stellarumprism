# Substrate cells

Per-cell reference. Each section: what the cell does, when consumers reach for it, how to configure it, what the JSON shape looks like.

For the architectural framing (substrate vs consumers vs grader), see [ARCHITECTURE.md](ARCHITECTURE.md).

- [typecheck](#typecheck)
- [ast_query](#ast_query)
- [run_tests](#run_tests)
- [http_fetch](#http_fetch)
- [e2e_run](#e2e_run)
- [lsp_diagnostics](#lsp_diagnostics)
- [file_snippet](#file_snippet)

## typecheck

The project's actual compiler. Substrate v1 — the foundation.

**Auto-detects:**
- Node: `package.json` script named `typecheck` / `type-check` / `check-types` / `tsc` (winner)
- Node: `tsconfig.app.json` present alongside `tsconfig.json` → `<pm> exec -- tsc -p tsconfig.app.json --noEmit` (Vite + React/Vue/Svelte template)
- Node fallback: `tsconfig.json` → `<pm> exec tsc --noEmit`
- Rust: `Cargo.toml` → `cargo check --message-format=short`
- Go: `go.mod` → `go build ./...`
- Python: `pyproject.toml` AND `pyright` on PATH → `pyright --outputjson`

**Override via config:**
```toml path=null start=null
[agent]
typecheck_command = ["pnpm", "exec", "--", "tsc", "-p", "tsconfig.app.json", "--noEmit"]
typecheck_timeout_secs = 60
```

**Output (per call):** `command`, `exit_code`, `duration_ms`, `diagnostics: [{source, file, line, col, severity, code, message}]`, `diagnostics_truncated`, `raw`, `raw_truncated`, `timed_out`.

A clean exit + zero diagnostics is "the project compiles." A non-zero exit + diagnostics is the typical "project has errors" case — substrate evidence, not a tool failure.

Caps: 200 diagnostics, 8 KB raw output.

## ast_query

Symbol resolution via the TypeScript compiler API. Spawned as a one-shot Node helper that loads the project's `typescript` package and answers structural questions.

**v1 op:** `resolve` — does identifier `<symbol>` exist in scope at `file[:line]`? If yes, where is it declared?

**Used by:**
- `/audit` before flagging "X is undefined" claims that `typecheck` didn't already report (anti-false-positive)
- `/refactor` to verify each candidate site resolves to the same declaration as the rename anchor
- `/build` after referencing a new symbol, to confirm it binds

**Args:** `{ op: "resolve", file, symbol, line? }`.

**Output:** `{ ok, result: { resolved, declaration: { file, line, kind } | null, evidence_detail }, error }`.

The `evidence_detail` line is what the model pastes verbatim into a Finding's `evidence: source=ast; detail=...` stanza. The grader graduates that finding to `probable`.

Requires the project to have a working `tsconfig.json` and `typescript` resolvable via `node_modules`.

## run_tests

The project's test suite.

**Auto-detects:**
- Node: `package.json` script named `test` (run via the detected package manager)
- Node fallback: presence of `vitest` / `jest` / `mocha` in `devDependencies` → run via `<pm> exec`
- Rust: `Cargo.toml` → `cargo test`
- Python: `pyproject.toml` with `pytest` declared → `pytest`
- Go: `go.mod` → `go test ./...`

**Override via config:**
```toml path=null start=null
[agent]
test_command = ["pnpm", "test", "--reporter=json"]
test_timeout_secs = 120
```

**Output:** `command`, `exit_code`, `duration_ms`, `passed: bool`, `failures: [{file, severity, message, evidence: [...]}]`, `failures_truncated`, `raw`, `raw_truncated`, `timed_out`.

A failing test → `source=test` → grader graduates to `confirmed`. Used optionally by `/audit` when typecheck is clean but the diff is non-trivial; required by `/build` for stateful behavior changes.

Tests are slow on average — budget rounds accordingly. The cell timeout defaults to 120s.

## http_fetch

One HTTP request. The strongest pre-E2E runtime signal short of a recorded flow.

**Args:** `{ url, method?, headers?, body?, timeout_secs? }`.

**Used by:**
- `/audit` step 3b (mandatory when applicable): if the diff touches an HTTP route/middleware/controller, probe the endpoint
- `/build` step 3.f (mandatory for HTTP work): probe the endpoint after wiring it

**Output:** `{ url, method, status, status_text, body, response_headers, duration_ms, ok, error, evidence_detail }`.

Transport errors (timeout, connection refused) → `ok: false` and treated as "dev server not running," NOT as endpoint bugs. The carve-out is critical: a flaky local dev server should never produce false-positive findings.

A successful response (any status) → `source=runtime` → grader graduates findings to `confirmed`.

The dev server URL is auto-detected from project shape (`detect_dev_server_url`):
- Vite config with explicit `port:` → that port
- `next.config.*` present → `:3000`
- `package.json` `dev` script with `--port=N` or `-p N` → that port
- `vite` / `next` / `@remix-run/dev` / `@sveltejs/kit` in dependencies → conventional defaults
- Django `manage.py` → `:8000`
- FastAPI / Flask in pyproject → `:8000` / `:5000`

Override:
```toml path=null start=null
[agent]
dev_server_url = "http://localhost:5173"
```

Body cap: 32 KB.

## e2e_run

Multi-step stateful flow with variable extraction and assertions. Substrate v6 — the strongest runtime signal Prism produces.

**Used by:**
- `/audit` step 3c (optional): when the diff touches a stateful flow (auth, multi-step CRUD)
- `/build` step 3.g (optional): when the feature is multi-step

**Args:**
```ts path=null start=null
{
  flow_name: string;
  steps: Array<{
    name?: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
    url: string;                  // supports {{var}} templates
    headers?: { [k: string]: string };  // values support {{var}}
    body?: string;                // supports {{var}}
    timeout_secs?: number;
    extract?: Array<                  // pull values into the var map
      | { name: string; from: "json"; path: string }
      | { name: string; from: "header"; name: string }
    >;
    assert?: Array<                   // evaluate against the response
      | { kind: "status"; equals: "200" | "2xx" | ... }
      | { kind: "body_contains"; value: string }
      | { kind: "json_eq"; path: string; value: <any JSON> }
    >;
  }>;
  vars?: { [k: string]: string };   // initial template variables
  timeout_secs?: number;
}
```

**Output:** `{ flow_name, passed, aborted, duration_ms, steps: [...], evidence_detail }`. `passed=true` iff every step responded AND every assertion across every step passed.

Transport failures abort the flow with `aborted=true` (same carve-out as `http_fetch` — not a project bug).

Cap: 25 steps per flow, 16 KB body per step.

Example (login → /me):
```json path=null start=null
{
  "flow_name": "auth_smoke",
  "steps": [
    {
      "method": "POST",
      "url": "http://localhost:5173/api/login",
      "headers": { "Content-Type": "application/json" },
      "body": "{\"email\":\"alice@example.com\"}",
      "extract": [{ "name": "token", "from": "json", "path": "token" }],
      "assert": [{ "kind": "status", "equals": "200" }]
    },
    {
      "method": "GET",
      "url": "http://localhost:5173/api/me",
      "headers": { "Authorization": "Bearer {{token}}" },
      "assert": [
        { "kind": "status", "equals": "2xx" },
        { "kind": "json_eq", "path": "id", "value": 42 }
      ]
    }
  ]
}
```

## lsp_diagnostics

Generic Language Server Protocol client. Substrate v5 — the language-agnostic move. Complements `typecheck` with cross-file lints, unused-import warnings, dead-code analysis.

**Auto-detects (in order):**
- `Cargo.toml` + `rust-analyzer` on PATH
- `go.mod` + `gopls` on PATH
- `pyproject.toml` / `setup.py` / `requirements.txt` + `pyright-langserver` on PATH (preferred) or `pylsp`
- `tsconfig.json` / `package.json` + `typescript-language-server` on PATH

**Override via config:**
```toml path=null start=null
[agent]
lsp_command = ["rust-analyzer"]
lsp_timeout_secs = 30
```

**Args:** `{ files?, command?, timeout_secs? }`. Empty `files` lets the server do project-wide analysis.

**Output:** `{ command, server, initialized, duration_ms, diagnostics: [...], diagnostics_truncated, raw, raw_truncated, timed_out }`. Each diagnostic carries `source: "lsp"` → grader graduates to `confirmed`.

Idle-quiet termination: stop collecting diagnostics once 1.5s passes after the last message (4s if none received yet) — so a fast clean project doesn't wait for the full 30s timeout. A long cold start (rust-analyzer on a fresh project) may genuinely need the full timeout.

Server-initiated requests (`workspace/configuration`, `client/registerCapability`, `window/workDoneProgress/create`) are answered minimally so servers like rust-analyzer don't hang.

## file_snippet

Read-only line-windowed file reader. Backs the Problems panel's inline snippet viewer.

**Args:** `{ cwd, path, line, before?, after? }` — 1-based line, default 6 before / 8 after.

**Output:** `{ path, original, start_line, end_line, target_line, total_lines, content, truncated }`.

Caps: 80 context lines per side. Binary-safe (NUL sniff in first 8 KB). Rejects directory targets.

Not surfaced as a tool the model calls — used directly by the frontend via the `read_file_snippet` Tauri command.

## Adding a new substrate cell

The recipe is the same for every cell:

1. **Implement** in `src-tauri/src/<cell>.rs`. Public entry function returns a structured `<Cell>Run` type. Provide a `to_<cell>_payload()` helper that emits the JSON the model sees.
2. **Register** in `src-tauri/src/tools.rs`:
   - Add the JSON schema entry to `tool_schema()`
   - Add a sync wrapper (errors with "use async" if the cell is async, otherwise calls the entry function directly)
   - Add to `is_async_tool()` if async
   - Add to `needs_config_dispatch()` if it has config knobs
3. **Wire dispatch** in `src-tauri/src/agent.rs`'s tool-call match
4. **Update prompts** in `agent.rs` (audit + build prompts get a 3a-bis / e-bis-style mention)
5. **Add prompt-contract tests** so the prompt language can't silently regress
6. **Document** here

The architectural promise: a future cell (e.g. schema-migration verifier, log-tailing probe) drops in without changing any consumer's code beyond a one-line prompt mention.
