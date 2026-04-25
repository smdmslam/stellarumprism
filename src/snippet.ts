// Pure helpers for the Problems-panel inline snippet viewer.
//
// The workspace calls `invoke('read_file_snippet', ...)` to fetch the
// slice from the Rust side, then passes the result to `renderSnippet`
// to produce HTML that drops straight into the panel. All string
// munging is unit-testable.

/** Shape the Rust `read_file_snippet` command returns. */
export interface FileSnippet {
  path: string;
  original: string;
  start_line: number;
  end_line: number;
  target_line: number;
  total_lines: number;
  content: string;
  truncated: boolean;
}

/**
 * Render a code snippet as HTML. Each source line becomes a table-like
 * grid row: `<line-number> | <code>`. The row whose absolute line
 * number equals `target_line` gets a `target` class the CSS highlights.
 *
 * All user-controlled text (file content, path) is HTML-escaped. The
 * rendered HTML is safe to `innerHTML=` on the panel element.
 */
export function renderSnippet(snippet: FileSnippet): string {
  const lines = snippet.content.split("\n");
  const rows: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNum = snippet.start_line + i;
    const isTarget = lineNum === snippet.target_line;
    rows.push(
      `<div class="snippet-row ${isTarget ? "target" : ""}">` +
        `<span class="snippet-lineno">${lineNum}</span>` +
        `<span class="snippet-code">${escapeHtml(lines[i])}</span>` +
        `</div>`,
    );
  }
  const range = `${snippet.start_line}\u2013${snippet.end_line} of ${snippet.total_lines}`;
  const truncatedNote = snippet.truncated
    ? `<span class="snippet-truncated">clipped</span>`
    : "";
  return (
    `<div class="snippet">` +
    `<div class="snippet-header">` +
    `<span class="snippet-path" title="${escapeAttr(snippet.path)}">${escapeHtml(
      snippet.path,
    )}</span>` +
    `<span class="snippet-range">${range}</span>` +
    truncatedNote +
    `</div>` +
    `<div class="snippet-body">${rows.join("")}</div>` +
    `</div>`
  );
}

/**
 * Render a fallback block when snippet loading fails. Keeps the row
 * expandable so the user sees why instead of a silently-empty state.
 */
export function renderSnippetError(message: string, path?: string): string {
  const pathLine = path
    ? `<div class="snippet-error-path">${escapeHtml(path)}</div>`
    : "";
  return (
    `<div class="snippet snippet-error">` +
    pathLine +
    `<div class="snippet-error-msg">${escapeHtml(message)}</div>` +
    `</div>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, " ");
}
