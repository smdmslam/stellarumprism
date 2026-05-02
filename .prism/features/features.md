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

## Future Enhancements & Roadmap
*   _This section will be populated with upcoming features and strategic directions._
