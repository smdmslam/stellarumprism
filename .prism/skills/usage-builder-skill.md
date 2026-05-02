# Usage Tracking System for LLM Applications

This document outlines a robust usage tracking system designed for applications leveraging Large Language Models (LLMs), particularly those with a credit-based billing or resource management model. It details the architecture, key components, and implementation considerations.

## 1. Overview

The system captures granular data on each LLM interaction, aggregates it, computes estimated costs, and persists this information for billing, analytics, and abuse prevention. It focuses on:

*   **Context Propagation**: Automatically associating LLM calls with a specific operation or user request, even across asynchronous boundaries.
*   **Cost Estimation**: Dynamically calculating interaction costs based on token usage and model-specific pricing.
*   **Persistence**: Storing detailed and summarized usage data in a database (e.g., Firestore).
*   **Reporting**: Providing aggregated usage insights for users and administrators.
*   **Abuse Prevention**: Mechanisms to monitor recent usage to prevent credit exhaustion or misuse.

## 2. Core Components

The system is built around three main logical components:

### 2.1 The `UsageTracker` (Client-side / In-context)

This component is responsible for recording individual LLM calls within the scope of a single operation.

*   **Location**: Typically implemented as a class or module (e.g., `src/services/usage-tracker.ts`).
*   **Key Features**:
    *   **`UsageRecord`**: A data structure capturing details of a single LLM call:
        *   `agent`: Identifier for the functional area or "agent" making the call (e.g., "researcher", "writer", "summarizer"). Useful for cost attribution per feature.
        *   `model`: The specific LLM model used (e.g., "openai/gpt-4o", "google/gemini-2.5-flash").
        *   `inputTokens`, `outputTokens`, `totalTokens`: The number of tokens consumed by the prompt, generated in the response, and total for the call.
        *   `estimatedCost`: Calculated cost in USD for this specific call based on token counts and model pricing.
        *   `latencyMs`: The round-trip time for the LLM API call.
        *   `success`: Boolean indicating if the LLM call was successful.
        *   `timestamp`: When the call was made.
    *   **`UsageSummary`**: An aggregated view of all `UsageRecord`s within an operation:
        *   Total counts for calls, input tokens, output tokens, total tokens, estimated cost, and latency.
        *   `byAgent` breakdown: A sub-summary categorizing totals per `agent`.
    *   **`MODEL_PRICING`**: A static or dynamically loaded configuration containing pricing information for various LLM models (e.g., cost per million input tokens, cost per million output tokens, and optional per-query costs for hybrid models). This should be kept up-to-date with provider pricing.
    *   **`estimateCost(model, inputTokens, outputTokens)`**: A utility function to calculate the raw USD cost of an LLM call using `MODEL_PRICING`.
    *   **`UsageTracker` class**:
        *   Manages a collection of `UsageRecord`s.
        *   Provides methods to `record()` new LLM calls and `getSummary()` of all recorded calls.
    *   **Context Propagation Mechanism**: Crucially, this component integrates with a mechanism like Node.js' `AsyncLocalStorage` (or similar for other environments like `context.Context` in Go, `threading.local` in Python) to ensure the correct `UsageTracker` instance is available throughout an asynchronous call stack.
        *   `runWithTracker(fn)`: A higher-order function that initializes a new `UsageTracker`, makes it available in the current asynchronous context, executes `fn`, and then returns the tracker's results.
        *   `getTracker()`: Retrieves the `UsageTracker` instance from the current context.

### 2.2 The `Usage Persistence` (Server-side / Database Layer)

This component handles storing and retrieving the tracked usage data in your application's database.

*   **Location**: Typically a service or data access layer (e.g., `src/services/usage.ts`).
*   **Database**: Firestore is used in the example, but any suitable NoSQL or SQL database can work.
*   **Key Features**:
    *   **`UsageDoc`**: The schema for documents stored in the database, encapsulating:
        *   `uid`: The user ID.
        *   `essayId` (example): An optional ID linking usage to a specific output or resource.
        *   `period`: A "YYYY-MM" string for time-based aggregation.
        *   `config`: Any relevant configuration or parameters used for the operation, useful for analyzing cost drivers or reproducing results.
        *   `summary`: The `UsageSummary` from the `UsageTracker`.
        *   `records`: The array of `UsageRecord`s from the `UsageTracker`.
        *   `createdAt`: A server-generated timestamp.
    *   **`saveUsage(uid, resourceId, summary, records, config)`**: Stores a `UsageDoc` in the database. It should handle serialization (e.g., stripping `undefined` values for Firestore).
    *   **`MARGIN_MULTIPLIER`**: A constant (e.g., `20`) applied to the `estimatedCost` to calculate the user-facing cost (`userCost`). This allows you to track raw costs separately from what users are charged, accounting for profit margins, overhead, etc. In the example, a multiplier of 20 means a 95% margin (`(20-1)/20 = 0.95`).
    *   **`PeriodUsage`**: A data structure for aggregated usage data over a period for a user, including raw and user costs, and breakdowns.
    *   **`getUserUsage(uid, period)`**: Retrieves and aggregates `UsageDoc`s for a specific user and period, returning a `PeriodUsage` report.
    *   **`getRecentUsageCost(uid, hours)`**: Queries recent usage (e.g., last hour) to calculate total cost. This is crucial for rate-limiting or preventing rapid credit depletion.

### 2.3 Application Integration

This involves connecting the `UsageTracker` and `Usage Persistence` components into the application's request flow and LLM interaction points.

*   **LLM Wrapper/Service**: Modify your LLM calling functions (e.g., `callLLM` in `src/config/llm.ts`) to:
    1.  Check `getTracker()`.
    2.  If a tracker exists, record the `agent`, `model`, token usage, latency, and success status *after* each LLM API call.
*   **Request Handlers / Orchestrators**:
    1.  Wrap top-level asynchronous operations that trigger LLM calls (e.g., a research pipeline, a generation task) with `runWithTracker()`.
    2.  After the operation completes, retrieve the `UsageSummary` and `UsageRecord`s from the tracker.
    3.  Call `saveUsage()` to persist this data to the database.
    4.  Implement credit deduction logic based on `totalUserCost` (e.g., `deductBalance(uid, userCost)`).
*   **API Endpoints**:
    1.  Provide an endpoint for users to query their usage (e.g., `GET /api/usage/:period`).
    2.  Implement an administrative endpoint to retrieve overall analytics or to test usage tracking.

## 3. Implementation Details & Best Practices

*   **Asynchronous Context**: `AsyncLocalStorage` is paramount for avoiding explicit `tracker` passing. Ensure your chosen language/framework has an equivalent for proper context propagation.
*   **Error Handling**: Ensure that LLM call failures are also recorded (e.g., `success: false`) and appropriately handled, perhaps with reduced or zero cost depending on your policy.
*   **Database Indexes**: For efficient querying (especially `getUserUsage` and `getRecentUsageCost`), ensure appropriate indexes are set on your database (e.g., on `uid`, `period`, `createdAt`).
*   **Pricing Updates**: `MODEL_PRICING` needs to be consistently maintained with the latest LLM provider costs. Consider an automated process or an easy-to-update configuration.
*   **Margin Configuration**: The `MARGIN_MULTIPLIER` should be configurable, perhaps per-user tier, to adjust pricing strategies.
*   **Real-time vs. Batch**: For very high-throughput systems, consider batching `saveUsage` calls or using message queues to offload persistence, though for most applications, direct saving after an operation is sufficient.
*   **User Interface**: Develop a user-facing dashboard to display `PeriodUsage` data, allowing users to understand their consumption and costs.
*   **Admin Analytics**: Leverage the `UsageDoc`s in the database to build internal dashboards for monitoring application-wide LLM costs, user behavior, and agent performance.

## 4. Example Flow (Simplified)

```typescript
// src/config/llm.ts (LLM Wrapper)
import { getTracker } from "../services/usage-tracker.js";

async function callLLM(agentRole: string, model: string, prompt: string): Promise<string> {
  const tracker = getTracker();
  const callStart = Date.now();

  // Simulate LLM API call
  const response = {
    text: "LLM response",
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
  const success = true; // Or false if API errored

  if (tracker) {
    tracker.record(
      agentRole,
      model,
      response.usage.prompt_tokens,
      response.usage.completion_tokens,
      response.usage.total_tokens,
      Date.now() - callStart,
      success
    );
  }

  return response.text;
}


// src/agents/orchestrator.ts (Example Operation)
import { runWithTracker } from "../services/usage-tracker.js";
import { saveUsage } from "../services/usage.js";
import { deductBalance } from "../services/profile.js"; // Assuming this exists

async function executeResearchPipeline(uid: string, topic: string) {
  const { result, tracker } = await runWithTracker(async () => {
    // --- Step 1: Planning ---
    const plan = await callLLM("planner", "google/gemini-2.5-flash", `Create a research plan for ${topic}`);

    // --- Step 2: Research ---
    const researchSummary = await callLLM("researcher", "perplexity/sonar-pro", `Summarize key points from ${plan}`);

    // --- Step 3: Writing ---
    const article = await callLLM("writer", "openai/gpt-4o", `Write an article based on ${researchSummary}`);

    return { article };
  });

  const usageSummary = tracker.getSummary();
  const usageRecords = tracker.getRecords();

  console.log(`Pipeline completed. Total estimated cost: $${usageSummary.totalEstimatedCost.toFixed(4)}`);

  // Persist usage to database
  const usageId = await saveUsage(uid, null, usageSummary, usageRecords, { topic });

  // Deduct user balance (assuming MARGIN_MULTIPLIER is handled internally by deductBalance or passed)
  await deductBalance(uid, usageSummary.totalEstimatedCost * MARGIN_MULTIPLIER);

  return result.article;
}

// In your main application entry point (e.g., src/index.ts)
// app.post("/api/research", async (req, res) => {
//   // ... auth and validation
//   const uid = req.headers["x-user-id"] as string;
//   const { topic } = req.body;
//   try {
//     const article = await executeResearchPipeline(uid, topic);
//     res.json({ article });
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });

// app.get("/api/usage/:period", async (req, res) => {
//   // ... auth and validation
//   const uid = req.headers["x-user-id"] as string;
//   const period = req.params.period;
//   try {
//     const userUsage = await getUserUsage(uid, period);
//     res.json(userUsage);
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });
```

By following this structure, any new project can easily integrate comprehensive LLM usage tracking with minimal boilerplate.
