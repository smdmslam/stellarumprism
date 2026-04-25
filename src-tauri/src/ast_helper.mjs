#!/usr/bin/env node
// Prism substrate v2: AST helper.
//
// Spawned by the Rust side to answer structural questions about a
// TypeScript project that grep cannot reliably answer:
//   - Does symbol X resolve at file:line? Where is it declared?
//   - (future) What are the imports of file Y? The exports?
//   - (future) Who calls function Z?
//
// Single-shot per invocation: reads ONE JSON query from `--query=<json>`,
// writes ONE JSON result to stdout, exits. No daemon, no caching across
// runs. Cold start on a small project is ~1-2s; acceptable for v1.
//
// The script depends on the user's project's `typescript` install
// (TypeScript is the only compiler that authoritatively answers symbol
// resolution under the project's actual config). The Rust caller sets
// `NODE_PATH=<project>/node_modules` so `import * as ts from "typescript"`
// resolves to the project's version.
//
// Output contract:
//   { ok: true,  ...op-specific-fields }   on success
//   { ok: false, error: "<reason>" }       on every other case
// The caller treats `ok=false` as a clean substrate failure (no Finding
// produced); the LLM may neither cite this query nor invent a result.
import * as ts from "typescript";
import * as path from "node:path";

function main() {
  const queryArg = process.argv.find((a) => a.startsWith("--query="));
  if (!queryArg) {
    write({ ok: false, error: "missing --query=<json>" });
    process.exit(2);
  }
  let query;
  try {
    query = JSON.parse(queryArg.slice("--query=".length));
  } catch (e) {
    write({ ok: false, error: `invalid JSON in --query: ${e.message}` });
    process.exit(2);
  }
  if (!query || typeof query.op !== "string") {
    write({ ok: false, error: "query must be an object with a string `op` field" });
    process.exit(2);
  }

  // Locate tsconfig.json starting from cwd, walking up. Without one we
  // can't build a real Program — bail clean.
  const tsconfigPath = ts.findConfigFile(
    process.cwd(),
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!tsconfigPath) {
    write({
      ok: false,
      error: "no tsconfig.json found walking up from cwd",
    });
    process.exit(2);
  }

  const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (cfg.error) {
    write({
      ok: false,
      error: `failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n")}`,
    });
    process.exit(2);
  }
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  if (parsed.errors.length > 0) {
    write({
      ok: false,
      error: `tsconfig parse errors: ${parsed.errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
        .join(" | ")}`,
    });
    process.exit(2);
  }

  // Build a Program covering every file the user's tsconfig includes.
  // For v1 we always build the full program; later versions can scope
  // down to the requested file's transitive deps for speed.
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  switch (query.op) {
    case "resolve": {
      const result = resolveSymbol(program, checker, query);
      write(result);
      break;
    }
    default:
      write({ ok: false, error: `unknown op: ${query.op}` });
      process.exit(2);
  }
}

/**
 * Resolve `query.symbol` as visible at `query.file[:query.line]`. Uses
 * the type checker's `resolveName`, which walks the actual scope chain
 * — the same logic tsc uses to decide whether `foo` in `<Bar foo={foo} />`
 * is a valid binding.
 *
 * Returns one of:
 *   - resolved=true with a `declaration: { file, line, kind }` slot
 *     (single primary declaration) when the symbol is bound somewhere.
 *   - resolved=false when the type checker says the symbol is not in
 *     scope. This is the deterministic answer grep cannot give.
 *
 * Either way an `evidence_detail` string is included so the LLM can
 * paste it into a Finding's `evidence: source=ast; detail=<...>` line
 * verbatim. The caller does not invent the detail.
 */
function resolveSymbol(program, checker, query) {
  if (typeof query.symbol !== "string" || query.symbol.length === 0) {
    return { ok: false, error: "resolve op requires `symbol`: string" };
  }
  if (typeof query.file !== "string" || query.file.length === 0) {
    return { ok: false, error: "resolve op requires `file`: string" };
  }

  // Resolve the user-supplied path against cwd so tsc finds it whether
  // they passed a relative or absolute path.
  const filePath = path.isAbsolute(query.file)
    ? query.file
    : path.resolve(process.cwd(), query.file);
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) {
    return {
      ok: false,
      error: `file not in tsconfig program: ${query.file} (resolved: ${filePath})`,
    };
  }

  // Find the deepest enclosing node at the requested line so the type
  // checker resolves `query.symbol` in that lexical scope. If no line
  // is given, resolve at file scope.
  let scopeNode = sourceFile;
  if (typeof query.line === "number" && query.line >= 1) {
    const lineIdx = query.line - 1;
    if (lineIdx < sourceFile.getLineStarts().length) {
      const lineStart = sourceFile.getPositionOfLineAndCharacter(lineIdx, 0);
      const found = findDeepestNodeAtPos(sourceFile, lineStart);
      if (found) scopeNode = found;
    }
  }

  const flags = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace;
  const symbol = checker.resolveName(
    query.symbol,
    scopeNode,
    flags,
    /*excludeGlobals*/ false,
  );
  const locTag = query.line ? `${query.file}:${query.line}` : query.file;

  if (!symbol) {
    return {
      ok: true,
      op: "resolve",
      resolved: false,
      symbol: query.symbol,
      file: query.file,
      line: query.line ?? null,
      declaration: null,
      evidence_detail: `ast: '${query.symbol}' is NOT visible in scope at ${locTag} (tsc resolveName returned undefined under the project's tsconfig)`,
    };
  }

  const decls = symbol.declarations || [];
  if (decls.length === 0) {
    return {
      ok: true,
      op: "resolve",
      resolved: true,
      symbol: query.symbol,
      file: query.file,
      line: query.line ?? null,
      declaration: null,
      evidence_detail: `ast: '${query.symbol}' resolves but has no declaration node (likely an ambient binding)`,
    };
  }

  // Pick the first declaration as primary. Multi-declaration symbols
  // (overloads, merged interfaces) have legitimate multiple sites; for
  // v1 we just report the first and include the count in the detail.
  const primary = decls[0];
  const declSource = primary.getSourceFile();
  const { line: declLine0 } = declSource.getLineAndCharacterOfPosition(
    primary.getStart(),
  );
  const declRel = path.relative(process.cwd(), declSource.fileName) || declSource.fileName;
  const kind = ts.SyntaxKind[primary.kind] || `kind=${primary.kind}`;
  const multi =
    decls.length > 1 ? ` (${decls.length} declarations total)` : "";
  return {
    ok: true,
    op: "resolve",
    resolved: true,
    symbol: query.symbol,
    file: query.file,
    line: query.line ?? null,
    declaration: {
      file: declRel,
      line: declLine0 + 1,
      kind,
    },
    evidence_detail: `ast: '${query.symbol}' declared at ${declRel}:${declLine0 + 1} (${kind})${multi}`,
  };
}

/** Walk down the AST to find the deepest node whose span contains pos. */
function findDeepestNodeAtPos(node, pos) {
  if (pos < node.getStart() || pos > node.getEnd()) return null;
  // Children walk from leaves up. We want the deepest match, so iterate
  // children and recurse first; only return the parent if no child hit.
  let deepest = null;
  for (const child of node.getChildren()) {
    const hit = findDeepestNodeAtPos(child, pos);
    if (hit) deepest = hit;
  }
  return deepest || node;
}

function write(obj) {
  // One line of JSON, no trailing newline. The Rust side parses stdout
  // verbatim, so keep this simple.
  process.stdout.write(JSON.stringify(obj));
}

main();
