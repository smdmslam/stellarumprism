import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { settings } from "./settings";
import { TabManager } from "./tabs";
import { ToolbarManager } from "./toolbar";

export class OnboardingWizard {
  private readonly tabManager: TabManager;
  private readonly toolbarManager: ToolbarManager;
  private overlay: HTMLDivElement | null = null;
  private currentStep = 0;

  // Configuration state
  private chosenDirectory = "";
  private chosenModel = "anthropic/claude-haiku-4.5"; // default fallback matching models.ts

  // Layout selection states (toggles in Step 2)
  private layoutToggles = {
    sidebar: true,
    terminal: true,
    preview: true,
    console: false,
    agent: true,
    problems: false,
  };

  constructor(tabManager: TabManager, toolbarManager: ToolbarManager) {
    this.tabManager = tabManager;
    this.toolbarManager = toolbarManager;
  }

  /**
   * Initialize and launch the wizard.
   */
  public start(): void {
    if (this.overlay) return;

    this.overlay = document.createElement("div");
    this.overlay.className = "onboarding-overlay";
    this.overlay.innerHTML = `
      <div class="onboarding-card">
        <div class="onboarding-progress-bar">
          <div class="onboarding-progress-fill" style="width: 25%;"></div>
        </div>
        <div class="onboarding-slide-container"></div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    this.renderStep();
  }

  private renderStep(): void {
    if (!this.overlay) return;

    const container = this.overlay.querySelector(".onboarding-slide-container");
    if (!container) return;

    const progressFill = this.overlay.querySelector(".onboarding-progress-fill") as HTMLElement;
    if (progressFill) {
      const percentage = ((this.currentStep + 1) / 3) * 100;
      progressFill.style.width = `${Math.min(percentage, 100)}%`;
    }

    container.innerHTML = "";

    switch (this.currentStep) {
      case 0:
        this.renderStepWelcome(container);
        break;
      case 1:
        this.renderStepLayout(container);
        break;
      case 2:
        this.renderStepModel(container);
        break;
    }
  }

  /**
   * Step 1: Welcome & Directory Selection
   */
  private renderStepWelcome(container: Element): void {
    const slide = document.createElement("div");
    slide.className = "onboarding-slide active";
    slide.innerHTML = `
      <div class="onboarding-welcome-icon">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--prism-cyan)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          <circle cx="12" cy="13" r="3"></circle>
          <path d="M12 10v1"></path>
        </svg>
      </div>
      <h2 class="onboarding-title">Welcome to Prism</h2>
      <p class="onboarding-subtitle">Your ultra-premium, multi-agentic developer workspace. Let's configure your space in two simple steps.</p>

      <div class="onboarding-directory-picker">
        <label class="onboarding-picker-label">INITIAL WORKSPACE ROOT</label>
        <p class="onboarding-picker-desc">Select a project directory or folder to initialize your active workspace tab.</p>
        
        <button id="btn-pick-dir" class="onboarding-btn-primary">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          Select Project Directory
        </button>

        <div id="onboarding-dir-pill" class="onboarding-path-pill" style="display: none;">
          <span class="pill-dot"></span>
          <span id="onboarding-dir-text" class="pill-text"></span>
        </div>
      </div>

      <div class="onboarding-footer">
        <button id="btn-step-next-1" class="onboarding-btn-action" disabled>
          Continue
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 6px;">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
    `;

    container.appendChild(slide);

    const pickBtn = slide.querySelector("#btn-pick-dir");
    const nextBtn = slide.querySelector("#btn-step-next-1") as HTMLButtonElement;
    const pill = slide.querySelector("#onboarding-dir-pill") as HTMLElement;
    const pillText = slide.querySelector("#onboarding-dir-text") as HTMLElement;

    // Show path if already selected previously
    if (this.chosenDirectory) {
      pillText.textContent = this.chosenDirectory;
      pill.style.display = "flex";
      nextBtn.disabled = false;
    }

    pickBtn?.addEventListener("click", async () => {
      try {
        const picked = await openDialog({
          title: "Choose Prism Workspace Directory",
          multiple: false,
          directory: true,
        });
        const target = Array.isArray(picked) ? (picked[0] ?? null) : picked;
        if (target) {
          this.chosenDirectory = target;
          pillText.textContent = target;
          pill.style.display = "flex";
          nextBtn.disabled = false;
        }
      } catch (err) {
        console.error("Failed to pick directory:", err);
      }
    });

    nextBtn?.addEventListener("click", () => {
      this.currentStep = 1;
      this.renderStep();
    });
  }

  /**
   * Step 2: Workspace Layout setup with real-time feedback
   */
  private renderStepLayout(container: Element): void {
    const slide = document.createElement("div");
    slide.className = "onboarding-slide active";
    slide.innerHTML = `
      <h2 class="onboarding-title">Customize Workspace Layout</h2>
      <p class="onboarding-subtitle">Prism features a premium, multi-window layout engine. Click any pane below to toggle its initial visibility in the background.</p>

      <div class="onboarding-layout-grid">
        <div class="onboarding-layout-card ${this.layoutToggles.sidebar ? "active" : ""}" data-pane="sidebar">
          <div class="card-glow"></div>
          <div class="card-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
          </div>
          <div class="card-details">
            <span class="card-name">Sidebar Explorer</span>
            <span class="card-desc">File tree, skills library, and bookmarks.</span>
          </div>
        </div>

        <div class="onboarding-layout-card ${this.layoutToggles.agent ? "active" : ""}" data-pane="agent">
          <div class="card-glow"></div>
          <div class="card-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
          </div>
          <div class="card-details">
            <span class="card-name">Agent Chat</span>
            <span class="card-desc">Direct interface to your autonomous coder.</span>
          </div>
        </div>

        <div class="onboarding-layout-card ${this.layoutToggles.terminal ? "active" : ""}" data-pane="terminal">
          <div class="card-glow"></div>
          <div class="card-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
          </div>
          <div class="card-details">
            <span class="card-name">Integrated Shell</span>
            <span class="card-desc">Active background PTY terminal stream.</span>
          </div>
        </div>

        <div class="onboarding-layout-card ${this.layoutToggles.preview ? "active" : ""}" data-pane="preview">
          <div class="card-glow"></div>
          <div class="card-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
            </svg>
          </div>
          <div class="card-details">
            <span class="card-name">Reader Mode</span>
            <span class="card-desc">Spacious view-and-edit side-split.</span>
          </div>
        </div>

        <div class="onboarding-layout-card ${this.layoutToggles.console ? "active" : ""}" data-pane="console">
          <div class="card-glow"></div>
          <div class="card-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="2"></rect>
              <rect x="9" y="9" width="6" height="6"></rect>
              <path d="M9 1v3"></path>
              <path d="M15 1v3"></path>
              <path d="M9 20v3"></path>
              <path d="M15 20v3"></path>
              <path d="M20 9h3"></path>
              <path d="M20 15h3"></path>
              <path d="M1 9h3"></path>
              <path d="M1 15h3"></path>
            </svg>
          </div>
          <div class="card-details">
            <span class="card-name">System Console</span>
            <span class="card-desc">Prism core execution and platform logs.</span>
          </div>
        </div>

        <div class="onboarding-layout-card ${this.layoutToggles.problems ? "active" : ""}" data-pane="problems">
          <div class="card-glow"></div>
          <div class="card-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
          </div>
          <div class="card-details">
            <span class="card-name">Diagnostics</span>
            <span class="card-desc">Compile errors, lints, and diagnostic checks.</span>
          </div>
        </div>
      </div>

      <div class="onboarding-pro-tip">
        <span class="tip-badge">PRO TIP</span>
        <span class="tip-content">Right-click or Double-click any file in the sidebar tree to open it in a spacious side-by-side split screen for fluid viewing and editing.</span>
      </div>

      <div class="onboarding-footer">
        <button id="btn-step-prev-2" class="onboarding-btn-action secondary">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          Back
        </button>
        <button id="btn-step-next-2" class="onboarding-btn-action">
          Continue
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 6px;">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
    `;

    container.appendChild(slide);

    // Bind toggles
    const cards = slide.querySelectorAll(".onboarding-layout-card");
    cards.forEach((card) => {
      card.addEventListener("click", () => {
        const pane = card.getAttribute("data-pane") as keyof typeof this.layoutToggles;
        if (!pane) return;

        // Toggle state
        this.layoutToggles[pane] = !this.layoutToggles[pane];
        card.classList.toggle("active", this.layoutToggles[pane]);

        // Toggle background window live!
        const activeWs = this.tabManager.getActiveWorkspace();
        if (activeWs) {
          if (pane === "sidebar") activeWs.toggleSidebar();
          else if (pane === "terminal") activeWs.toggleTerminal();
          else if (pane === "preview") activeWs.togglePreview();
          else if (pane === "console") activeWs.toggleConsole();
          else if (pane === "agent") activeWs.toggleAgent();
          else if (pane === "problems") activeWs.toggleProblems();

          // Sync layout buttons on bottom bar
          this.toolbarManager.updateLayoutButtons();
        }
      });
    });

    slide.querySelector("#btn-step-prev-2")?.addEventListener("click", () => {
      this.currentStep = 0;
      this.renderStep();
    });

    slide.querySelector("#btn-step-next-2")?.addEventListener("click", () => {
      this.currentStep = 2;
      this.renderStep();
    });
  }

  /**
   * Step 3: Choose Primary Model
   */
  private renderStepModel(container: Element): void {
    const slide = document.createElement("div");
    slide.className = "onboarding-slide active";
    slide.innerHTML = `
      <h2 class="onboarding-title">Select Your Primary Model</h2>
      <p class="onboarding-subtitle">Choose the default high-performance model to power your code-generation and refactoring sequences.</p>

      <div class="onboarding-model-list">
        <div class="onboarding-model-option ${this.chosenModel === "anthropic/claude-haiku-4.5" ? "active" : ""}" data-model="anthropic/claude-haiku-4.5">
          <div class="model-option-glow"></div>
          <div style="flex: 1;">
            <div class="model-option-title">Claude Haiku 4.5 <span class="badge-recommended">RECOMMENDED</span></div>
            <div class="model-option-desc">Careful reasoner, fast execution, flawless tool-use, and extremely surgeon-like edits.</div>
          </div>
          <div class="model-option-meta">
            <span class="meta-item tag-cyan">Anthropic</span>
            <span class="meta-item cost-indicator">$$</span>
          </div>
        </div>

        <div class="onboarding-model-option ${this.chosenModel === "x-ai/grok-4.1-fast" ? "active" : ""}" data-model="x-ai/grok-4.1-fast">
          <div class="model-option-glow"></div>
          <div style="flex: 1;">
            <div class="model-option-title">Grok 4.1 Fast</div>
            <div class="model-option-desc">Excels at whole-repo structural synthesis and parsing wide workspace logs.</div>
          </div>
          <div class="model-option-meta">
            <span class="meta-item tag-purple">xAI</span>
            <span class="meta-item cost-indicator">$$</span>
          </div>
        </div>

        <div class="onboarding-model-option ${this.chosenModel === "openai/gpt-5.4" ? "active" : ""}" data-model="openai/gpt-5.4">
          <div class="model-option-glow"></div>
          <div style="flex: 1;">
            <div class="model-option-title">GPT-5.4</div>
            <div class="model-option-desc">Premium frontier multi-modal synthesis. Slower but highly robust.</div>
          </div>
          <div class="model-option-meta">
            <span class="meta-item tag-pink">OpenAI</span>
            <span class="meta-item cost-indicator">$$$</span>
          </div>
        </div>
      </div>

      <div class="onboarding-footer">
        <button id="btn-step-prev-3" class="onboarding-btn-action secondary">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          Back
        </button>
        <button id="btn-step-finish" class="onboarding-btn-primary" style="padding: 10px 24px; font-weight: 700; width: auto;">
          Activate Workspace
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 6px;">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
        </button>
      </div>
    `;

    container.appendChild(slide);

    // Bind model select
    const options = slide.querySelectorAll(".onboarding-model-option");
    options.forEach((opt) => {
      opt.addEventListener("click", () => {
        options.forEach((o) => o.classList.remove("active"));
        opt.classList.add("active");
        this.chosenModel = opt.getAttribute("data-model") || "anthropic/claude-haiku-4.5";
      });
    });

    slide.querySelector("#btn-step-prev-3")?.addEventListener("click", () => {
      this.currentStep = 1;
      this.renderStep();
    });

    slide.querySelector("#btn-step-finish")?.addEventListener("click", () => {
      this.completeOnboarding();
    });
  }

  /**
   * Save configs, trigger workspace mount, and run slide-out transition
   */
  private async completeOnboarding(): Promise<void> {
    try {
      // 1. Persist model selection to system config
      await invoke("set_agent_model", { model: this.chosenModel });

      // 2. Add chosen directory to bookmarked folders
      await invoke("add_bookmarked_directory", { dir: this.chosenDirectory });

      // 3. Mark completed in local AppSettings
      settings.setCompletedOnboarding(true);

      // 4. Mount directory in active workspace tab via background handleSubmit cd
      const activeWs = this.tabManager.getActiveWorkspace();
      if (activeWs) {
        const cmd = `cd ${this.chosenDirectory}`;
        activeWs.handleSubmit(cmd, { intent: "command", explicit: true, payload: cmd });
      }

      // 5. Run spectacular exit sequence
      if (this.overlay) {
        this.overlay.classList.add("fade-out");
        
        // Wait for 400ms transition to finish
        setTimeout(() => {
          this.overlay?.remove();
          this.overlay = null;

          // Focus main input editor automatically so they can type immediately
          if (activeWs) {
            activeWs.focusInput();
          }
        }, 400);
      }
    } catch (err) {
      console.error("Failed to complete onboarding:", err);
      alert(`Onboarding completion error: ${err}`);
    }
  }
}
