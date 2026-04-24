# Prism shell integration for zsh.
#
# Emits OSC 133 semantic prompt sequences so the Prism UI can segment the
# output stream into blocks. Also emits a custom OSC 1337 sequence
# (PrismCmd=<base64>) right before a command runs so the UI can display the
# exact command text in its block chrome without guessing from the buffer.

# --- OSC helpers --------------------------------------------------------------

__prism_osc133_a() { printf '\e]133;A\a' }   # prompt start
__prism_osc133_b() { printf '\e]133;B\a' }   # prompt end / user-input start
__prism_osc133_c() { printf '\e]133;C\a' }   # command output start
__prism_osc133_d() { printf '\e]133;D;%s\a' "$1" }  # command finished, with exit

# OSC 7: report current working directory to the host terminal.
# Standard format is \e]7;file://HOSTNAME/ABSOLUTE/PATH\a where the path is
# URL-encoded. We keep it simple and just send the raw path — the Prism
# frontend handles percent-decoding for safety.
__prism_osc7() {
  printf '\e]7;file://%s%s\a' "${HOST:-${HOSTNAME:-localhost}}" "$PWD"
}

# base64-encoded so control characters and newlines in the command are safe.
__prism_cmd() {
  local encoded
  encoded=$(printf '%s' "$1" | base64 | tr -d '\n')
  printf '\e]1337;PrismCmd=%s\a' "$encoded"
}

# --- zsh hooks ---------------------------------------------------------------

# Runs AFTER a command finishes, BEFORE the next prompt is rendered.
__prism_precmd() {
  local ec=$?
  __prism_osc133_d "$ec"
  __prism_osc7
  __prism_osc133_a
}

# Runs AFTER the user submits a command, BEFORE it executes.
__prism_preexec() {
  __prism_cmd "$1"
  __prism_osc133_c
}

# Append to hook arrays so user-defined hooks aren't clobbered.
autoload -Uz add-zsh-hook 2>/dev/null || true
if typeset -f add-zsh-hook >/dev/null 2>&1; then
  add-zsh-hook precmd  __prism_precmd
  add-zsh-hook preexec __prism_preexec
else
  precmd_functions+=(__prism_precmd)
  preexec_functions+=(__prism_preexec)
fi

# Wrap the existing PS1 with the OSC 133;B (prompt-end) marker so the UI knows
# where the prompt display ends and user input begins. %{...%} tells zsh to
# skip these bytes when calculating prompt width.
PS1="${PS1}%{$(__prism_osc133_b)%}"

# Fire a prompt-start marker immediately so the initial shell banner is
# attributable to a "startup" block rather than the first user command.
__prism_osc133_a
# Also report the initial cwd so the UI isn't blank until the next prompt.
__prism_osc7
