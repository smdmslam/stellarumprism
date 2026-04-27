// Curated list of models the user wants one-keystroke access to.
//
// Two purposes:
//   1. The `/model <alias>` slash command resolves a short name to a full
//      OpenRouter slug (e.g. "sonar" -> "perplexity/sonar").
//   2. The `/models` slash command prints the list so the user can discover
//      what's available without leaving the terminal.
//
// You can freely add/remove entries here. Ordering is preserved in the UI.

import { settings } from "./settings";

export interface ModelEntry {
  /** Short alias(es). The first is the "canonical" short name. */
  aliases: string[];
  /** Full OpenRouter slug to send as the model id. */
  slug: string;
  /** One-line description shown by `/models`. */
  description: string;
  /**
   * Mark as "main" (featured, name-brand), "explore" (less-common
   * alternates), or "backend" (internal tool provider, not shown in
   * /models and not user-selectable as a primary model).
   *
   * Auto presets are intentionally NOT offered as a tier here \u2014 the
   * picker now exposes a single concrete model per turn so beta
   * testers can triangulate behavior without mid-conversation model
   * swaps. Routing logic still exists in router.ts in case a config
   * file still carries an `auto-*` slug; it just isn't surfaced in
   * the UI. */
  tier: "main" | "explore" | "backend";
  /** Does this model accept image inputs (multimodal)? */
  vision?: boolean;
  /** Rough cost tier: 1 = cheap, 2 = mid, 3 = premium. */
  cost?: 1 | 2 | 3;

  // -- capability flags for the capability-gated router -------------------
  //
  // Defaults intentionally generous (true) so only known-bad combos need to
  // opt out. Router uses these as HARD gates: if a turn requires tool use
  // and toolUse=false, that model is ineligible regardless of any keyword
  // heuristics.

  /** Does this model support OpenAI-style tool/function calling? */
  toolUse?: boolean;
  /** Does this model perform its own web search? (Sonar-style.) */
  webSearch?: boolean;
  /** Does this model reliably honor JSON/structured output? */
  jsonMode?: boolean;
  /** Max context window in tokens (ballpark; used as a soft lower bound). */
  maxContext?: number;
}

export const MODEL_LIBRARY: ModelEntry[] = [
  // -------- Main rotation -----------------------------------------------
  //
  // Name-brand models only. Lesser-known providers (StepFun, Mistral's
  // Devstral, etc.) live in the Explore tier below so the default
  // picker stays trustworthy and recognizable.
  //
  // NOTE: Gemini 2.5 Flash has been pulled from the library while we
  // focus on more thoughtful models. Kept commented-out for easy revert.
  // {
  //   aliases: ["flash", "gemini", "gemini-flash"],
  //   slug: "google/gemini-2.5-flash",
  //   description: "Google Gemini 2.5 Flash \u2014 fast, reliable chat + vision",
  //   tier: "main",
  //   vision: true,
  //   cost: 2,
  // },
  {
    aliases: ["gpt-5.4", "gpt5.4", "gpt-5"],
    slug: "openai/gpt-5.4",
    description:
      "OpenAI GPT-5.4 \u2014 frontier, 1M context, text+image, unified codex+gpt",
    tier: "main",
    vision: true,
    cost: 3,
    toolUse: true,
    jsonMode: true,
    maxContext: 1000000,
  },
  {
    aliases: ["grok-4-fast", "grok4"],
    slug: "x-ai/grok-4-fast",
    description:
      "xAI Grok 4 Fast \u2014 2M context, excels at whole-repo reading",
    tier: "main",
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 2000000,
  },
  {
    aliases: ["kimi", "kimi-k2.5", "kimi-k25"],
    slug: "moonshotai/kimi-k2.5",
    description:
      "MoonshotAI Kimi K2.5 \u2014 multimodal, agent-swarm, visual coding specialist",
    tier: "main",
    vision: true,
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["qwen3.6", "qwen3.6-plus", "qwen-plus"],
    slug: "qwen/qwen3.6-plus",
    description:
      "Qwen 3.6 Plus \u2014 78.8 SWE-bench Verified, hybrid MoE, strong code",
    tier: "main",
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["glm-5", "glm"],
    slug: "z-ai/glm-5",
    description:
      "Z.ai GLM 5 \u2014 long-horizon coding, iterative self-correction",
    tier: "main",
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["deepseek", "deepseek-v3.2", "dsv3"],
    slug: "deepseek/deepseek-v3.2",
    description: "DeepSeek V3.2 \u2014 modern, cheap, solid at code",
    tier: "main",
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["haiku", "claude-haiku"],
    slug: "anthropic/claude-haiku-4.5",
    description: "Claude Haiku 4.5 \u2014 careful reasoning, great tool-use",
    tier: "main",
    vision: true,
    cost: 3,
    toolUse: true,
    jsonMode: true,
    maxContext: 200000,
  },
  {
    // Sonar is the backend for the `web_search` tool (see
    // src-tauri/src/tools.rs). It's not a model users pick directly — the
    // primary tool-capable model decides when to search. Marked as
    // "backend" tier so it's filtered out of /models and the auto
    // presets. toolUse: false keeps the hard gate honest in case anyone
    // ever tries to set it as primary by full slug.
    aliases: ["sonar", "perplexity"],
    slug: "perplexity/sonar",
    description:
      "Perplexity Sonar \u2014 internal backend for the web_search tool (not user-selectable as a primary model).",
    tier: "backend",
    cost: 3,
    toolUse: false,
    webSearch: true,
    jsonMode: false,
    maxContext: 128000,
  },
  {
    aliases: ["qwen", "qwen3"],
    slug: "qwen/qwen3-next-80b-a3b-instruct",
    description: "Qwen3 Next 80B A3B \u2014 strong open-weights instruct",
    tier: "main",
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["gpt-oss", "oss"],
    slug: "openai/gpt-oss-120b:exacto",
    description:
      "GPT OSS 120B Exacto \u2014 cheap fast reasoning, OpenAI open-weights",
    tier: "main",
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },

  // -------- Explore (less-common alternates) ----------------------------
  {
    aliases: ["step", "step-flash", "step-3.5-flash"],
    slug: "stepfun/step-3.5-flash",
    description:
      "StepFun Step 3.5 Flash \u2014 reasoning MoE, cheap, #2 in programming",
    tier: "explore",
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["devstral"],
    slug: "mistralai/devstral-small",
    description:
      "Devstral Small \u2014 Mistral's agentic code model, cheap + proactive",
    tier: "explore",
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["codestral", "mistral"],
    slug: "mistralai/codestral-2508",
    description: "Codestral 2508 \u2014 Mistral's code-focused model",
    tier: "explore",
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 256000,
  },
  {
    // Diffusion-based LLM — doesn't support OpenAI tool-calling protocol.
    aliases: ["mercury", "inception"],
    slug: "inception/mercury-2",
    description: "Inception Mercury 2 \u2014 diffusion LLM, extremely fast",
    tier: "explore",
    cost: 2,
    toolUse: false,
    jsonMode: false,
    maxContext: 32000,
  },
  {
    aliases: ["gpt5-mini", "gpt-5-mini"],
    slug: "openai/gpt-5-mini",
    description: "OpenAI GPT-5 Mini \u2014 cheap frontier model",
    tier: "explore",
    vision: true,
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 400000,
  },
  {
    aliases: ["qwen-235b", "qwen235"],
    slug: "qwen/qwen3-235b-a22b-2507",
    description:
      "Qwen3 235B A22B \u2014 big open-weights reasoning, very cheap",
    tier: "explore",
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["scout", "llama-scout"],
    slug: "meta-llama/llama-4-scout",
    description:
      "Llama 4 Scout \u2014 Meta multimodal, alt vision model, cheap",
    tier: "explore",
    vision: true,
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["grok-fast", "grok"],
    slug: "x-ai/grok-4.1-fast",
    description: "Grok 4.1 Fast \u2014 xAI general-purpose alt",
    tier: "explore",
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["minimax"],
    slug: "minimax/minimax-m2.5",
    description: "MiniMax M2.5 \u2014 code-focused alternative to Codestral",
    tier: "explore",
    cost: 3,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
];

/** Look up a model entry by its full OpenRouter slug. Returns null for unknowns. */
export function getModelEntry(slug: string): ModelEntry | null {
  return MODEL_LIBRARY.find((m) => m.slug === slug) ?? null;
}

/** True if the given model slug supports images. Defaults to false for unknown. */
export function modelSupportsVision(slug: string): boolean {
  return Boolean(getModelEntry(slug)?.vision);
}

/**
 * True if the model supports OpenAI-style tool/function calling. Defaults to
 * true for unknown slugs so user-supplied custom slugs ("provider/model")
 * don't get silently refused — the hard gate only kicks in for models we
 * explicitly know DO NOT support tools.
 */
export function modelSupportsToolUse(slug: string): boolean {
  const entry = getModelEntry(slug);
  if (!entry) return true;
  return entry.toolUse !== false;
}

/** Resolve an alias or full slug to a concrete model slug (case-insensitive).
 *
 *  Auto presets are no longer surfaced in the picker, but the virtual
 *  slugs `auto-agentic` / `auto-frontier` / `auto-thrifty` are still
 *  honored downstream via `parseAutoSlug` in router.ts so any saved
 *  config carrying one of those values keeps working. */
export function resolveModel(input: string): string | null {
  const q = input.trim().toLowerCase();
  if (q.length === 0) return null;

  // Full slug wins (must contain a slash).
  if (q.includes("/")) return q;

  for (const m of MODEL_LIBRARY) {
    if (m.aliases.includes(q)) return m.slug;
    // Also match the last path segment of the slug (e.g. "codestral-2508").
    const tail = m.slug.split("/").pop()?.toLowerCase();
    if (tail === q) return m.slug;
  }
  return null;
}

/** Human-readable list for the `/models` command (renders inside xterm). */
export function renderModelListAnsi(current: string): string {
  // `tier === "backend"` entries are intentionally excluded — they back
  // internal tools (e.g. web_search → Sonar) and aren't user-selectable.
  // Auto presets are also no longer listed; pick a concrete model.
  const sections: { title: string; entries: ModelEntry[] }[] = [
    {
      title: "Main",
      entries: MODEL_LIBRARY.filter(
        (m) => m.tier === "main" && settings.isModelEnabled(m.slug),
      ),
    },
    {
      title: "Explore",
      entries: MODEL_LIBRARY.filter(
        (m) => m.tier === "explore" && settings.isModelEnabled(m.slug),
      ),
    },
  ];
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const CYAN = "\x1b[36m";
  const GREEN = "\x1b[32m";
  const MAGENTA = "\x1b[35m";
  const YELLOW = "\x1b[33m";

  const costGlyph = (c?: 1 | 2 | 3): string => {
    if (c === 1) return `${GREEN}$${RESET}`;
    if (c === 2) return `${YELLOW}$$${RESET}`;
    if (c === 3) return `\x1b[31m$$$${RESET}`;
    return "";
  };

  const out: string[] = [];
  out.push(
    `${BOLD}Available models${RESET} ${DIM}(use: /model <alias|slug>) \u2014 ${MAGENTA}[img]${RESET}${DIM} = vision, $=cheap $$=mid $$$=premium${RESET}`,
  );
  for (const s of sections) {
    out.push("");
    out.push(`${BOLD}${s.title}${RESET}`);
    for (const m of s.entries) {
      const isActive = m.slug === current;
      const marker = isActive ? `${GREEN}\u25cf${RESET}` : " ";
      const alias = `${CYAN}${m.aliases[0]}${RESET}`;
      const slug = `${DIM}${m.slug}${RESET}`;
      const visionTag = m.vision ? ` ${MAGENTA}[img]${RESET}` : "";
      const cost = costGlyph(m.cost);
      const costPart = cost ? ` ${cost}` : "";
      out.push(`  ${marker} ${alias.padEnd(24)} ${slug}${visionTag}${costPart}`);
      out.push(`      ${DIM}${m.description}${RESET}`);
    }
  }
  return out.join("\r\n") + "\r\n";
}
