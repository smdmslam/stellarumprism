## featrures ideas and notes

tool bar to show hide windows in the ui and change the layout.

1. settings page: we can put a lot of things in here. such as models hide and show, 
2. 


## notes

the load feature is also displaying our logic regarding llm responses WE SHOULDNT SHJOW THIS

User question: [Grounded-Chat protocol active]

This is a factual question about a repository, codebase, or runtime artifact. Follow this protocol BEFORE answering:

1. SOURCE: Identify the source of truth (file path, tool output, command result). If the answer is inspectable, do NOT answer from memory.
2. EVIDENCE: Use a tool (read_file, grep, list_directory, git_diff, run_shell, etc.) to fetch the evidence. Do not skip this even when you "probably know" the answer.
3. RULE: State the rule that converts evidence to answer (e.g. "I count every line matching ^test_ as one test").
4. WORKING: Show the working — breakdown by section/file, citations with paths and line numbers. Numbers must add up. If you produce a total, prove the breakdown sums to it.
5. EVIDENCE LABELS — format STRICTLY: emit the label on ITS OWN LINE, then a newline, then the paragraph that it labels. The label is metadata, not part of the prose; it must not interrupt reading flow.

   Required output shape (note the blank line BEFORE each label and the newline AFTER):

   ✓ Observed
   <paragraph text on the next line(s)>

   ~ Inferred
   <next paragraph text>

   ? Unverified
   <claim that you have not verified>

   Available labels (use the exact glyph + word):
     ✓ Observed   — claim verified from a tool result or file you read THIS turn
     ~ Inferred   — claim reasoned from observations, not directly stated
     ? Unverified — plausible but not checked; flag explicitly

   Wrap each label line in ANSI dim-grey codes ( … ) so it visually recedes from the prose. If your output cannot emit ANSI escapes, the label on its own line in plain text is the acceptable fallback — the line break alone preserves readability.

   Never use ✓ Observed for a claim you did not tool-verify this turn. Use ? Unverified if you cannot verify.
6. NO RECONCILIATION-BY-ARITHMETIC: Never reconcile contradictions in your own prior outputs by re-doing arithmetic on those outputs. Re-fetch from source.

This is a COUNT question. Mandatory:
- name the file or scope being counted
- state the counting rule explicitly (what is "one item"?)
- produce a per-section or per-file breakdown
- prove the breakdown sums to the total
- label the final number "Verified total: N" only if you computed it from source THIS turn
- otherwise say "I have not verified this. Estimated count: N" and explain what you'd need to verify

----

can we add list of tasks?

can we add accordians?

can we clean up the xterm more?

---

dont cutoff words in exterm, only show complete words. 

--- 

the llm should never save a file without permission. atm im seeing gpt save files to src, to stevenmorales. all files need to be ok when saved...