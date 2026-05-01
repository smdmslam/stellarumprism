**Prism** is a substrate-gated AI coding environment — a Tauri desktop app where every LLM claim is grounded by deterministic checks (typecheck, AST, tests, HTTP probes, LSP) that the model cannot fake.

### Core Architecture:
- **Substrate cells**: `typecheck`, `ast_query`, `run_tests`, `http_fetch`, `e2e_run`, `lsp_diagnostics`, `file_snippet`
- **Consumers/Modes**: `/audit`, `/build`, `/fix`, `/refactor`, `/new`, `/test-gen`
- **Confidence grader**: `confirmed` (substrate-backed) > `probable` (AST) > `candidate` (grep/LLM-only)
- **Approval flow**: All writes require user approval

### Models Available (from `models.ts`):

| Tier | Alias | Full Slug | Vision | Tools |
|------|-------|-----------|--------|-------|
| Main | `gpt-5.4` | `openai/gpt-5.4` | ✓ | ✓ |
| Main | `grok-4.1-fast` | `x-ai/grok-4.1-fast` | — | ✓ |
| Main | `kimi` | `moonshotai/kimi-k2.5` | ✓ | ✓ |
| Main | `qwen3.6-plus` | `qwen/qwen3.6-plus` | — | ✓ |
| Main | `glm-5` | `z-ai/glm-5` | — | ✓ |
| Main | `deepseek` | `deepseek/deepseek-v3.2` | — | ✓ |
| Main | `haiku` | `anthropic/claude-haiku-4.5` | ✓ | ✓ |
| Main | `qwen3` | `qwen/qwen3-next-80b-a3b-instruct` | — | ✓ |
| Main | `gpt-oss` | `openai/gpt-oss-120b:exacto` | — | ✓ |
| Explore | `step` | `stepfun/step-3.5-flash` | — | ✓ |
| Explore | `devstral` | `mistralai/devstral-small` | — | ✓ |
| Explore | `codestral` | `mistralai/codestral-2508` | — | ✓ |
| Explore | `mercury` | `inception/mercury-2` | — | ✗ |
| Explore | `gpt5-mini` | `openai/gpt-5-mini` | ✓ | ✓ |
| Explore | `qwen-235b` | `qwen/qwen3-235b-a22b-2507` | — | ✓ |
| Explore | `scout` | `meta-llama/llama-4-scout` | ✓ | ✓ |
| Explore | `grok-fast` | `x-ai/grok-4.1-fast` | — | ✓ |
| Explore | `minimax` | `minimax/minimax-m2.5` | — | ✓ |

---

## 📋 TEST PROMPT & TASK LIST

Save this list. We'll run each model through all of these.

---

### **1. BASIC CHAT & QUESTION HANDLING**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 1.1 | `What is 2 + 2?` | Simple answer, no tools needed |
| 1.2 | `?what files are in this project` | Should route to agent, list files |
| 1.3 | `/ask explain what this project does in 2 sentences` | Forced agent mode, summarize README |
| 1.4 | `list all .ts files in src/` | Should use `find` tool |
| 1.5 | `show me package.json` | Should use `read_file` tool |

---

### **2. SLASH COMMANDS**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 2.1 | `/help` | Print all slash commands |
| 2.2 | `/models` | List all available models with aliases |
| 2.3 | `/model haiku` | Switch to Claude Haiku 4.5 |
| 2.4 | `/model grok-4.1-fast` | Switch to Grok 4.1 Fast |
| 2.5 | `/history` | Show conversation history |
| 2.6 | `/clear` then `/history` | Clear chat, verify empty history |
| 2.7 | `/files` | Open file tree in sidebar |
| 2.8 | `/problems` | Toggle problems panel |
| 2.9 | `/last` | Show last audit/build summary |
| 2.10 | `/cd src` then `/cd ..` | Directory navigation with autocomplete |
| 2.11 | `/verify on` | Enable reviewer pass |
| 2.12 | `/verify off` | Disable reviewer pass |
| 2.13 | `/verify haiku` | Set reviewer model to Haiku |

---

### **3. /AUDIT MODE (Read-Only Verification)**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 3.1 | `/audit` | Full working-tree audit, produces `.prism/second-pass/audit-*.md` + `.json` |
| 3.2 | `/audit HEAD~1` | Audit last commit only |
| 3.3 | `/audit HEAD~3..HEAD` | Audit a range of commits |
| 3.4 | `/audit @src/modes.ts` | Audit a single file |
| 3.5 | `/audit @src/` | Audit a directory |
| 3.6 | `/audit --max-rounds=80` | Run with higher tool budget |
| 3.7 | After audit, click a finding in Problems panel | Opens inline snippet |
| 3.8 | Hover finding, click copy icon | Copies `path:line` to clipboard |

---

### **4. /FIX MODE (Apply Findings)**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 4.1 | `/fix` | Apply all confirmed findings from latest audit |
| 4.2 | `/fix all` | Same as above, explicit |
| 4.3 | `/fix 1,3` | Apply specific findings by index |
| 4.4 | `/fix 1-5` | Apply a range of findings |
| 4.5 | `/fix #F2,#F4` | Apply by explicit Finding ID |
| 4.6 | `/fix --include=probable` | Widen to probable-confidence findings |
| 4.7 | `/fix --include=all` | Include candidate-tier (use sparingly) |
| 4.8 | Approve a write in the approval card | See diff, click Approve |
| 4.9 | Reject a write in the approval card | Should not apply, model reacts |
| 4.10 | `/fix --report=.prism/second-pass/audit-ci.json` | Target a specific report |

---

### **5. /BUILD MODE (Feature Generation)**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 5.1 | `/build add a function sum(a, b) to src/workspace.ts` | Simple addition, verify typecheck |
| 5.2 | `/build add a /api/health route that returns {ok:true}` | HTTP route, probe with `http_fetch` |
| 5.3 | `/build add a greet(name: string) function to a new file src/greet.ts` | Create new file |
| 5.4 | `/build --max-rounds=120 add a User type with id, name, email to src/types.ts` | Higher budget |
| 5.5 | After build, verify the file has the new code | Manual check |
| 5.6 | After build, check `/last` shows the build report | Verify spine persistence |

---

### **6. /REFACTOR MODE (Identifier Rename)**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 6.1 | `/refactor MODES ALL_MODES` | Rename constant, verify AST resolution at each site |
| 6.2 | `/refactor findMode getMode` | Rename function |
| 6.3 | `/refactor oldName newName --scope=src/modes.ts` | Scoped rename |
| 6.4 | `/refactor nonexistent newName` | Should error: symbol not found |
| 6.5 | After refactor, run `/audit` | Verify no breakage |

---

### **7. /NEW MODE (Project Scaffolding)**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 7.1 | `/new test-project vite + react + typescript` | Scaffold a minimal Vite+React+TS project |
| 7.2 | `/new another-project vanilla ts --into=test-projects/` | Scaffold into subdirectory |
| 7.3 | `/new big-project next.js --max-rounds=150` | Larger scaffold |
| 7.4 | Verify SCFFOLD REPORT is emitted | Check for install/dev instructions |
| 7.5 | Run suggested install command | Verify the scaffold compiles |

---

### **8. /TEST-GEN MODE (Test Generation)**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 8.1 | `/test-gen findMode` | Generate tests for the `findMode` function |
| 8.2 | `/test-gen resolveModel --file=src/models.ts` | Scoped test generation |
| 8.3 | `/test-gen nonexistentSymbol` | Should error: symbol not found |
| 8.4 | After test-gen, run `pnpm test` | Verify tests pass |

---

### **9. @-PATH FILE REFERENCES**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 9.1 | `@README.md summarize this` | Attach README, summarize |
| 9.2 | `@src/modes.ts explain what MODES is` | Attach file, explain constant |
| 9.3 | `@src/agent.ts @src/workspace.ts compare these two files` | Multiple file refs |
| 9.4 | `@package.json what scripts are available?` | Read JSON file |
| 9.5 | `@nonexistent.ts what is this?` | Should error: file not found |

---

### **10. SHELL INTEGRATION**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 10.1 | `ls -la` | Run as shell command |
| 10.2 | `/cmd echo hello` | Forced shell mode |
| 10.3 | `pnpm test` | Run test suite in shell |
| 10.4 | `git status` | Check git status |
| 10.5 | `git log --oneline -5` | View recent commits |

---

### **11. SUBSTRATE CELL COVERAGE**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 11.1 | `/build` on a TypeScript project | Triggers `typecheck` cell |
| 11.2 | `/audit` that touches HTTP routes | Triggers `http_fetch` cell |
| 11.3 | `/build` with stateful feature | Triggers `e2e_run` cell |
| 11.4 | `/audit` on Rust project (if available) | Triggers `lsp_diagnostics` (rust-analyzer) |
| 11.5 | `/refactor` | Triggers `ast_query` cell |
| 11.6 | `/build` with tests | Triggers `run_tests` cell |
| 11.7 | Problems panel snippet view | Triggers `file_snippet` (implicit) |

---

### **12. SAVE/LOAD CHAT**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 12.1 | `/save` | Opens save dialog, saves to `~/Documents/Prism/Chats/` |
| 12.2 | `/load` | Opens file picker, loads previous chat |
| 12.3 | After load, `/history` | Verify history is restored |
| 12.4 | After load, check model matches | Verify model badge shows saved model |

---

### **13. MODEL SWITCHING & ROUTER**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 13.1 | `/model gpt-5.4` then `/audit` | Use GPT-5.4 for audit |
| 13.2 | `/model kimi` then `/build add a hello world function` | Use Kimi for build |
| 13.3 | `/model mercury` then `/build something` | Should warn: no tool support, swap to fallback |
| 13.4 | `/model deepseek` then ask a question | Use DeepSeek for chat |
| 13.5 | `/model invalid-model-name` | Should error or stay on current |

---

### **14. VISION/MULTIMODAL (for models that support it)**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 14.1 | Drag an image into chat with `kimi` model | Model describes image |
| 14.2 | Drag an image with `haiku` model | Model describes image |
| 14.3 | Drag an image with `grok-4.1-fast` | Should reject or warn (no vision) |
| 14.4 | Screenshot + "what does this show?" | Vision model analyzes |

---

### **15. APPROVAL FLOW EDGE CASES**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 15.1 | `/build` that makes 5 edits, approve first 2, reject rest | Partial application |
| 15.2 | Click "Approve all (session)" | All subsequent writes auto-approve |
| 15.3 | Reject a write, then ask model to retry | Model should adapt |
| 15.4 | Edit file externally during approval | mtime conflict should abort save |

---

### **16. PROBLEMS PANEL**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 16.1 | `/problems show` | Open panel |
| 16.2 | `/problems hide` | Close panel |
| 16.3 | `/problems clear` | Clear cached report |
| 16.4 | Toggle severity filter chips | Show/hide errors, warnings, info |
| 16.5 | Toggle confidence filter chips | Show/hide confirmed, probable, candidate |
| 16.6 | Runtime probes section | Shows HTTP probes from audit |

---

### **17. FILE TREE & EDITOR**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 17.1 | `/files` then click a file | Opens in editor |
| 17.2 | Edit file in editor, Cmd+S | Saves with mtime check |
| 17.3 | Edit file, don't save, click another file | Prompts to discard |
| 17.4 | Toggle hidden files (eye icon) | Show/hide dotfiles |
| 17.5 | Open file with audit findings | See inline squiggles |

---

### **18. RESIZABLE LAYOUT**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 18.1 | Drag sidebar divider | Resize sidebar |
| 18.2 | Drag problems panel divider | Resize panel |
| 18.3 | Double-click divider | Snap to default |
| 18.4 | Cmd+Opt+[ / Cmd+Opt+] | Nudge divider |
| 18.5 | Restart app | Layout persists |

---

### **19. ERROR HANDLING & EDGE CASES**

| # | Prompt | Expected Behavior |
|---|--------|-------------------|
| 19.1 | Remove API key, then `/ask hello` | Should error: no API key |
| 19.2 | `/audit` on non-git directory | Should handle gracefully |
| 19.3 | `/build` with circular dependency | Model should detect and report |
| 19.4 | Very long prompt (10KB+) | Should handle or truncate gracefully |
| 19.5 | Cancel during agent stream | Should stop cleanly |
| 19.6 | Stall timeout (wait 45s with no tokens) | Should warn "stream silent" |

---

### **20. CLI: prism-audit**

| # | Command | Expected Behavior |
|---|---------|-------------------|
| 20.1 | `cargo build --release --bin prism-audit` | Build CLI |
| 20.2 | `./prism-audit --help` | Show help |
| 20.3 | `./prism-audit` | Run audit, human-readable output |
| 20.4 | `./prism-audit --format=json` | JSON output |
| 20.5 | `./prism-audit --format=github` | GitHub Actions annotations |
| 20.6 | `./prism-audit --fail-on=warning` | Exit 2 on warnings |
| 20.7 | `./prism-audit --output=audit.json` | Write sidecar |

---

### **21. CONFIGURATION**

| # | Test | Expected Behavior |
|---|------|-------------------|
| 21.1 | Edit `~/.config/prism/config.toml`, change `default_model` | New model on restart |
| 21.2 | Set `max_tool_rounds = 20` | Lower tool budget |
| 21.3 | Set `dev_server_url = "http://localhost:3000"` | Override detection |
| 21.4 | Set `verifier.enabled = false` | No review pass |

---

### **22. CROSS-MODEL COMPARISON TASKS**

*These are the key tasks to run on ALL models for comparison:*

| # | Prompt | Metrics to Track |
|---|--------|------------------|
| 22.1 | `/audit` (same scope) | Time, findings count, accuracy |
| 22.2 | `/build add a formatDate(date: Date): string function to src/utils.ts` | Time, correctness, typecheck pass |
| 22.3 | `/refactor MODES ALL_MODES` | Time, correctness, AST verification |
| 22.4 | `/test-gen resolveModel` | Time, test quality, tests pass |
| 22.5 | `@README.md summarize in 3 bullet points` | Time, quality, no hallucination |
| 22.6 | `/ask what are the main substrate cells?` | Accuracy, completeness |
| 22.7 | `/build add /api/status that returns {status: "ok", timestamp}` | HTTP probe success |
| 22.8 | Multi-step `/build` with 3 file edits | Approval flow handling |
| 22.9 | Vision test (for vision models): screenshot + "describe" | Quality of description |
| 22.10 | `/fix` on a known issue | Correctness, precision |

---

This is your **master test list**. Save it. We'll run each model through all applicable tasks and compare:

- ✅ Correctness
- ⏱️ Latency
- 🎯 Precision (no hallucinations)
- 🔧 Tool usage quality
- 📊 Substrate evidence quality