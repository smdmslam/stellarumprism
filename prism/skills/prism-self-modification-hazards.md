# Prism self-modification hazards
When the user is using Prism to fix or evolve **Prism itself** (i.e. the
checkout that the running app was built from), the agent runs into a
class of failure modes that don't apply to normal coding tasks. This
skill names the hazards and lists the four standard workarounds.

## When this skill applies
Trigger on any task whose target codebase is the Prism checkout that
the running Prism instance was launched from. Heuristic signals:

- The user's `cwd` matches the Prism source tree (e.g. `StellarumPrism`).
- The agent is being asked to edit `src/agent.ts`, `src/workspace.ts`,
  `src/agent-view.ts`, `src/styles.css`, `src-tauri/src/...`, or any
  file under the running app's source.
- The user mentions "fix Prism", "review the last commits", or hands
  the agent a fix-spec located in `docs/fixes/...` or `.prism/...`
  inside the same repo.

If the task is editing OTHER projects (StellarumAtlas, etc.), this
skill does not apply.

## Why this is hazardous

### 1. Hot-reload destroys session state mid-fix
Prism's frontend is built with Vite. Saving a file under `src/`
triggers HMR / a webview reload. The very agent doing the fix loses:

- the in-flight assistant turn
- the busy-pill state
- any pending tool-approval card
- scroll position in the agent panel
- the user's draft in the input bar

A fix that touches more than one file can ping-pong reloads and end up
in a half-applied state where the user can't tell what landed.

### 2. Syntax errors crash the host mid-edit
If the agent writes a partial change that compiles successfully on
file 1 but breaks on file 2, the WebView may render a blank screen
before the agent finishes the work. The user is stuck with no UI to
ask "what happened" and no way to undo from inside the app.

### 3. Shared state file collisions
Several state files are written by the running app:
- `.prism/state.json` (workspace layout, last_audit, last_build)
- localStorage (`prism-settings-v1`)
- saved chat markdown files under `.prism/...` and `~/Documents/Prism/Chats/`
- `session.json` (tab restore state)

The fix-agent might read or write these files at the same instant the
host app does. Last-writer-wins, no locking. Easy to corrupt.

### 4. Confused review subject
Reviewing recent commits while still actively making fixes means the
agent's later tool calls (`read_file`, `grep`) see a changed working
tree. Spec written at SHA A, fix applied, follow-up review reads
SHA B and contradicts the original spec. Hard to reason about.

### 5. Dogfood paradox
A self-fix that introduces a bug in the agent's own rendering pipeline
silently corrupts the agent's view of its own work. E.g. a bad change
to `agent-view.ts` may stop the agent from rendering its own response
to "did you just break the panel?" so the user sees nothing and the
agent thinks it succeeded.

## The four standard workarounds

### A. Two checkouts (RECOMMENDED DEFAULT)
Run a stable / installed Prism (the one used as the agent) against a
**separate working copy** of the source.

```bash path=null start=null
# the running Prism uses:
~/Applications/Prism.app    # or the production install

# the work happens in a checkout:
~/Development/StellarumPrism

# the agent edits files there. The running Prism never touches its
# own backing source, so HMR can't kill it.
```

Pros: cleanest separation; no special git plumbing; the running app
is unaffected by partial edits.

Cons: the user has to launch the stable Prism, not the dev one, and
remember which is which.

### B. Patch mode
Have the agent emit a unified diff (or a series of edits) to a file
under `docs/fixes/patches/`, never write source files directly. The
user applies with `git apply` after reviewing.

```bash path=null start=null
# agent writes:
docs/fixes/patches/2026.04.28-route-slash-output.patch

# user applies:
git apply docs/fixes/patches/2026.04.28-route-slash-output.patch
```

Pros: zero risk of partial state. The agent can produce a perfect
patch even from inside the running app, because it never touches the
source tree until the user opts in.

Cons: round-trip is slower; loses live verification; user has to
manage the apply step.

### C. Git worktree
Use git's worktree feature to materialize a parallel checkout the
agent edits, while the running app keeps using the primary tree.

```bash path=null start=null
# from the primary checkout:
git worktree add ../prism-fix HEAD

# the agent works in ../prism-fix, the user verifies + builds from
# there, then merges back to the primary tree when ready.
```

Pros: same git history, no clone bloat, atomic verification.

Cons: only works if the user is comfortable with worktrees;
build artifacts must be regenerated in the worktree.

### D. Locked review window
For pure review tasks (no edits), pin every tool call to the SHA the
review started against, instead of reading the working tree.

```bash path=null start=null
# instead of: read_file src/agent.ts
# the agent does: git show <pinned-sha>:src/agent.ts
```

Pros: the review is reproducible; the user can apply fixes in
parallel without invalidating the review subject.

Cons: only useful for reviews that don't need to edit; harder to set
up the read primitives.

## Decision table

| Task                                       | Use     |
| ------------------------------------------ | ------- |
| Pure code review of recent commits         | D       |
| Small, isolated bug fix in Prism           | A or B  |
| Multi-file refactor in Prism               | A       |
| Any task that requires running tests       | A or C  |
| Reviewer wants to verify across many SHAs  | D       |
| User explicitly wants the agent hands-off  | B       |

If the user hasn't expressed a preference: **default to A**. Two
checkouts is the lowest-friction safe option.

## Agent behavior when this skill triggers

1. **Announce up front** that the task is self-modification and ask
   which workaround the user prefers, OR confirm that the user is
   already running a stable Prism against a separate dev checkout.
2. **If editing in the same checkout the running app uses**, prefer
   patch mode (workaround B) and write a `.patch` file under
   `docs/fixes/patches/` instead of editing source directly. Do not
   silently rewrite source.
3. **Snapshot the SHA** before starting any review: record
   `git rev-parse HEAD` in the response so the user can return to the
   same baseline.
4. **Avoid touching state files** (`.prism/state.json`, localStorage)
   without the user's explicit go-ahead. They're hot under both the
   running app and the agent.
5. **Verify post-fix** that `pnpm typecheck`, `pnpm test`, and
   `pnpm build` all pass before concluding. A passing test suite is
   the only safe signal that the running app didn't break.
6. **Stage edits in dependency order** — the bottom of the import tree
   first, then up. A bad change to a leaf file is easier to recover
   from than a bad change to a root.

## Anti-patterns to refuse

- Editing `src/agent.ts` or `src/agent-view.ts` while the user has an
  active turn streaming in the same Prism instance.
- Running `pnpm dev` from inside the agent (creates a second running
  instance fighting for ports / state).
- Modifying `.prism/state.json` directly. Always go through the
  workspace's persistence layer.
- Self-fix passes that span more than ~5 files in one go without
  intermediate verification. Land in smaller commits, verify each.

## See also
- `docs/fixes/2026.04.28.recent-commits-loose-ends.md` — concrete
  example of fix work where this skill applies.
- `docs/fixes/2026.04.28.reviewer-methodology.md` — the methodology
  spec that motivated formalizing this hazard.
