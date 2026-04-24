// Rule-based model router.
//
// When the user sets `/model auto`, every agent query runs through this
// function first to pick the most appropriate model for the task, based on
// lightweight signals in the prompt. Zero extra LLM calls — deterministic
// string matching that runs in < 1ms.
//
// Order matters: rules higher up take precedence. The first match wins.

export type RouteCategory =
  | "vision"
  | "web"
  | "code-gen"
  | "code-review"
  | "default";

export interface RouteDecision {
  slug: string;
  reason: string;
  category: RouteCategory;
}

export interface RouteSignals {
  hasImages: boolean;
  hasAtRefs: boolean;
}

// Three curated auto presets. Each fills the same five routing slots
// (vision / web / code-gen / code-review / default). The router picks a
// slot per prompt and returns the slug from the chosen preset's table.
// Default preset is "agentic" — it matches how PRISM actually works
// (iterative tool calls, editing files, long-horizon tasks).

export type RoutePreset = "frontier" | "agentic" | "thrifty";

interface PresetTable {
  vision: string;
  web: string;
  codeGen: string;
  codeReview: string;
  default: string;
}

export const PRESETS: Record<RoutePreset, PresetTable> = {
  // Auto 1 — Frontier. Quality > cost. Best models across the board.
  frontier: {
    vision: "openai/gpt-5.4",
    web: "perplexity/sonar",
    codeGen: "openai/gpt-5.4",
    codeReview: "x-ai/grok-4-fast", // 2M ctx — great for whole-repo reads
    default: "openai/gpt-5.4",
  },
  // Auto 2 — Agentic. Tool-use specialists, open-leaning. DEFAULT preset.
  agentic: {
    vision: "moonshotai/kimi-k2.5",
    web: "perplexity/sonar",
    codeGen: "qwen/qwen3.6-plus",
    codeReview: "z-ai/glm-5",
    default: "moonshotai/kimi-k2.5",
  },
  // Auto 3 — Thrifty. Cheap + fast, still thoughtful (no Flash).
  thrifty: {
    vision: "moonshotai/kimi-k2.5",
    web: "perplexity/sonar",
    codeGen: "deepseek/deepseek-v3.2",
    codeReview: "stepfun/step-3.5-flash",
    default: "openai/gpt-oss-120b:exacto",
  },
};

export const DEFAULT_PRESET: RoutePreset = "agentic";

/**
 * If `model` is an auto-* slug (including the bare "auto" alias), return
 * the preset it maps to. Returns null for non-auto slugs. `"auto"` is kept
 * as an alias for `"auto-agentic"` so configs written before multi-preset
 * support existed keep working.
 */
export function parseAutoSlug(model: string): RoutePreset | null {
  switch (model) {
    case "auto":
    case "auto-agentic":
      return "agentic";
    case "auto-frontier":
      return "frontier";
    case "auto-thrifty":
      return "thrifty";
    default:
      return null;
  }
}

const WEB_SIGNALS =
  /\b(latest|newest|current|today|this (week|month|year)|recent(ly)?|news|updated?|docs? for|changelog|release[d]?|202[4-9]|what's new|whats new)\b/i;

// Pure code GENERATION verbs — the user wants the model to produce NEW
// code from scratch rather than understand and modify an existing
// codebase. These route to Devstral (cheap code-specialist). Existing-
// code modifications (change/update/edit/refactor) go to Haiku instead,
// because they require exploration and careful reasoning — Devstral
// tends to loop on list_directory without actually reading files.
const CODE_GEN_SIGNALS =
  /\b(generate|scaffold|stub out|port (this )?to|convert (this )?to|translate (this )?to|write (me )?(a |some )?(function|class|component|test|script|module) (from scratch|that|to)|create (a |the )?(function|class|component|test|script|module))\b/i;

// Everything about UNDERSTANDING or MODIFYING existing code goes to the
// code-review slot. Explicit edit intents (change/update/edit/refactor/
// write/save/apply) are strong enough on their own — no CODE_CONTEXT
// noun required.
const CODE_REVIEW_SIGNALS =
  /\b(explain|review|critique|why does|how does|what does|trace|walk (me )?through|analyze|debug|fix (this|the) bug|find (the )?bug|diagnose|compare|architecture|design|audit|refactor|rewrite|implement|change\s+\S+\s+to|update (the )?(text|string|copy|wording|value|label|title|code|file)|replace\s+\S+\s+with|modify|edit (the )?(file|line|function|component|code|text|string|copy|wording)|rename|swap|fix|apply (the )?(edit|change|fix|patch|diff)|save (the )?(file|changes|edit)|write (the )?(file|change|edit|update)\b|commit (the )?(change|edit|fix))\b/i;

// Broad set of terms that imply the user is talking about code / a UI /
// a project, even without an explicit verb. Includes common web/UI nouns
// ("landing page", "button", "header") because those are almost always
// about code that needs editing.
const CODE_CONTEXT =
  /\b(code|file|function|class|module|component|package|project|repo|repository|app|script|type|interface|page|pages|site|website|webapp|landing|ui|button|header|footer|nav|navbar|menu|form|heading|title|label|copy|text|string|route|endpoint|api|schema|config|test|spec|bug|error|exception|stack trace|traceback|styling|style|css|html)\b/i;

export function route(
  prompt: string,
  signals: RouteSignals,
  preset: RoutePreset = DEFAULT_PRESET,
): RouteDecision {
  const table = PRESETS[preset];
  const text = prompt.trim();

  if (signals.hasImages) {
    return { slug: table.vision, reason: "vision input", category: "vision" };
  }
  if (WEB_SIGNALS.test(text)) {
    return { slug: table.web, reason: "web lookup", category: "web" };
  }
  if (CODE_GEN_SIGNALS.test(text)) {
    return {
      slug: table.codeGen,
      reason: "code generation",
      category: "code-gen",
    };
  }
  // Edit / review verbs alone are strong enough signal — "change X to Y"
  // or "refactor" is plenty reason to route to the review slot regardless
  // of whether the prompt also mentions a technical noun.
  if (CODE_REVIEW_SIGNALS.test(text)) {
    return {
      slug: table.codeReview,
      reason: "code reasoning",
      category: "code-review",
    };
  }
  // Fallback: no explicit verb but a code/UI-context noun. Also goes to
  // the review slot since defaults tend to ask "which file?" and stall.
  if (signals.hasAtRefs || CODE_CONTEXT.test(text)) {
    return {
      slug: table.codeReview,
      reason: "code context",
      category: "code-review",
    };
  }
  return { slug: table.default, reason: "default", category: "default" };
}
