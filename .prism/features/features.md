# Project Features

This document outlines key features of the Prism project, providing a high-level overview for various stakeholders including investors, marketing teams, and new team members. The features are categorized to facilitate understanding of the project's capabilities and its underlying architecture.

## Core Architecture & Philosophy
*   **Substrate-gated AI Development:** Prism inverts the traditional AI coding tool paradigm by prioritizing deterministic checks (the "substrate") before LLM interpretation. This ensures that all findings, edits, and claims are grounded in verifiable code behavior.
*   **Confidence Grader:** Findings are graded based on the reliability of their source (e.g., substrate cells yield higher confidence than LLM-only claims), providing a more accurate assessment of code quality and issues.

## Recent Enhancements (Last 5 Commits)

### Dual-Tier Verification Strategy
*   **Always Verify (Second-Pass Supervision):** Engages a separate, independent supervisor model to fact-check every response. This "Double-Check" ensures maximum grounding for complex tasks but may lead to shorter, more cautious answers if evidence is not explicitly found in the tool logs.
*   **Auto Verify (Structural Protocol Grounding):** The high-performance default. It relies on Prism's built-in **structural guards**—the Grounded-Chat protocol (SOURCE → EVIDENCE → WORKING) and automatic rigor scanning. It catch hallucinations by cross-referencing model claims (e.g., ✓ Observed) against actual tool logs without the latency of a second model.
*   **Verification-by-Default Philosophy:** Explicitly defines that "Auto Verify" is not a "low-rigor" mode; it is the standard Prism operational state where structural rules are enforced on the primary model, while "Always Verify" acts as an optional supervisory layer.

### Performance & Cost Optimization
*   **Flash-lite Integration & Unified Cost Sorting:** Replaced "flash-latest" with "flash-lite" and unified cost sorting, likely resulting in improved efficiency and optimized resource utilization, especially for API calls or similar operations.

### Dependency Management & Pricing Accuracy
*   **Grok Defaults Migration (v4.1) & Pricing Synchronization:** Updated the project's dependency on Grok to version 4.1 and synchronized pricing models, ensuring compatibility and accurate cost estimations.
*   **Pricing Constants Correction:** Fixed inaccuracies in pricing constants used for usage estimation, preventing discrepancies in cost calculations.

### IDE Surface & Productivity
*   **Pop-out Comparative Reader/Editor:** A large-format, dual-column floating modal designed for side-by-side code analysis. It enables a "Cinema Mode" for complex files, supporting independent scrolling, syntax highlighting, and search across two distinct panes simultaneously.
*   **Persistent Silent Pinning (★):** A non-interruptive staging mechanism in the file explorer. Users can "Star" files to silently add them to the comparative buffer without forcing the modal open, allowing for a fluid "collect-then-compare" workflow.
*   **Active-Pane Visual Targeting:** Uses high-fidelity "Prism Cyan" highlights and focus glows to indicate exactly which pane is targeted for new content, ensuring an intuitive and predictable dual-editing experience.
*   **Surgical File Explorer Updates:** Replaced destructive full-tree refreshes with localized, state-preserving updates. Deleting, renaming, or moving files now occurs instantly with surgical precision—tree state (expansion and selection) is preserved, and labels update in real-time without losing context.
*   **Accordion Inline Diff Cards:** High-fidelity, collapsible code diffs rendered directly in the agent chat. They feature "Cyber-Noir" aesthetics with line-level highlights (+/-), a dedicated "Reveal" icon for quick file access, and a summary of additions/removals. By default, they start collapsed to maintain high information density in the conversation.
*   **"Select is Select" Interaction Paradigm:** Unified the file explorer's selection and pinning logic. Starring a file now automatically syncs its selection state (and vice versa), allowing users to build complex multi-file contexts for the agent or the Comparative Reader without awkward modifier-key combinations.
*   **Custom Session Management:** Empowering users to define their own context. Tabs can be manually renamed via the context menu using a native-feeling modal. These custom titles drive professional, clean chat naming on disk (e.g., `feature-branch-logic.md`), replacing the previous verbose date-stamped filenames.

### Real-Time Economic Awareness
*   **Runway-based Energy Gauge:** A high-fidelity 5-bar "Fuel Gauge" in the toolbar that visualizes AI credit balance. Each bar represents a fixed **$30 increment** of runway, providing a physical, intuitive mental model of remaining "work time."
*   **Cumulative Task Token Tracking:** Real-time metadata in the prompt area that sums token usage across an entire agentic task. It provides transparent "burn rate" visibility for multi-turn workflows and automatically resets for fresh sessions.
*   **Integrated Billing Substrate:** Live synchronization between the frontend UI and backend credit data, ensuring financial transparency is never an "afterthought" but a core part of the active development loop.

### Deep AI Diagnostics & Substrate Grounding
*   **LSP-Native Diagnostics Substrate:** Integration with professional Language Server Protocol (LSP) engines (rust-analyzer, typescript-language-server, pyright). Prism now gathers high-fidelity, type-aware diagnostics directly from the compiler's own analysis thread, providing a "Grade A" source of ground truth for the AI.
*   **Zero-Config "pnpm-ready" Detection:** Intelligent backend path resolution that automatically discovers locally-installed LSP servers in `node_modules/.bin`. This ensures the agent is contextually aware and project-native, even in complex monorepo or pnpm environments.
*   **Contextual Purge:** Cleaned the agentic prompt architecture to remove "real-world" date terminology. The model now receives minimalist, authoritative context that doesn't bleed into user-facing chat logs or filenames, maintaining a professional workspace aesthetic.

## Future Enhancements & Roadmap
*   _This section will be populated with upcoming features and strategic directions._
