/**
 * Protocols Menu Manager
 * 
 * Provides a polished dropdown in the top toolbar listing pre-packaged developer
 * sequences (e.g., "Security Audit", "Harden Loop", "Clean Refactor").
 * Each protocol shows:
 * - Name and brief description
 * - Current requirements / disabled state
 * - One-click action to trigger via /protocol command
 * 
 * Master Plan 4.1 & 4.2: Toolbar Protocols Dropdown Menu
 */

export interface ProtocolDefinition {
  id: string;
  label: string;
  description: string;
  requirements: string[];
  disabled?: boolean;
  disabledReason?: string;
  category?: string;
  icon?: string;
}

export const PROTOCOLS_MENU: ProtocolDefinition[] = [
  {
    id: "security-audit",
    label: "Security Audit",
    description: "Scan for common vulnerabilities, injection risks, and unsafe patterns",
    requirements: ["LSP diagnostics enabled", "AST analysis available"],
    icon: "🔒",
    category: "Security",
  },
  {
    id: "harden-loop",
    label: "Harden Loop",
    description: "Iterative type safety pass; fix errors, narrow types, strengthen contracts",
    requirements: ["TypeScript or Rust project", "Typecheck passing"],
    icon: "⚔️",
    category: "Quality",
  },
  {
    id: "clean-refactor",
    label: "Clean Refactor",
    description: "Structural refactoring: consolidate duplication, extract utilities, rename for clarity",
    requirements: ["Test suite present", "Git repo"],
    icon: "✨",
    category: "Maintenance",
  },
  {
    id: "performance-profile",
    label: "Performance Profile",
    description: "Identify bottlenecks, hot paths, and optimization opportunities",
    requirements: ["Build system available", "Profiler tools installed"],
    icon: "⚡",
    category: "Performance",
  },
  {
    id: "test-coverage",
    label: "Test Coverage",
    description: "Analyze coverage, identify gaps, generate missing test cases",
    requirements: ["Test framework available", "Coverage reporter installed"],
    icon: "📊",
    category: "Testing",
  },
  {
    id: "docs-audit",
    label: "Documentation Audit",
    description: "Review docs for accuracy, completeness, and alignment with code",
    requirements: ["README or documentation files present"],
    icon: "📖",
    category: "Documentation",
  },
  {
    id: "dependency-review",
    label: "Dependency Review",
    description: "Audit dependencies for updates, security patches, and redundancy",
    requirements: ["Package manager (npm/pnpm/cargo) configured"],
    icon: "📦",
    category: "Dependencies",
  },
  {
    id: "api-design-check",
    label: "API Design Check",
    description: "Evaluate public interface consistency, naming conventions, and ergonomics",
    requirements: ["Public exports / modules defined"],
    icon: "🔌",
    category: "Design",
  },
];

export class ProtocolsMenuManager {
  private menuOpen: boolean = false;
  private menuElement: HTMLElement | null = null;
  private backdropElement: HTMLElement | null = null;
  private onProtocolSelect: ((protocolId: string) => void) | null = null;

  constructor() {
    this.setupMenu();
  }

  private setupMenu(): void {
    const button = document.getElementById("tb-protocols");
    if (!button) return;

    button.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.menuOpen) {
        this.closeMenu();
      }
    });

    document.addEventListener("click", (e) => {
      if (this.menuOpen && e.target !== button) {
        this.closeMenu();
      }
    });
  }

  public onProtocolSelected(callback: (protocolId: string) => void): void {
    this.onProtocolSelect = callback;
  }

  public toggleMenu(): void {
    if (this.menuOpen) {
      this.closeMenu();
    } else {
      this.openMenu();
    }
  }

  public openMenu(): void {
    if (this.menuOpen) return;

    this.menuOpen = true;
    this.renderMenu();
    this.updateButtonState();
  }

  public closeMenu(): void {
    if (!this.menuOpen) return;

    this.menuOpen = false;
    this.destroyMenu();
    this.updateButtonState();
  }

  private renderMenu(): void {
    this.backdropElement = document.createElement("div");
    this.backdropElement.className = "protocols-menu-backdrop";
    this.backdropElement.addEventListener("click", () => this.closeMenu());
    document.body.appendChild(this.backdropElement);

    this.menuElement = document.createElement("div");
    this.menuElement.className = "protocols-menu";
    document.body.appendChild(this.menuElement);

    const button = document.getElementById("tb-protocols");
    if (button) {
      const rect = button.getBoundingClientRect();
      this.menuElement.style.top = `${rect.bottom + 8}px`;
      this.menuElement.style.right = `12px`;
    }

    const grouped = this.groupByCategory();

    for (const [category, protocols] of Object.entries(grouped)) {
      const headerDiv = document.createElement("div");
      headerDiv.className = "protocols-menu-section-label";
      headerDiv.textContent = category;
      this.menuElement!.appendChild(headerDiv);

      for (const protocol of protocols) {
        const item = this.createProtocolItem(protocol);
        this.menuElement!.appendChild(item);
      }

      if (category !== Object.keys(grouped)[Object.keys(grouped).length - 1]) {
        const divider = document.createElement("div");
        divider.className = "protocols-menu-divider";
        this.menuElement!.appendChild(divider);
      }
    }
  }

  private groupByCategory(): Record<string, ProtocolDefinition[]> {
    const grouped: Record<string, ProtocolDefinition[]> = {};

    for (const protocol of PROTOCOLS_MENU) {
      const category = protocol.category || "Other";
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(protocol);
    }

    return grouped;
  }

  private createProtocolItem(protocol: ProtocolDefinition): HTMLElement {
    const item = document.createElement("div");
    item.className = "protocols-menu-item";

    if (protocol.disabled) {
      item.classList.add("disabled");
      item.setAttribute("title", protocol.disabledReason || "This protocol is not available");
    } else {
      item.addEventListener("click", () => this.selectProtocol(protocol.id));
      item.style.cursor = "pointer";
    }

    const header = document.createElement("div");
    header.className = "protocols-menu-item-header";

    const iconSpan = document.createElement("span");
    iconSpan.className = "protocols-menu-icon";
    iconSpan.textContent = protocol.icon || "▸";

    const nameSpan = document.createElement("span");
    nameSpan.className = "protocols-menu-item-name";
    nameSpan.textContent = protocol.label;

    header.appendChild(iconSpan);
    header.appendChild(nameSpan);
    item.appendChild(header);

    const descSpan = document.createElement("div");
    descSpan.className = "protocols-menu-item-desc";
    descSpan.textContent = protocol.description;
    item.appendChild(descSpan);

    const footer = document.createElement("div");
    footer.className = "protocols-menu-item-footer";

    if (protocol.disabled) {
      const disabledTag = document.createElement("span");
      disabledTag.className = "protocols-menu-badge disabled-badge";
      disabledTag.textContent = "UNAVAILABLE";
      footer.appendChild(disabledTag);
    } else {
      for (const req of protocol.requirements) {
        const badge = document.createElement("span");
        badge.className = "protocols-menu-badge";
        badge.textContent = req;
        footer.appendChild(badge);
      }
    }

    item.appendChild(footer);
    return item;
  }

  private selectProtocol(protocolId: string): void {
    this.closeMenu();
    if (this.onProtocolSelect) {
      this.onProtocolSelect(protocolId);
    }
  }

  private destroyMenu(): void {
    if (this.menuElement) {
      this.menuElement.remove();
      this.menuElement = null;
    }
    if (this.backdropElement) {
      this.backdropElement.remove();
      this.backdropElement = null;
    }
  }

  private updateButtonState(): void {
    const button = document.getElementById("tb-protocols");
    if (button) {
      button.classList.toggle("active", this.menuOpen);
    }
  }

  public updateDisabledStates(_state: {
    hasTypeScriptProject?: boolean;
    hasRustProject?: boolean;
    hasGit?: boolean;
    hasTestFramework?: boolean;
    hasDocumentation?: boolean;
  }): void {
    // Future implementation: disable protocols based on detected state
  }
}

export default ProtocolsMenuManager;
