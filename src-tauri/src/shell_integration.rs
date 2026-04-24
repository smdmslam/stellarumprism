//! Shell integration.
//!
//! Writes a small ZDOTDIR to a temp location with:
//!   - `.zshrc`: a wrapper that sources the user's real `.zshrc` first, then
//!     layers Prism's OSC 133 hooks on top.
//!   - `prism.zsh`: the integration script itself (embedded at compile time).
//!
//! Callers pass the returned path as `ZDOTDIR` when spawning zsh.

use std::fs;
use std::path::PathBuf;

/// Embedded zsh integration script. See `shell-integration/prism.zsh`.
const PRISM_ZSH: &str = include_str!("../shell-integration/prism.zsh");

/// Wrapper `.zshrc` that runs from our ZDOTDIR.
///
/// Sources the user's real zshrc (so aliases, plugins, PATH etc. still apply)
/// and then sources Prism's integration script so our hooks append on top.
const ZSHRC_WRAPPER: &str = r#"# Prism ZDOTDIR wrapper .zshrc
# Source the user's real zshrc first so their environment is preserved.
if [ -f "$HOME/.zshrc" ]; then
  # Temporarily unset ZDOTDIR so user's zshrc doesn't recurse.
  __prism_saved_zdotdir="$ZDOTDIR"
  unset ZDOTDIR
  source "$HOME/.zshrc"
  export ZDOTDIR="$__prism_saved_zdotdir"
  unset __prism_saved_zdotdir
fi

# Then install Prism's OSC 133 hooks on top.
if [ -f "$ZDOTDIR/prism.zsh" ]; then
  source "$ZDOTDIR/prism.zsh"
fi
"#;

/// Create (or refresh) a Prism ZDOTDIR and return its path.
pub fn setup_zsh_zdotdir() -> std::io::Result<PathBuf> {
    let base = std::env::temp_dir().join("prism-zdotdir");
    fs::create_dir_all(&base)?;
    fs::write(base.join(".zshrc"), ZSHRC_WRAPPER)?;
    fs::write(base.join("prism.zsh"), PRISM_ZSH)?;
    Ok(base)
}
