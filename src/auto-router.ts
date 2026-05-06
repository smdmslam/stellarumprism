import { getModelEntry, resolveModel } from "./models";

export interface ControlPlaneDecision {
  task_class: string;
  risk_level: string;
  estimated_context_tokens: number;
  recommended_model: string;
  confidence: number;
  rationale?: string;
}

export interface RouteGuardrailInput {
  decision: ControlPlaneDecision;
  fallbackModel: string;
  previousAutoModel: string | null;
}

export interface RouteGuardrailResult {
  model: string;
  reason: string;
}

const HIGH_STAKES_STRONG_MODEL = "anthropic/claude-haiku-4.5";
const LONG_CONTEXT_STRONG_MODEL = "x-ai/grok-4.1-fast";

export function normalizeControlPlaneDecision(
  raw: Partial<ControlPlaneDecision> | null | undefined,
): ControlPlaneDecision | null {
  if (!raw) return null;
  const taskClass = String(raw.task_class ?? "").trim().toLowerCase();
  const riskLevel = String(raw.risk_level ?? "").trim().toLowerCase();
  const est = Number(raw.estimated_context_tokens ?? 0);
  const conf = Number(raw.confidence ?? 0);
  const recommended = String(raw.recommended_model ?? "").trim();
  if (!taskClass || !riskLevel || !recommended || !Number.isFinite(est)) {
    return null;
  }
  return {
    task_class: taskClass,
    risk_level: riskLevel,
    estimated_context_tokens: Math.max(0, Math.floor(est)),
    recommended_model: recommended,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    rationale: raw.rationale ? String(raw.rationale) : undefined,
  };
}

export function applyRouteGuardrails(
  input: RouteGuardrailInput,
): RouteGuardrailResult {
  const { decision, fallbackModel, previousAutoModel } = input;
  const resolvedRecommended =
    resolveModel(decision.recommended_model) ?? decision.recommended_model;
  let chosen = resolvedRecommended;
  let reason = "control-plane recommendation";

  // Guardrail 1: keep the model tool-capable + known.
  const entry = getModelEntry(chosen);
  if (!entry || entry.toolUse === false) {
    chosen = fallbackModel;
    reason = "unknown/non-tool model fallback";
  }

  // Guardrail 2: context-window floor.
  const need = Math.max(0, decision.estimated_context_tokens);
  const chosenEntry = getModelEntry(chosen);
  const chosenCtx = chosenEntry?.maxContext ?? 0;
  if (need > 0 && chosenCtx > 0 && chosenCtx < Math.floor(need * 1.1)) {
    chosen = LONG_CONTEXT_STRONG_MODEL;
    reason = "context-window floor override";
  }

  // Guardrail 3: high-stakes override to stronger model.
  if (/high|critical/.test(decision.risk_level)) {
    chosen = HIGH_STAKES_STRONG_MODEL;
    reason = "high-stakes override";
  }

  // Guardrail 4: no-thrash stabilization.
  if (
    previousAutoModel &&
    previousAutoModel !== chosen &&
    decision.confidence < 0.72
  ) {
    chosen = previousAutoModel;
    reason = "no-thrash stabilization";
  }

  return { model: chosen, reason };
}
