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
import { invoke } from "@tauri-apps/api/core";

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
  /**
   * Default visibility for this model in user-facing pickers.
   * `undefined` (the common case) and `true` are treated identically:
   * the model ships visible. Set to `false` for models we've
   * tested and decided ship subpar by default \u2014 the user can
   * still re-enable via Settings \u2192 Models, and the registry default
   * is the single source of truth for what gets surfaced on first run
   * (no user-curation state required).
   *
   * `settings.isModelEnabled(slug, registryDefault)` consults this
   * field plus any stored user override; the override always wins.
   */
  enabled?: boolean;

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

export interface PricingBasis {
  input_per_m: number;
  output_per_m: number;
}

// Shared pricing basis used by cost analytics and UI sorting surfaces.
// Populated dynamically from the Rust backend via initPricing().
export let MODEL_PRICING_USD_PER_M: Record<string, PricingBasis> = {};

/** Fetch authoritative pricing from the Rust backend. */
export async function initPricing(): Promise<void> {
  try {
    const pricing = await invoke<Record<string, PricingBasis>>("get_all_pricing");
    MODEL_PRICING_USD_PER_M = pricing;
    console.log("[models] Pricing basis initialized from backend.");
  } catch (err) {
    console.error("[models] Failed to fetch pricing from backend:", err);
  }
}

export function getModelPricingBasis(slug: string): PricingBasis {
  return MODEL_PRICING_USD_PER_M[slug] ?? { input_per_m: 0, output_per_m: 0 };
}

/** Sort highest-cost first using exact pricing basis. */
export function compareModelsByCostDesc(a: ModelEntry, b: ModelEntry): number {
  const aPricing = getModelPricingBasis(a.slug);
  const bPricing = getModelPricingBasis(b.slug);
  const aTotal = aPricing.input_per_m + aPricing.output_per_m;
  const bTotal = bPricing.input_per_m + bPricing.output_per_m;
  const totalDelta = bTotal - aTotal;
  if (totalDelta !== 0) return totalDelta;
  const outputDelta = bPricing.output_per_m - aPricing.output_per_m;
  if (outputDelta !== 0) return outputDelta;
  const inputDelta = bPricing.input_per_m - aPricing.input_per_m;
  if (inputDelta !== 0) return inputDelta;
  return a.aliases[0].localeCompare(b.aliases[0]);
}

/** Sort lowest-cost first using exact pricing basis. */
export function compareModelsByCostAsc(a: ModelEntry, b: ModelEntry): number {
  const aPricing = getModelPricingBasis(a.slug);
  const bPricing = getModelPricingBasis(b.slug);
  const aTotal = aPricing.input_per_m + aPricing.output_per_m;
  const bTotal = bPricing.input_per_m + bPricing.output_per_m;
  const totalDelta = aTotal - bTotal;
  if (totalDelta !== 0) return totalDelta;
  const outputDelta = aPricing.output_per_m - bPricing.output_per_m;
  if (outputDelta !== 0) return outputDelta;
  const inputDelta = aPricing.input_per_m - bPricing.input_per_m;
  if (inputDelta !== 0) return inputDelta;
  return a.aliases[0].localeCompare(b.aliases[0]);
}

export const MODEL_LIBRARY: ModelEntry[] = [
  // -------- Main rotation -----------------------------------------------
  //
  // Curated lineup after the calibration sweep documented in
  // `MASTER-Plan-II.md#5.9`. Every entry below has been validated as
  // low-hallucination under Prism's tool loop. Adding a model here is
  // a deliberate endorsement — if calibration later finds it failing,
  // remove it entirely (the audit trail lives in `docs/MASTER-AI-model-list.md`,
  // not as commented-out or `enabled: false` rot in this file).
  //

  {
    aliases: ["gpt-5.4", "gpt5.4", "gpt-5"],
    slug: "openai/gpt-5.4",
    description:
      "OpenAI GPT-5.4 — frontier, 1M context, text+image, unified codex+gpt",
    tier: "main",
    vision: true,
    cost: 3,
    toolUse: true,
    jsonMode: true,
    maxContext: 1050000,
  },
  {
    aliases: ["grok-4.1-fast", "grok-4-fast", "grok4"],
    slug: "x-ai/grok-4.1-fast",
    description:
      "xAI Grok 4.1 Fast \u2014 2M context, excels at whole-repo reading",
    tier: "main",
    cost: 2,
    toolUse: true,
    jsonMode: true,
    maxContext: 2000000,
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
    aliases: ["haiku", "claude-haiku"],
    slug: "anthropic/claude-haiku-4.5",
    description: "Claude Haiku 4.5 — careful reasoning, great tool-use",
    tier: "main",
    vision: true,
    cost: 3,
    toolUse: true,
    jsonMode: true,
    maxContext: 200000,
  },
  {
    aliases: ["gpt-4o-mini", "gpt4o-mini", "mini"],
    slug: "openai/gpt-4o-mini",
    description: "OpenAI GPT-4o Mini — ultra-fast, cheap, multimodal small frontier model",
    tier: "main",
    vision: true,
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 128000,
  },
  {
    aliases: ["gemini-2.5-flash-lite", "gemini-lite", "flash-lite"],
    slug: "google/gemini-2.5-flash-lite",
    description: "Google Gemini 2.5 Flash Lite — low-cost workhorse, 1M context, native multimodal",
    tier: "main",
    vision: true,
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 1048576,
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

  // -------- Additional main models --------------------------------------
  {
    aliases: ["qwen-235b", "qwen235"],
    slug: "qwen/qwen3-235b-a22b-2507",
    description:
      "Qwen3 235B A22B \u2014 big open-weights reasoning, very cheap",
    tier: "main",
    cost: 1,
    toolUse: true,
    jsonMode: true,
    maxContext: 262144,
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
 *  Auto presets have been removed entirely. Saved configs carrying
 *  legacy `auto-*` values are migrated to a concrete default by the
 *  Rust-side `load_or_init` on app start. */
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
  const entries = MODEL_LIBRARY.filter(
    (m) =>
      m.tier === "main" &&
      settings.isModelEnabled(m.slug, m.enabled !== false),
  ).sort(compareModelsByCostDesc);

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
  out.push("");
  out.push(`${BOLD}Main${RESET}`);
  for (const m of entries) {
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
  return out.join("\r\n") + "\r\n";
}
