# Claude Code Handoff & Synergy Protocol

Use this skill when a task requires extreme-scale refactoring, multi-file architectural changes, or deep reasoning that benefits from the specialized `claude` CLI agent. This protocol ensures Prism and Claude Code work in tandem: Prism provides the "Grounded" verification and project context, while Claude Code executes the high-intensity modifications.

## When to Invoke
- **Complex Refactors:** Moving logic across multiple files or changing core abstractions.
- **Deep Debugging:** When an issue requires extensive investigation across the entire codebase.
- **Boilerplate Generation:** Creating large sets of related components or modules.
- **Architectural Shifts:** Migrating frameworks or implementing large-scale design patterns.

## Protocol Steps

### 1. Preparation (Prism's Role)
Before invoking Claude Code, Prism must ensure the environment is stable:
- **Audit Check:** Run `pnpm exec prism audit` (or `cargo check`) to establish a "Green State" baseline.
- **Context Pinning:** Identify the core files involved and mention them explicitly in the handoff.
- **Clear Objective:** Define a single, clear mission for the `claude` agent.

### 2. Invocation
Prism will propose running the `claude` command with a specific initial prompt.
Example command: `claude "Refactor the state management in src/workspace.ts to use a central store pattern. Ensure all existing tests pass."`

### 3. Execution (Claude Code's Role)
Claude Code takes the lead in the terminal. The user interacts with Claude directly to iterate on the changes. Prism remains "observant" in the background.

### 4. Verification & Grounding (Prism's Role)
Once Claude Code finishes and the user returns to Prism:
- **Regression Sweep:** Prism must run a full `/audit` to verify the changes.
- **Rigor Check:** Ensure no "Unverified" claims remain in the codebase.
- **Conflict Resolution:** If Claude Code introduced any architectural drift that violates Prism's patterns, Prism should flag them for correction.

## Synergistic Guidelines
- **Prism is the Architect:** Use Prism to plan the change and verify the result.
- **Claude is the Builder:** Use Claude Code for the bulk of the manual code manipulation.
- **Keep it Grounded:** Always use Prism's `substrate` diagnostics to "sanity check" Claude's output. Claude Code is fast, but Prism ensures it's correct within the project's specific constraints.
