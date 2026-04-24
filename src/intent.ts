// Heuristic intent detection for the rich input editor.
//
// The output is advisory: it powers the little badge next to the input and
// (in Phase 5) determines whether a submission is routed to the shell PTY
// or to the LLM agent. A user can always override with a prefix toggle.

export type Intent = "command" | "agent";

/** Common CLI binaries that strongly imply "this is a command". */
const KNOWN_COMMANDS = new Set<string>([
  // core unix
  "ls", "cd", "pwd", "cat", "less", "more", "head", "tail", "grep", "rg",
  "find", "fd", "sed", "awk", "tr", "cut", "sort", "uniq", "wc", "tee",
  "cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod", "chown",
  "echo", "printf", "which", "whereis", "type", "man", "history", "alias",
  "export", "unset", "env", "source", "exit", "clear", "reset",
  "ps", "top", "htop", "kill", "killall", "pkill", "jobs", "bg", "fg",
  "df", "du", "free", "uptime", "uname", "who", "whoami", "id", "groups",
  // networking
  "curl", "wget", "ssh", "scp", "rsync", "ping", "traceroute", "dig", "nslookup",
  "netstat", "ifconfig", "ip", "host",
  // editors / pagers
  "vim", "nvim", "vi", "nano", "emacs", "code", "subl", "open",
  // vcs
  "git", "hg", "svn", "gh",
  // build / runtimes
  "make", "cmake", "cargo", "rustc", "rustup",
  "node", "npm", "pnpm", "yarn", "bun", "npx", "deno",
  "python", "python3", "pip", "pip3", "pipx", "poetry", "uv",
  "go", "gofmt", "ruby", "gem", "bundle", "rails",
  "java", "javac", "mvn", "gradle", "kotlin",
  "docker", "podman", "kubectl", "helm", "terraform", "ansible",
  // shells / multiplexers
  "bash", "zsh", "fish", "sh", "tmux", "screen",
  // misc tools
  "brew", "apt", "apt-get", "yum", "dnf", "pacman",
  "jq", "yq", "xargs", "watch", "tree", "tar", "zip", "unzip", "gzip", "gunzip",
]);

/** Verbs that strongly suggest a natural-language request. */
const QUESTION_STARTERS = new Set<string>([
  "how", "what", "why", "when", "where", "who", "which", "can",
  "could", "would", "should", "is", "are", "do", "does", "did",
  "explain", "tell", "show", "help", "write", "generate", "create",
  "fix", "refactor", "summarize", "translate", "convert", "build",
  "list", "describe", "analyze", "find", // 'find' is ambiguous - tiebreak below
]);

export interface IntentResult {
  intent: Intent;
  /** True if the user explicitly forced the intent (prefix or override). */
  explicit: boolean;
  /** Stripped text with any prefix removed \u2014 what to actually send. */
  payload: string;
}

/**
 * Classify input text. Order of precedence:
 *   1. Explicit `/ask ` or `?` prefix  -> agent (explicit)
 *   2. Explicit `/cmd ` prefix         -> command (explicit)
 *   3. Empty / whitespace-only          -> command (trivial default)
 *   4. Path-like first token           -> command
 *   5. Known CLI binary as first token -> command
 *   6. Ends with `?`                   -> agent
 *   7. First word is a question word AND input has >= 3 words -> agent
 *   8. Fallback                        -> command
 */
export function detectIntent(input: string): IntentResult {
  const text = input.replace(/\r\n?/g, "\n");
  const trimmed = text.trim();

  if (trimmed.startsWith("/ask ") || trimmed === "/ask") {
    return { intent: "agent", explicit: true, payload: trimmed.slice(4).trim() };
  }
  if (trimmed.startsWith("? ") || trimmed.startsWith("?")) {
    return { intent: "agent", explicit: true, payload: trimmed.replace(/^\?\s*/, "") };
  }
  if (trimmed.startsWith("/cmd ") || trimmed === "/cmd") {
    return { intent: "command", explicit: true, payload: trimmed.slice(4).trim() };
  }

  if (trimmed.length === 0) {
    return { intent: "command", explicit: false, payload: "" };
  }

  // @file references are an agent feature — if the user typed any, route to
  // the agent regardless of how the rest of the prompt looks. This avoids
  // the trap where `@/some/path.png` silently goes to the shell.
  if (/(?:^|\s)@(?:"[^"]*"|[A-Za-z0-9._~/+-]+)/.test(text)) {
    return { intent: "agent", explicit: false, payload: text };
  }

  // First token, with env-var assignments and leading `sudo` stripped.
  const firstToken = firstMeaningfulToken(trimmed);

  // Path-like: absolute path, home-relative, or cwd-relative.
  if (/^(\/|~\/|\.\/|\.\.\/)/.test(firstToken)) {
    return { intent: "command", explicit: false, payload: text };
  }

  if (KNOWN_COMMANDS.has(firstToken)) {
    return { intent: "command", explicit: false, payload: text };
  }

  // Ends with a question mark \u2192 natural language.
  if (/\?\s*$/.test(trimmed)) {
    return { intent: "agent", explicit: false, payload: text };
  }

  const words = trimmed.split(/\s+/);
  const firstWordLower = words[0].toLowerCase();

  // Question-starter word + multi-word sentence looks English.
  if (QUESTION_STARTERS.has(firstWordLower) && words.length >= 3) {
    return { intent: "agent", explicit: false, payload: text };
  }

  // English-prose heuristic: 4+ words, no shell metacharacters, doesn't
  // start with a known command — almost certainly natural language rather
  // than an invocation of some binary we don't know about.
  const hasShellOps = /[|<>$`\\]|&&|\|\|/.test(trimmed);
  const looksLikeEnglish =
    words.length >= 4 &&
    !hasShellOps &&
    !KNOWN_COMMANDS.has(firstToken) &&
    !/^[-@/.]/.test(firstToken);
  if (looksLikeEnglish) {
    return { intent: "agent", explicit: false, payload: text };
  }

  // Default: assume the user is typing a (possibly unfamiliar) command.
  return { intent: "command", explicit: false, payload: text };
}

function firstMeaningfulToken(s: string): string {
  // Strip leading `sudo` and KEY=VALUE env assignments the way the shell would.
  const tokens = s.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "sudo" || t === "time" || t === "nohup") {
      i++;
      continue;
    }
    if (/^[A-Z_][A-Z0-9_]*=/i.test(t)) {
      i++;
      continue;
    }
    return t;
  }
  return tokens[0] ?? "";
}
