Based on the MASTER-Plan-III.md, here are the 5 "low-hanging fruit" tasks that are relatively easy to implement but provide high immediate value:

1. Code-Block Card Contrast (2.2)
What: A quick CSS polish to increase the contrast and visual distinction of rounded code boxes in the agent chat.
Why: Makes code more readable and differentiates it from the primary prose.
Effort: ~30 mins (CSS only).
2. Skill Engagement Notices (2.5)
What: Render a slim, non-intrusive inline chip naming the skill being engaged when the LLM calls read_skill.
Why: Keeps the audit trail visible without adding the friction of a full tool card.
Effort: ~1h (agent-view.ts tweak).
3. Markdown-Table Migration for Slash Commands
What: Update /models, /history, and /last to render as clean Markdown tables instead of flat ANSI text.
Why: Makes structural info much easier to scan and aligns them with the new /protocol look.
Effort: ~2h (one call-site flip each).
4. Contract-Change Consumer Enumeration (1.6a)
What: A system-prompt clause that "forces" the agent to grep for call-sites whenever it modifies a function signature.
Why: Prevents the "broken call-site" regression bug that we identified as a critical safety risk.
Effort: ~1h (Prompt + minor tool-logic gate).
5. Settings / AI Models Search Bar
What: Add a simple filter input to the AI models settings page.
Why: With 8+ models in the curated lineup, being able to type "flash" or "4o" to filter the list improves navigation.
Effort: ~1.5h (UI plumbing).
Recommendation for tomorrow: We can likely knock out #1, #2, and #3 in a single session to significantly "level up" the chat aesthetics and clarity.