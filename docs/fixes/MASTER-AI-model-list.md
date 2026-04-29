# MASTER AI Model List
Date: 2026-04-29
Project: StellarumPrism

Purpose: capture the current model roster plus a practical recommendation for
which models to prioritize testing in Prism's agent window.

---

## Core question

The goal is not to test every available model. The goal is to identify the
small handful most worth evaluating for Prism's actual workload:
- tool-using agent behavior
- repo reading
- multi-step planning
- grounded fixes and audits
- stable behavior in the agent window

This list intentionally ignores the app's current `main` vs `explore`
groupings when making recommendations. The point is to choose the best testing
candidates for the product, not to preserve prior categorization.

---

## Current offered models

Source of truth: `src/models.ts`

### Primary candidates currently offered
- `openai/gpt-5.4`
- `x-ai/grok-4-fast`
- `moonshotai/kimi-k2.5`
- `qwen/qwen3.6-plus`
- `z-ai/glm-5`
- `deepseek/deepseek-v3.2`
- `anthropic/claude-haiku-4.5`
- `qwen/qwen3-next-80b-a3b-instruct`
- `openai/gpt-oss-120b:exacto`
- `stepfun/step-3.5-flash`
- `mistralai/devstral-small`
- `mistralai/codestral-2508`
- `inception/mercury-2`
- `openai/gpt-5-mini`
- `qwen/qwen3-235b-a22b-2507`
- `meta-llama/llama-4-scout`
- `x-ai/grok-4.1-fast`
- `minimax/minimax-m2.5`

### Internal backend model
- `perplexity/sonar`
  - backend for `web_search`
  - not a primary user-selectable model

---

## Recommended shortlist to focus testing on

If the goal is to waste less time and quickly find the best candidates for
Prism's agent window, these are the main models to focus on first.

### Tier 1: highest-value models to test first

#### 1. `openai/gpt-5.4`
Why:
- current quality bar / baseline
- strongest all-around reference point for planning, synthesis, and coding
- likely best benchmark for “what good looks like” in Prism

Primary role:
- gold-standard baseline

#### 2. `anthropic/claude-haiku-4.5`
Why:
- likely strong at careful, methodical, tool-using agent behavior
- already trusted in current docs/config for fix/build/refactor defaults
- may be better than more glamorous models at day-to-day agent discipline

Primary role:
- dependable daily-driver candidate

#### 3. `x-ai/grok-4-fast`
Why:
- very large context window
- strong candidate for whole-repo reading and audit-style work
- already aligned with Prism's long-context review use cases

Primary role:
- audit / repo-scale review candidate

#### 4. `qwen/qwen3.6-plus`
Why:
- strong coding/agentic contender among non-OpenAI options
- likely one of the highest-value alternatives to frontier premium models
- good candidate for quality-vs-cost comparison

Primary role:
- best alt/frontier challenger candidate

#### 5. `deepseek/deepseek-v3.2`
Why:
- especially important from a cost/performance standpoint
- if quality is close enough in Prism, it changes the economics materially
- worth testing early because cheap-and-good matters more than niche novelty

Primary role:
- best cost/performance candidate

---

## Secondary models worth testing after the main shortlist

### 6. `z-ai/glm-5`
Why:
- specifically claims long-horizon coding and iterative self-correction
- good fit for Prism's multi-step task style
- worth serious testing, but after the top five

### 7. `moonshotai/kimi-k2.5`
Why:
- multimodal and agentic positioning
- worth trying for visual and planning-heavy tasks
- less urgent than the top five for core terminal-agent evaluation

---

## Models to deprioritize for now

These may still be useful later, but they are not the best early testing
spend if the goal is to quickly find the strongest Prism agent candidates.

- `openai/gpt-oss-120b:exacto`
- `qwen/qwen3-next-80b-a3b-instruct`
- `stepfun/step-3.5-flash`
- `mistralai/devstral-small`
- `mistralai/codestral-2508`
- `openai/gpt-5-mini`
- `qwen/qwen3-235b-a22b-2507`
- `meta-llama/llama-4-scout`
- `x-ai/grok-4.1-fast`
- `minimax/minimax-m2.5`

### Special note: `inception/mercury-2`
Deprioritize strongly for Prism's main use case because:
- model registry marks it as not supporting tool use
- JSON reliability is also not enabled
- that makes it a weak fit for Prism's core agent/tool workflow

---

## Minimal practical testing set

If only four models are tested first:
- `openai/gpt-5.4`
- `anthropic/claude-haiku-4.5`
- `x-ai/grok-4-fast`
- `qwen/qwen3.6-plus`

If five are tested first, add:
- `deepseek/deepseek-v3.2`

This is the highest-value shortlist.

---

## Working prediction before testing

Best current contenders for Prism specifically:
1. `openai/gpt-5.4`
2. `anthropic/claude-haiku-4.5`
3. `x-ai/grok-4-fast`
4. `qwen/qwen3.6-plus`
5. `deepseek/deepseek-v3.2`

Additional strong follow-ups:
6. `z-ai/glm-5`
7. `moonshotai/kimi-k2.5`

---

## What to optimize for in Prism testing

The important evaluation criteria are not just benchmark prestige.

For Prism, the best model is the one that most reliably:
- uses tools at the right times
- reads enough files before proposing fixes
- avoids fake certainty
- maintains plan coherence across multiple turns
- respects Prism's workflow instead of behaving like a generic chatbot
- produces grounded edits and reports rather than confident guesswork

---

## Suggested next step

Turn this file into a live testing sheet later if useful, with:
- the exact models to compare
- the exact prompts/tasks to run on each one
- a simple scorecard for tool discipline, correctness, clarity, and cost


----

more models to consider adding

Favicon for openai
OpenAI: o4 Mini

2.64B tokens
OpenAI o4-mini is a compact reasoning model in the o-series, optimized for fast, cost-efficient performance while retaining strong multimodal and agentic capabilities. It supports tool use and demonstrates competitive reasoning and coding performance across benchmarks like AIME (99.5% with Python) and SWE-bench, outperforming its predecessor o3-mini and even approaching o3 in some domains.  Despite its smaller size, o4-mini exhibits high accuracy in STEM tasks, visual problem solving (e.g., MathVista, MMMU), and code editing. It is especially well-suited for high-throughput scenarios where latency or cost is critical. Thanks to its efficient architecture and refined reinforcement learning training, o4-mini can chain tools, generate structured outputs, and solve multi-step tasks with minimal delay—often in under a minute.

by openai
Apr 16, 2025
200K context
$1.10/M input tokens
$4.40/M output tokens


OpenAI: GPT-5.4 Mini

192B tokens

Academia (#12)

Finance (#34)

Health (#19)

Legal (#14)

Marketing (#26)

+5 categories
GPT-5.4 mini brings the core capabilities of GPT-5.4 to a faster, more efficient model optimized for high-throughput workloads. It supports text and image inputs with strong performance across reasoning, coding, and tool use, while reducing latency and cost for large-scale deployments.  The model is designed for production environments that require a balance of capability and efficiency, making it well suited for chat applications, coding assistants, and agent workflows that operate at scale. GPT-5.4 mini delivers reliable instruction following, solid multi-step reasoning, and consistent performance across diverse tasks with improved cost efficiency.

by openai
Mar 17, 2026
400K context
$0.75/M input tokens
$4.50/M output tokens

Favicon for openai
OpenAI: GPT-5 Mini

196B tokens

Academia (#9)

Finance (#13)

Health (#5)

Legal (#22)

Marketing (#14)

+6 categories
GPT-5 Mini is a compact version of GPT-5, designed to handle lighter-weight reasoning tasks. It provides the same instruction-following and safety-tuning benefits as GPT-5, but with reduced latency and cost. GPT-5 Mini is the successor to OpenAI's o4-mini model.

by openai
Aug 7, 2025
400K context
$0.25/M input tokens
$2/M output tokens


OpenAI: GPT-5.4 Nano

212B tokens

Academia (#32)

Finance (#39)

Legal (#38)

Marketing (#10)

SEO (#40)

+4 categories
GPT-5.4 nano is the most lightweight and cost-efficient variant of the GPT-5.4 family, optimized for speed-critical and high-volume tasks. It supports text and image inputs and is designed for low-latency use cases such as classification, data extraction, ranking, and sub-agent execution.  The model prioritizes responsiveness and efficiency over deep reasoning, making it ideal for pipelines that require fast, reliable outputs at scale. GPT-5.4 nano is well suited for background tasks, real-time systems, and distributed agent architectures where minimizing cost and latency is essential.

by openai
Mar 17, 2026
400K context
$0.20/M input tokens
$1.25/M output tokens

OpenAI: GPT-4.1 Nano

32.4B tokens

SEO (#49)

Science (#37)
For tasks that demand low latency, GPT‑4.1 nano is the fastest and cheapest model in the GPT-4.1 series. It delivers exceptional performance at a small size with its 1 million token context window, and scores 80.1% on MMLU, 50.3% on GPQA, and 9.8% on Aider polyglot coding – even higher than GPT‑4o mini. It’s ideal for tasks like classification or autocompletion.

by openai
Apr 14, 2025
1.05M context
$0.10/M input tokens
$0.40/M output tokens


OpenAI: GPT-4o (2024-11-20)

2.39B tokens
The 2024-11-20 version of GPT-4o offers a leveled-up creative writing ability with more natural, engaging, and tailored writing to improve relevance & readability. It’s also better at working with uploaded files, providing deeper insights & more thorough responses.  GPT-4o ("o" for "omni") is OpenAI's latest AI model, supporting both text and image inputs with text outputs. It maintains the intelligence level of [GPT-4 Turbo](/models/openai/gpt-4-turbo) while being twice as fast and 50% more cost-effective. GPT-4o also offers improved performance in processing non-English languages and enhanced visual capabilities.

by openai
Nov 20, 2024
128K context
$2.50/M input tokens
$10/M output tokens


OpenAI: GPT-4o

17.3B tokens

Health (#35)

Marketing (#45)

SEO (#47)
GPT-4o ("o" for "omni") is OpenAI's latest AI model, supporting both text and image inputs with text outputs. It maintains the intelligence level of [GPT-4 Turbo](/models/openai/gpt-4-turbo) while being twice as fast and 50% more cost-effective. GPT-4o also offers improved performance in processing non-English languages and enhanced visual capabilities.  For benchmarking against other models, it was briefly called ["im-also-a-good-gpt2-chatbot"](https://twitter.com/LiamFedus/status/1790064963966370209)  #multimodal

by openai
May 13, 2024
128K context
$2.50/M input tokens
$10/M output tokens

OpenAI: GPT-5.1

46B tokens

Academia (#18)

Finance (#29)

Health (#12)

Legal (#8)

Marketing (#30)
GPT-5.1 is the latest frontier-grade model in the GPT-5 series, offering stronger general-purpose reasoning, improved instruction adherence, and a more natural conversational style compared to GPT-5. It uses adaptive reasoning to allocate computation dynamically, responding quickly to simple queries while spending more depth on complex tasks. The model produces clearer, more grounded explanations with reduced jargon, making it easier to follow even on technical or multi-step problems.  Built for broad task coverage, GPT-5.1 delivers consistent gains across math, coding, and structured analysis workloads, with more coherent long-form answers and improved tool-use reliability. It also features refined conversational alignment, enabling warmer, more intuitive responses without compromising precision. GPT-5.1 serves as the primary full-capability successor to GPT-5

by openai
Nov 13, 2025
400K context
$1.25/M input tokens
$10/M output tokens

OpenAI: GPT-5 Nano

54.5B tokens

Science (#39)
GPT-5-Nano is the smallest and fastest variant in the GPT-5 system, optimized for developer tools, rapid interactions, and ultra-low latency environments. While limited in reasoning depth compared to its larger counterparts, it retains key instruction-following and safety features. It is the successor to GPT-4.1-nano and offers a lightweight option for cost-sensitive or real-time applications.

by openai
Aug 7, 2025
400K context
$0.05/M input tokens
$0.40/M output tokens

