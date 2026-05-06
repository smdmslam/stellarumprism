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
pub fn get_pricing_map() -> HashMap<&'static str, PricingBasis> {
    let mut map = HashMap::new();

    // Google Gemini 2.5 Pro
    map.insert("google/gemini-2.5-pro", PricingBasis { input_per_m: 1.25, output_per_m: 10.0 });
    // Google Gemini 2.5 Flash-Lite
    map.insert("google/gemini-2.5-flash-lite", PricingBasis { input_per_m: 0.10, output_per_m: 0.40 });
    // Google Gemini 2.5 Flash
    map.insert("google/gemini-2.5-flash", PricingBasis { input_per_m: 0.30, output_per_m: 2.50 });
    // OpenAI GPT-5.4
    map.insert("openai/gpt-5.4", PricingBasis { input_per_m: 2.5, output_per_m: 15.0 });
    // OpenAI GPT-4o Mini
    map.insert("openai/gpt-4o-mini", PricingBasis { input_per_m: 0.15, output_per_m: 0.60 });
    // xAI Grok 4.1 Fast
    map.insert("x-ai/grok-4.1-fast", PricingBasis { input_per_m: 0.2, output_per_m: 0.5 });
    map.insert("x-ai/grok-4-fast", PricingBasis { input_per_m: 0.2, output_per_m: 0.5 });
    // Z.ai GLM 5
    map.insert("z-ai/glm-5", PricingBasis { input_per_m: 0.60, output_per_m: 2.08 });
    // Claude Haiku 4.5
    map.insert("anthropic/claude-haiku-4.5", PricingBasis { input_per_m: 1.0, output_per_m: 5.0 });
    // Claude Sonnet 4.6
    map.insert("anthropic/claude-sonnet-4.6", PricingBasis { input_per_m: 3.0, output_per_m: 15.0 });
    // Baidu Qianfan CoBuddy Free
    map.insert("baidu/cobuddy:free", PricingBasis { input_per_m: 0.0, output_per_m: 0.0 });
    // Qwen3 235B
    map.insert("qwen/qwen3-235b-a22b-2507", PricingBasis { input_per_m: 0.071, output_per_m: 0.10 });
    // Perplexity Sonar
    map.insert("perplexity/sonar", PricingBasis { input_per_m: 1.0, output_per_m: 1.0 });

    map
}

pub fn get_pricing_basis(model: &str) -> PricingBasis {
    let map = get_pricing_map();
    map.get(model).cloned().unwrap_or(PricingBasis { input_per_m: 0.0, output_per_m: 0.0 })
}

#[tauri::command]
pub fn get_all_pricing() -> HashMap<&'static str, PricingBasis> {
    get_pricing_map()
}
