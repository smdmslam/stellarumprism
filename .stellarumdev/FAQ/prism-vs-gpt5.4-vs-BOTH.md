## Prism vs gpt-5.4 vs BOTH

Distinguishing rule of thumb

•  If the behavior is creating, writing, persisting, locating files in the repo → that's Prism.
•  If the behavior is proposing what to write, structuring it, maintaining naming consistency, sustaining domain depth → that's gpt-5.4.
•  If the behavior is the bundle ended up coherent and self-referential rather than a stack of unrelated files → that's the combination. Neither alone gets there.


What Prism contributed (the harness)

1. Actual file creation. The write_file tool turned proposals into real repo state. In ChatGPT plain you'd have ~100KB of paste-into-VS-Code text. Here you have 8 actual files committable to git.
2. Approval-gated discipline. Every file went through the approval card. This is exactly what made you say "i let it do what i suggested this time" — the gating made the loop comfortable rather than autonomous.
3. Working-directory awareness. OSC 7 told the model the project root is /Users/stevenmorales/Development/StellarumPrism. So .prism/skills/<filename>.md paths were correct on the first attempt, every time. No path hallucination.
4. Long-session stability. 18 messages, with tool calls and approvals interleaved, and the session never corrupted. That's the atomic-turn-eviction fix from today carrying its weight — without it, you'd likely have hit the 40-message tool/result orphaning bug mid-bundle.
5. The cross-referencing magic. When the model wrote the index file, it could see the prior 7 files in the session. So the index's content references them by exact filename and explains each one. That coherence is a Prism-context-window benefit, not a model benefit. A retrieval-based tool would have given the model fragments and produced a less self-aware index.

What gpt-5.4 contributed (the model)

1. Self-directing planning. After every file, the model proposed the next one with a recommendation. Never just "what's next?" — always "the next companion would be either A or B; I recommend A because..." That habit isn't universal across frontier models. Kimi/glm-5/deepseek tend to wait for your call without suggesting.
2. Pattern persistence. The moment you said "keep the vc-pitchdeck- prefix," it held that across 7 more file creations + an index + a README, with no drift. Every cross-reference inside the files (one skill citing another by path) used the right prefix.
3. Domain compression. 8 files × ~10–17KB each = ~100KB of structured prose, all consistent in voice and depth, none repeating. That's gpt-5.4's distinctive capacity for sustained dense output.
4. Self-categorization. Each summary block typed out the family list and grouped it semantically ("framing / example / workflow / language / patterns / redflags / speaker-notes / index"). The model was holding its own mental model of the artifact it was building.
5. Recognized completion. After ~6 files the model started to gentle the pace — "this is now a genuinely complete bundle" — and only proposed "small cleanup" steps (index, README) rather than padding. Didn't loop on inventing new files.