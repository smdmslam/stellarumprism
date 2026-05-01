use std::collections::HashMap;
use serde::{Serialize, Deserialize};
 
 #[derive(Debug, Clone, Serialize, Deserialize)]
 pub struct PricingBasis {
     pub input_per_m: f64,
     pub output_per_m: f64,
 }

/// Hardcoded pricing for v0 instrumentation.
/// 
/// These are used to calculate the estimated cost of each turn.
/// Prices are in USD per 1 million tokens.
pub fn get_pricing_basis(model: &str) -> PricingBasis {
    let mut map = HashMap::new();

    // Google Gemini 2.5 Pro
    map.insert("google/gemini-2.5-pro", PricingBasis { input_per_m: 1.25, output_per_m: 3.75 });
    // Google Gemini Flash (latest) — same price tier as 2.5 Flash on OpenRouter.
    map.insert("google/gemini-flash-latest", PricingBasis { input_per_m: 0.30, output_per_m: 2.50 });
    // Google Gemini 2.5 Flash — $0.30 / $2.50 per OpenRouter (1M ctx, vision, thinking).
    map.insert("google/gemini-2.5-flash", PricingBasis { input_per_m: 0.30, output_per_m: 2.50 });
    // OpenAI GPT-5.4 (frontier placeholder)
    map.insert("openai/gpt-5.4", PricingBasis { input_per_m: 2.5, output_per_m: 10.0 });
    // xAI Grok 4.1 Fast (legacy 4-fast slug kept for compatibility).
    map.insert("x-ai/grok-4.1-fast", PricingBasis { input_per_m: 0.2, output_per_m: 0.5 });
    map.insert("x-ai/grok-4-fast", PricingBasis { input_per_m: 0.2, output_per_m: 0.5 });
    // Z.ai GLM 5
    map.insert("z-ai/glm-5", PricingBasis { input_per_m: 0.1, output_per_m: 0.3 });
    // Claude Haiku 4.5 — $1 / $5 per Anthropic / OpenRouter.
    map.insert("anthropic/claude-haiku-4.5", PricingBasis { input_per_m: 1.0, output_per_m: 5.0 });
    // Qwen3 235B A22B Instruct 2507.
    map.insert("qwen/qwen3-235b-a22b-2507", PricingBasis { input_per_m: 0.071, output_per_m: 0.10 });
    // Perplexity Sonar
    map.insert("perplexity/sonar", PricingBasis { input_per_m: 1.0, output_per_m: 1.0 });

    map.get(model).cloned().unwrap_or(PricingBasis { input_per_m: 0.0, output_per_m: 0.0 })
}
