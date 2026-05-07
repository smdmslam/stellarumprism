# Cosmetics backlog

This file keeps only the UI/cosmetic items from the old `xterm-cosmetics.md`
that are still not implemented.

## Still open

- [ ] **Phase grouping / collapsible turn blocks**
  - Wrap each agent turn into a single collapsible `Worked for Ns` block.
  - Collapse tool logs by default and reveal on click.
  - Note: this now belongs to the **AgentView / DOM surface**, not xterm.

- [ ] **Richer collapsible tool cards**
  - Keep the existing one-line tool cards as the baseline.
  - Add richer visual chrome, collapsibility, and optional expanded detail.
  - Note: basic tool cards already exist; this item is about making them more interactive/polished.

- [ ] **Rounded fenced code-block cards / HTML overlay treatment**
  - Render fenced assistant code blocks as more intentional card-like UI.
  - This is a DOM/AgentView concern, not an xterm concern.

- [ ] **`git status` ghost-changes bug investigation**
  - Investigate the earlier report: Prism changed a file, but a later status check claimed there were no changes.
  - Likely causes to repro/check:
    1. wrong cwd during git invocation
    2. race between file write completion and status check
    3. file path resolved outside repo

## Explicitly removed from the old file

These were already implemented or superseded by the agent-panel migration and
should not be tracked here anymore:

- Files Modified footer
- "Worked for Ns" / done footer
- Tool result size pill
- Markdown heading + bullet rendering as an xterm task
- Card-style tool rendering as an xterm task
- Resizable layout backlog items
- Inline code coloring
- Shell-only xterm as the primary agent rendering surface
