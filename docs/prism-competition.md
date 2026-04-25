Restored session: Sat Apr 25 18:22:50 CEST 2026
Now using node v22.17.0 (npm v10.9.2)
stevenmorales@Stevens-Mac-mini-2 ~ % cd 'Development/StellarumAtlas/'
stevenmorales@Stevens-Mac-mini-2 StellarumAtlas % 
you › give me 10 competitors to this project if there are 10. we have a solid description of our wedge and approach in this file

/Users/stevenmorales/Development/StellarumPrism/docs/vc-prism-auditor.md



✲ agent (deepseek/deepseek-v3.2)
stevenmorales@Stevens-Mac-mini-2 StellarumAtlas % I'll read the project description file first to understand your wedge and approach, then research
→ read_file({"path": "/Users/stevenmorales/Development/StellarumPrism/docs/vc-prism-auditor.md"})
  ← read /Users/stevenmorales/Development/StellarumPrism/docs/vc-prism-auditor.md (22.6 KB)
Now let me search for competitors to this AI code verification and auditing space
→ web_search({"query": "AI code verification audit tools competitors 2026 Cursor Antigravity Warp code review assistant"})
  ← searched "AI code verification audit tools competitors 2026 Cursor Ant
                                                                          …[truncated]" (2.7 KB)
Let me search for more specific competitors in the AI-assisted code verification and second-pass tools


→ web_search({"query": "\"second pass\" code verification AI tool terminal developer workflow 2026"})
  ← searched ""second pass" code verification AI tool terminal developer w
                                                                          …[truncated]" (2.4 KB)
Let me search for more competitors specifically in the AI code review and verification space
→ web_search({"query": "AI code review tools 2026 terminal CLI automated verification linting"})
  ← searched "AI code review tools 2026 terminal CLI automated verificatio
                                                                          …[truncated]" (1.9 KB)
stevenmorales@Stevens-Mac-mini-2 StellarumAtlas % Let me search for more specific competitors 
stevenmorales@Stevens-Mac-mini-2 StellarumAtlas % 
→ web_search({"query": "AI refactoring verification tool incomplete refactors detection 2026 code wiring gaps"})
  ← searched "AI refactoring verification tool incomplete refactors detect
                                                                          …[truncated]" (3.0 KB)
Let me search for a few more specific competitors in the AI coding assistant and verification space
→ web_search({"query": "AI development substrate verification tools compiler-grounded code audit 2026"})
  ← searched "AI development substrate verification tools compiler-grounde
                                                                          …[truncated]" (2.6 KB)
Based on my research, I can now provide you with 10 competitors in the AI code verification and auditing space that are relevant to your project Prism/Second Pass. Here's the competitive landscape:

## 10 Competitors to Prism/Second Pass (AI Code Verification Space, 2026)

### **Primary Category: AI Code Review & PR Analysis**
1. **CodeRabbit** - AI-powered code review tool with CLI support, provides senior-engineer level reviews in terminal, flags hallucinations, logical errors, code smells, and missed tests.
2. **Cursor Bugbot** - Cursor IDE's AI-powered PR review tool with 80.45% F1 score on OpenSSF CVE benchmarks, strong GitHub PR integration.
3. **Qodo 2.0** (ex-CodiumAI) - Enterprise multi-repo review tool with 57% bug detection rate, excels in cross-repo context analysis.
4. **DeepSource** - Full code health platform with AI review, covers 165+ secret providers, SCA, IaC, compliance with 84.51% F1 score on CVE.

### **Secondary Category: Development Agents with Review Capabilities**
5. **Aider** - Terminal-based AI coding agent with "second pass" verification workflow via git-native commits and branches, processes 15B tokens weekly.
6. **Claude Code** - Terminal-first agent with exceptional reasoning ability, massive context window for codebase analysis, runs shell commands, edits files.
7. **Warp** - AI terminal that runs multiple agents (including Claude Code, Codex, Gemini CLI) with dedicated code review panel.
8. **Cline** - Human-in-the-loop CLI agent where every file change and terminal command requires explicit approval.

### **Third Category: Static Analysis & Quality Platforms**
9. **SonarQube** - Long-standing static analysis platform with 40+ language support, AI fixes, quality gates, CI/CD integration.
10. **Codacy** - Static analysis and quality platform with rulesets, PR comments, dashboards for multi-language governance.

### **Bonus (Honorable Mentions):**
- **Gemini CLI** - Google's open-source command-line interface for code review and development workflows
- **Devlo.ai** - Logic and testing audits with deep codebase analysis
- **Byteable** - Autonomous CI/CD refactoring with governed validation
- **Refact.ai** - Self-hosted AI refactoring with manual validation
- **Panto AI** - Unified code + AppSec platform with zero-config VCS

## Key Market Observations:
1. **Your Unique Positioning**: Most competitors focus on PR-level analysis, while Prism focuses on post-refactor "wiring gap" detection
2. **Terminal-Native Gap**: Few tools are truly terminal-native with structured verification workflows; Aider comes closest
3. **Compiler-Grounded Advantage**: No tools appear to have your compiler-grounded approach (typecheck, ast_query, etc.)
4. **Model-Agnosticism**: Most competitors are tied to specific model providers (Cursor→Claude/GPT, Copilot→OpenAI)

## How Prism Differentiates:
- **Specific Focus**: "Second pass" verification after AI-assisted edits (vs. during editing)
- **Compiler-Grounded**: Real tsc/cargo check/pyright integration for deterministic verification
- **Structured Output**: Findings checklist vs. conversational responses
- **Filesystem-as-Database**: Markdown-based, portable, no vendor lock-in
- **Editor-Agnostic**: Works alongside any IDE (Cursor, VS Code, Vim, etc.)
- **Model-Agnostic**: Can route to any capable LLM provider

Your wedge appears unique in targeting the "silent failure mode of AI-assisted refactoring" specifically, rather than general code review or static analysis.

stevenmorales@Stevens-Mac-mini-2 StellarumAtlas % 
you › referring to the context of this chat a couple of questions...whats PR level analysys, all the ide's i know have a terminal window.. how is prism different as "few are truly terminal native" ie and what does terminal native offer?, and last, unique targeting of refactoring is fine, but if that market is small, then what else do we have to offer?

✲ agent (deepseek/deepseek-v3.2)
stevenmorales@Stevens-Mac-mini-2 StellarumAtlas % Great follow-up questions. Let me address each one based on the competitive context:

## **1. What is "PR level analysis"?**

PR (Pull Request) level analysis tools are designed to review **code when it's about to be merged**, not while you're actively developing. They work like this:

```bash
# You make changes, commit them, push to GitHub
git add .
git commit -m "refactor auth system"
git push origin main

# PR-level tools analyze AFTER you create a pull request
# BEFORE:        ┌────────────────┐      AFTER:
# Code → Edit → │ PR-Level Tool │ → Merge → Production
#                └────────────────┘
```

Examples: CodeRabbit, Cursor Bugbot, DeepSource analyze:
- The **diff** between feature branch and main
- Only **new code** being introduced
- In **GitHub/GitLab PR comments**

**Your Prism advantage**: You analyze **during development**, when the refactor is still incomplete, catching wiring gaps *before* they become PR-ready. This is like catching architectural mistakes during framing, not after the house is built.

## **2. "All IDEs have a terminal window... how is Prism different as 'truly terminal native'?"**

You're right that IDEs have terminal panes, but there's a fundamental difference in **workflow architecture**:

### **IDE with Terminal Pane:**
```
┌─────────────────────────────────┐
│   IDE (Primary Surface)         │
│  ┌──────────────────────────┐   │
│  │ Code Editor              │   │
│  │                          │   │
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │ Terminal (Accessory)     │ ← Secondary │
│  │                          │   │
│  └──────────────────────────┘   │
└─────────────────────────────────┘
```

### **Prism (Terminal-Native):**
```
┌─────────────────────────────────┐
│   Terminal (Primary Surface)    │
│  ┌──────────────────────────┐   │
│  │ Prism Agent              │ ← Primary    │
│  │ - Audit                  │   │
│  │ - Fix                    │   │
│  │ - Build                  │   │
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │ IDE Shell (if needed)    │ ← Optional │
│  └──────────────────────────┘   │
└─────────────────────────────────┘
```

### **What Terminal-Native Offers:**

1. **Shell-Sensitive UX**: Prism understands you're in a shell → it can:
   - Auto-detect git diffs (`HEAD~3`)
   - Use your shell's current directory
   - Run build commands in your environment
   - Output in shell-friendly format (copy-pasteable code blocks)

2. **Integration with Shell Workflows**:
   ```bash
   # Pipe Prism output to other tools
   prism audit | grep "critical" | tee critical-fixes.txt
   
   # Chain with git
   prism fix all && git add . && git commit -m "fix wiring gaps"
   
   # Use in scripts/CI
   if prism audit --fail-on critical; then
     echo "Ready to ship!"
   fi
   ```

3. **Keyboard-First Navigation**: No mouse needed. Developers who live in terminals prefer:
   ```
   > prism audit
   [1] src/auth.ts:42 – missing export
   [2] src/api.ts:117 – unresolved reference
   > fix 1   # Single-key fixes
   ```

4. **Lightweight**: Terminal-first means no Electron, no 2GB download, works over SSH, works on servers.

**Competitors**: Most "terminal-capable" tools are **IDE-first**, terminal is an afterthought. Your terminal-native approach is like VSCode vs. Vim—different workflow philosophies.

## **3. "If refactoring market is small, what else do we offer?"**

Looking at your own architecture, you have **multiple expansion vectors** beyond refactoring verification:

### **Current Capabilities (Beyond `/audit`):**
1. **`/build`** - Feature development against substrate  
   Example: `prism build "add user profile page with avatar upload"`
   - Plans → Generates → Verifies (compiler, tests, runtime)

2. **`/test-gen`** - Test generation for existing code
   Example: `prism test-gen src/auth.ts:UserService`

3. **`/new`** - Project scaffolding
   Example: `prism new "nextjs app with drizzle + auth"`

4. **`/fix`** - Automated repair of identified issues

### **Near-Term Expansions (Weeks):**
5. **`/explain`** - Codebase navigation & documentation
   ```
   prism explain "How does our auth flow work?"
   ```

6. **`/review-pr`** - PR review specialization (competes with CodeRabbit)
   ```
   prism review-pr https://github.com/org/repo/pull/42
   ```

7. **`/debug`** - Interactive debugging assistance
   ```
   prism debug "Test fails with 'user not found' error"
   ```

### **Strategic Positioning:**

Think of Prism as **"The Developer's Second Brain with Verification Guarantees"**:

| **Workflow Phase** | **What Prism Helps With** | **Market Size** |
|-------------------|---------------------------|----------------|
| **Before Coding** | `/new` - Scaffold projects | Large (all new projects) |
| **During Coding** | `/build` - Build features<br>`/test-gen` - Add tests | Very Large (all feature work) |
| **After Coding** | `/audit` - Verify changes<br>`/fix` - Repair issues | Medium (critical projects) |
| **Code Review** | `/review-pr` - PR analysis | Large (all teams) |
| **Learning** | `/explain` - Understand code | Medium (new hires, legacy code) |
| **Debugging** | `/debug` - Troubleshoot | Medium (all production issues) |

### **The Core Value Proposition:**
**"AI-generated code with deterministic verification baked in."** This applies to ANY AI-generated code, not just refactors:

- New feature? → `/build` verifies it compiles, passes tests, runs
- PR review? → `/review-pr` with compiler-backed analysis  
- Adding tests? → `/test-gen` then verifies they pass
- Understanding legacy code? → `/explain` with cross-references

### **Business Model Expansion:**
1. **Individual Developers** → $10-20/month for verification
2. **Teams** → Shared audit history, CI integration
3. **Enterprises** → Security/compliance verification
4. **Eventual IDE Tier** → Verified editing experience

### **The Market Is Actually Huge:**
The refactoring wedge gets you in the door, but the **real market** is:
- **All AI-generated code** (getting bigger daily)
- **All code that needs verification** (mission-critical software)
- **All developers who want safety nets** (every professional dev)

**Your insight about "LLMs can't verify their own work" applies to ALL code generation, not just refactoring.** That's the scalable insight.

Does this clarify the competitive positioning and expansion potential?
stevenmorales@Stevens-Mac-mini-2 StellarumAtlas % %                                           

---

## Postscript 1 — who actually wrote the analysis above

The agent label `(deepseek/deepseek-v3.2)` is correct but only half the story. Every `web_search` call in the session above routed to Perplexity Sonar (`perplexity/sonar`, hardcoded in `src-tauri/src/tools.rs`). The actual division of labor in the output you just read:

- **Perplexity Sonar wrote the raw web evidence.** The F1 scores ("80.45% on OpenSSF CVE"), the "15 B tokens weekly" Aider statistic, the named tools, the prices, the dated facts — all came back from Sonar as tool results. Sonar returns short citation-grounded prose; you can spot it in the bare-facts paragraphs.
- **DeepSeek wrote everything else.** The Primary / Secondary / Third categorization, the ASCII architecture diagrams, the workflow-phase market table, the "Second Brain with Verification Guarantees" framing, the expansion-vector analysis, the "Strategic Positioning" section. That's all DeepSeek's synthesis voice working from Sonar's tool results plus the auditor doc loaded into context via a single `read_file`.

This is by design. Substrate-gated development means the synthesis model isn't reasoning freely from training; it's structuring real evidence that already came back grounded. The "thoughtful, not token-repressed" feel of the analysis is the substrate-thick tool-loop ratio working as intended — the same architectural bet that lets a mid-tier model run audits with frontier-model quality.

## Postscript 2 — comprehensive context vs. retrieval (a wedge of its own)

The shape of the answer above is itself the strongest evidence for a Prism wedge that didn't fit the original verification narrative.

Most AI editors retrieve: Cursor / Copilot / Antigravity / Codex tokenize the codebase, index chunks, and at each turn fetch the top-K nearest neighbors of the user's prompt. For tactical edits that's fine. For comprehensive work — a market-positioning doc against the whole project, a pitch deck cognizant of every shipped capability, an RFC reflecting the full architecture — the model has never seen the source document end-to-end, only ranked fragments stripped of structural coherence. The output is piecemeal because the input is piecemeal.

Prism's `read_file` tool returns the whole file (up to 128 KB) into a long-context model that holds it for the entire conversation. Every follow-up turn anchors on the full document, not a re-retrieved fragment. The session above is the canonical example: a single `read_file` on the 22.6 KB auditor doc plus five Sonar-backed web searches produced a coherent multi-section analysis that referenced Prism's own positioning verbatim. The retrieval-based competitors structurally cannot do that.

The user-visible consequence: vibe-coders shipping complete products run into the comprehensive-context wall every day. Trying to write a pitch deck or a launch announcement that holds the *whole* project in mind, in Cursor or Copilot, returns fragments that have to be manually stitched. Prism does it natively. This is distinct from the verification wedge but anchored on the same architectural choice (whole-document tool reads + long-context routing) and it serves the same kind of user (the senior or solo developer who needs end-to-end project coherence to ship).

For the deck — promoted to Slide 7 in `docs/vc-pitchdeck.md`. For the auditor doc — added under "Why this is durable" in `docs/vc-prism-auditor.md`. For the architecture file — see `docs/internal-architecture-perplexity-deepseek.md` for why this pairing pattern is private and how it generalizes.
