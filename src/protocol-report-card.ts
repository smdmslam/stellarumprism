// ProtocolReportCard \u2014 self-contained DOM block that visualizes one
// recipe run's lifecycle inside the AgentView message stream.
//
// Mounts in three states (driven by the runner via `onProgress`):
//   planning  \u2014 all steps shown as bullets, no spinner. Cancel button
//                in the footer wired to the runner's AbortController.
//   running   \u2014 active step's bullet \u2192 spinner; completed steps \u2192
//                \u2713 (ok) / \u2717 (failed) / \u2014 (skipped).
//   done      \u2014 step list collapses to a compact summary; severity /
//                duration line takes over. Footer adds Re-run + Open
//                full report buttons.
//
// The card mutates in place \u2014 every transition just updates the right
// pieces of the existing DOM rather than re-rendering. That keeps the
// agent panel scroll position stable across the run.

import type { Recipe, StepDef, StepResult } from "./recipes/types";

/** Lifecycle phase. Mirrors `RunStatus` from the spec. */
export type CardPhase = "planning" | "running" | "done" | "aborted";

/** Per-step state used by the bullet glyph. */
type CardStepState = "pending" | "active" | "ok" | "failed" | "skipped";

export interface ProtocolReportCardCallbacks {
  /** Called when the user clicks Cancel. Runner-side AbortController. */
  onCancel: () => void;
  /** Called when the user clicks Re-run (Done state only). */
  onRerun: () => void;
  /** Called when the user clicks Open full report (Done state only). */
  onOpenReport: (path: string) => void;
}

/** Public API the recipe runner / workspace use to drive the card. */
export class ProtocolReportCard {
  readonly el: HTMLElement;
  private readonly recipe: Recipe;
  private readonly cb: ProtocolReportCardCallbacks;
  private phase: CardPhase = "planning";
  private readonly stepEls: HTMLElement[] = [];
  private readonly stepStates: CardStepState[];

  // Slots that are recreated as the lifecycle advances.
  private headerEl: HTMLElement;
  private summaryEl: HTMLElement;
  private bodyEl: HTMLElement;
  private footerEl: HTMLElement;

  constructor(recipe: Recipe, cb: ProtocolReportCardCallbacks) {
    this.recipe = recipe;
    this.cb = cb;
    this.stepStates = recipe.steps.map(() => "pending");

    this.el = document.createElement("section");
    this.el.className = "protocol-report-card phase-planning";
    this.el.setAttribute("aria-label", `Protocol: ${recipe.label}`);

    this.headerEl = document.createElement("div");
    this.headerEl.className = "protocol-report-card-header";
    this.el.appendChild(this.headerEl);

    this.summaryEl = document.createElement("div");
    this.summaryEl.className = "protocol-report-card-summary";
    this.el.appendChild(this.summaryEl);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "protocol-report-card-body";
    this.el.appendChild(this.bodyEl);

    this.footerEl = document.createElement("div");
    this.footerEl.className = "protocol-report-card-footer";
    this.el.appendChild(this.footerEl);

    this.renderHeader();
    this.renderBodySteps();
    this.renderFooterPlanning();
  }

  // -- public lifecycle hooks (called from the runner / workspace) --------

  /** Called when the runner fires its first event (planning \u2192 running). */
  enterRunning(): void {
    if (this.phase !== "planning") return;
    this.phase = "running";
    this.el.classList.remove("phase-planning");
    this.el.classList.add("phase-running");
  }

  setStepActive(index: number): void {
    this.enterRunning();
    if (index < 0 || index >= this.stepStates.length) return;
    this.stepStates[index] = "active";
    this.updateStepRow(index);
  }

  setStepResult(
    index: number,
    state: "ok" | "failed" | "skipped",
    durationMs: number,
    detail?: string,
  ): void {
    if (index < 0 || index >= this.stepStates.length) return;
    this.stepStates[index] = state;
    this.updateStepRow(index, durationMs, detail);
  }

  /** Mark all remaining pending/active steps as skipped (used on abort). */
  cascadeSkipRemaining(reason: string): void {
    for (let i = 0; i < this.stepStates.length; i++) {
      if (this.stepStates[i] === "pending" || this.stepStates[i] === "active") {
        this.stepStates[i] = "skipped";
        this.updateStepRow(i, 0, reason);
      }
    }
  }

  setDone(opts: {
    okCount: number;
    failedCount: number;
    skippedCount: number;
    totalCount: number;
    durationMs: number;
    reportPath: string;
    aborted: boolean;
  }): void {
    this.phase = opts.aborted ? "aborted" : "done";
    this.el.classList.remove("phase-running", "phase-planning");
    this.el.classList.add(opts.aborted ? "phase-aborted" : "phase-done");
    this.renderSummary(opts);
    this.renderFooterDone(opts.reportPath);
  }

  // -- rendering pieces ---------------------------------------------------

  private renderHeader(): void {
    const now = new Date();
    this.headerEl.replaceChildren();
    const labelEl = document.createElement("span");
    labelEl.className = "protocol-report-card-label";
    labelEl.textContent = this.recipe.label;
    this.headerEl.appendChild(labelEl);

    const catEl = document.createElement("span");
    catEl.className = "protocol-report-card-category";
    catEl.textContent = this.recipe.category;
    this.headerEl.appendChild(catEl);

    const tsEl = document.createElement("span");
    tsEl.className = "protocol-report-card-ts";
    tsEl.textContent = now.toLocaleTimeString();
    tsEl.title = now.toISOString();
    this.headerEl.appendChild(tsEl);
  }

  private renderBodySteps(): void {
    this.bodyEl.replaceChildren();
    const list = document.createElement("ol");
    list.className = "protocol-report-card-steps";
    this.stepEls.length = 0;
    for (let i = 0; i < this.recipe.steps.length; i++) {
      const def = this.recipe.steps[i];
      const li = document.createElement("li");
      li.className = `protocol-report-card-step state-${this.stepStates[i]}`;
      li.innerHTML =
        `<span class="protocol-report-card-step-glyph"></span>` +
        `<span class="protocol-report-card-step-label"></span>` +
        `<span class="protocol-report-card-step-meta"></span>`;
      this.fillStepRow(li, i, def);
      list.appendChild(li);
      this.stepEls.push(li);
    }
    this.bodyEl.appendChild(list);
  }

  private fillStepRow(
    li: HTMLElement,
    index: number,
    def: StepDef,
    durationMs?: number,
    detail?: string,
  ): void {
    const state = this.stepStates[index];
    li.className = `protocol-report-card-step state-${state}`;
    const glyph = li.querySelector<HTMLElement>(".protocol-report-card-step-glyph");
    const label = li.querySelector<HTMLElement>(".protocol-report-card-step-label");
    const meta = li.querySelector<HTMLElement>(".protocol-report-card-step-meta");
    if (!glyph || !label || !meta) return;
    glyph.textContent = stepGlyph(state);
    glyph.dataset.state = state;
    label.textContent = def.label;
    const parts: string[] = [];
    if (durationMs !== undefined && durationMs > 0) {
      parts.push(formatShortDuration(durationMs));
    }
    if (detail && detail.length > 0) {
      parts.push(detail);
    }
    meta.textContent = parts.length > 0 ? parts.join(" \u00b7 ") : "";
  }

  private updateStepRow(
    index: number,
    durationMs?: number,
    detail?: string,
  ): void {
    const li = this.stepEls[index];
    if (!li) return;
    this.fillStepRow(li, index, this.recipe.steps[index], durationMs, detail);
  }

  private renderSummary(opts: {
    okCount: number;
    failedCount: number;
    skippedCount: number;
    totalCount: number;
    durationMs: number;
    aborted: boolean;
  }): void {
    this.summaryEl.replaceChildren();
    const tag = opts.aborted
      ? "aborted"
      : opts.failedCount > 0
        ? "failed"
        : opts.skippedCount > 0
          ? "partial"
          : "ok";
    this.summaryEl.dataset.tag = tag;
    const parts: string[] = [];
    parts.push(`${opts.okCount}/${opts.totalCount} ok`);
    if (opts.failedCount > 0) parts.push(`${opts.failedCount} failed`);
    if (opts.skippedCount > 0) parts.push(`${opts.skippedCount} skipped`);
    parts.push(formatShortDuration(opts.durationMs));
    const badge = document.createElement("span");
    badge.className = "protocol-report-card-summary-badge";
    badge.textContent = tag;
    this.summaryEl.appendChild(badge);
    const line = document.createElement("span");
    line.className = "protocol-report-card-summary-line";
    line.textContent = parts.join(" \u00b7 ");
    this.summaryEl.appendChild(line);
  }

  private renderFooterPlanning(): void {
    this.footerEl.replaceChildren();
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "protocol-report-card-btn protocol-report-card-btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => this.cb.onCancel());
    this.footerEl.appendChild(cancelBtn);
  }

  private renderFooterDone(reportPath: string): void {
    this.footerEl.replaceChildren();
    if (reportPath) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "protocol-report-card-btn";
      openBtn.textContent = "Open full report";
      openBtn.title = reportPath;
      openBtn.addEventListener("click", () => this.cb.onOpenReport(reportPath));
      this.footerEl.appendChild(openBtn);
    }
    const rerunBtn = document.createElement("button");
    rerunBtn.type = "button";
    rerunBtn.className = "protocol-report-card-btn";
    rerunBtn.textContent = "Re-run";
    rerunBtn.addEventListener("click", () => this.cb.onRerun());
    this.footerEl.appendChild(rerunBtn);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stepGlyph(state: CardStepState): string {
  switch (state) {
    case "ok":
      return "\u2713";
    case "failed":
      return "\u2717";
    case "skipped":
      return "\u2014";
    case "active":
      return "\u25cf"; // CSS turns this into a spinner when state-active
    default:
      return "\u00b7";
  }
}

function formatShortDuration(ms: number): string {
  if (ms <= 0) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

/** Adapter shape passed into the card from a `RecipeReport` after `done`. */
export function summaryFromSteps(
  steps: Array<{ def: StepDef; result: StepResult }>,
): { okCount: number; failedCount: number; skippedCount: number; totalCount: number } {
  let okCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const s of steps) {
    if (s.result.state === "ok") okCount++;
    else if (s.result.state === "failed") failedCount++;
    else if (s.result.state === "skipped") skippedCount++;
  }
  return { okCount, failedCount, skippedCount, totalCount: steps.length };
}
