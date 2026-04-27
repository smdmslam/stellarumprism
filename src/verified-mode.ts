// Grounded-Chat protocol — the rigor layer that fires automatically on
// inspectable factual questions (counts, enumerations, repo facts).
//
// This is the v0 of Verified Chat: detect prompts where freeform
// answering is most likely to hallucinate, and inject a one-shot
// protocol header into the user message so the model is forced to
// SOURCE → EVIDENCE → RULE → WORKING → LABEL before answering.
//
// Designed to be transparent: the user types a normal question, the
// frontend echoes it as typed, and the model sees the augmented
// version with the protocol prepended. Existing modes (audit, fix,
// build, etc.) are NOT subject to this layer — they have their own
// stricter protocols and shouldn't be double-wrapped.

/** Categorical kinds of factual questions we recognize. */
export type VerifiedKind = "count" | "enumerate" | "repo-fact";

/** Outcome of trigger detection on a single user prompt. */
export interface VerifiedTrigger {
  kind: VerifiedKind;
  /** The substring of the user's prompt that matched the trigger regex.
   * Surfaced in the xterm hint line so the user sees why the protocol fired. */
  matched: string;
}

// ---------------------------------------------------------------------------
// Trigger regexes
// ---------------------------------------------------------------------------
//
// Order matters in detect(): count > enumerate > repo-fact. A prompt like
// "how many tests are in the repo?" matches both COUNT and ENUM; we want
// the COUNT addendum to win because it carries the strict arithmetic rules.

/** Counting / totalling questions. "How many tests?", "what's the total?". */
const COUNT_REGEX =
  /\b(how many|count\b|how much|number of|total (of|number))\b/i;

/** Enumeration questions. "List all", "which files", "show me". */
const ENUM_REGEX =
  /\b(list (all|the|every)|which (files?|tests?|functions?|classes?|modules?|commands?|hooks?|routes?)|show (me )?(the|all|every)|what (files?|tests?|functions?|classes?|commands?|hooks?|routes?))\b/i;

/** Repo-fact questions. "Where is X?", "what changed?", "did we ever". */
const REPO_FACT_REGEX =
  /\b(where (is|are|did|does)|did we|what changed|recently (added|modified|changed|removed)|latest (commit|change|update|version))\b/i;

/**
 * Inspect a raw user prompt for an inspectable-factual trigger. Returns
 * null when the prompt is opinion-shaped, vague, or otherwise outside
 * the rigor envelope (e.g. "any thoughts on X?", "what would you call
 * this feature?"). Callers should leave such prompts alone.
 */
export function detectVerifiedTrigger(prompt: string): VerifiedTrigger | null {
  const m1 = COUNT_REGEX.exec(prompt);
  if (m1) return { kind: "count", matched: m1[0] };
  const m2 = ENUM_REGEX.exec(prompt);
  if (m2) return { kind: "enumerate", matched: m2[0] };
  const m3 = REPO_FACT_REGEX.exec(prompt);
  if (m3) return { kind: "repo-fact", matched: m3[0] };
  return null;
}

// ---------------------------------------------------------------------------
// Protocol text
// ---------------------------------------------------------------------------
//
// The model receives this prepended to its user message. Kept compact
// because it's paid for in tokens on every triggered turn. Compared to
// the verified-mode improvement on output quality, the extra ~400
// tokens of preamble are a rounding error.

const PROTOCOL_PREAMBLE = `[Grounded-Chat protocol active]

This is a factual question about a repository, codebase, or runtime artifact. Follow this protocol BEFORE answering:

1. SOURCE: Identify the source of truth (file path, tool output, command result). If the answer is inspectable, do NOT answer from memory.
2. EVIDENCE: Use a tool (read_file, grep, list_directory, git_diff, run_shell, etc.) to fetch the evidence. Do not skip this even when you "probably know" the answer.
3. RULE: State the rule that converts evidence to answer (e.g. "I count every line matching ^test_ as one test").
4. WORKING: Show the working — breakdown by section/file, citations with paths and line numbers. Numbers must add up. If you produce a total, prove the breakdown sums to it.
5. EVIDENCE LABELS \u2014 format STRICTLY: emit the label on ITS OWN LINE, then a newline, then the paragraph that it labels. The label is metadata, not part of the prose; it must not interrupt reading flow.

   Required output shape (note the blank line BEFORE each label and the newline AFTER):

   \x1b[2m\u2713 Observed\x1b[0m
   <paragraph text on the next line(s)>

   \x1b[2m~ Inferred\x1b[0m
   <next paragraph text>

   \x1b[2m? Unverified\x1b[0m
   <claim that you have not verified>

   Available labels (use the exact glyph + word):
     \u2713 Observed   \u2014 claim verified from a tool result or file you read THIS turn
     ~ Inferred   \u2014 claim reasoned from observations, not directly stated
     ? Unverified \u2014 plausible but not checked; flag explicitly

   Wrap each label line in ANSI dim-grey codes (\x1b[2m \u2026 \x1b[0m) so it visually recedes from the prose. If your output cannot emit ANSI escapes, the label on its own line in plain text is the acceptable fallback \u2014 the line break alone preserves readability.

   Never use \u2713 Observed for a claim you did not tool-verify this turn. Use ? Unverified if you cannot verify.
6. NO RECONCILIATION-BY-ARITHMETIC: Never reconcile contradictions in your own prior outputs by re-doing arithmetic on those outputs. Re-fetch from source.

`;

const ADDENDUMS: Record<VerifiedKind, string> = {
  count: `This is a COUNT question. Mandatory:
- name the file or scope being counted
- state the counting rule explicitly (what is "one item"?)
- produce a per-section or per-file breakdown
- prove the breakdown sums to the total
- label the final number "Verified total: N" only if you computed it from source THIS turn
- otherwise say "I have not verified this. Estimated count: N" and explain what you'd need to verify

`,
  enumerate: `This is an ENUMERATION question. Mandatory:
- list items by inspecting the source, not from memory
- include the path or identifier for each item so the user can verify
- if the list is large, say so up front and offer a narrowing question

`,
  "repo-fact": `This is a REPO-FACT question. Mandatory:
- run a tool to fetch the answer (grep, read_file, git_diff, list_directory, etc.) before responding
- if no tool can answer it, say "I cannot verify this from the repository" rather than guessing

`,
};

/**
 * Build the Grounded-Chat scaffold to inject for THIS turn ONLY, as a
 * per-call SYSTEM PREFIX (not as a wrapper around the user message).
 *
 * Why this is a system prefix and not a user-message wrapper:
 *
 *   1. Persistence. Wrapping the user message bakes the ~150-line
 *      protocol into session history. Three grounded turns = three
 *      copies of the scaffold in `messages[]`. Long sessions blow
 *      context fast and some models (notably Kimi K2.5) silently
 *      return empty completions when faced with bloated repeating
 *      instructions \u2014 that produced the "agent did nothing" bug class
 *      where two consecutive user turns appear in the saved chat
 *      with no assistant response between them.
 *
 *   2. Saved-chat fidelity. /save persists user messages verbatim.
 *      Wrapping the prompt would mean every saved chat re-plays the
 *      protocol back at the next session as if the user had typed
 *      it, even when grounded mode is no longer wanted.
 *
 *   3. Echo cleanliness. A wrapped prompt forced the frontend to
 *      track a separate `displayPrompt` so the terminal didn't dump
 *      the scaffold back at the user. Sending the bare prompt makes
 *      that dance unnecessary.
 *
 * The returned string is intended to be passed to `agent.query()` as
 * `options.systemPrefix` and threaded down to the Rust `agent_query`
 * Tauri command. The Rust side prepends it to the system-message
 * content for the wire request (only) and never writes it to the
 * persisted session.
 */
export function buildVerifiedSystemPrefix(trigger: VerifiedTrigger): string {
  return PROTOCOL_PREAMBLE + ADDENDUMS[trigger.kind];
}

/**
 * Short label for the kind, used in the xterm hint line that announces
 * verified mode is active for this turn. Keep these terse — they
 * appear once per triggered prompt and shouldn't dominate the chrome.
 */
export function verifiedKindLabel(kind: VerifiedKind): string {
  switch (kind) {
    case "count":
      return "count";
    case "enumerate":
      return "enumerate";
    case "repo-fact":
      return "repo-fact";
  }
}
