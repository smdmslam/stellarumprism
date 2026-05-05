#!/usr/bin/env node
/**
 * Fails CI if known-dangerous bootstrap patterns reappear (blank-shell regressions).
 * See docs/BOOTSTRAP.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

function walkTsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

let errors = 0;

function fail(msg) {
  console.error(msg);
  errors += 1;
}

const files = walkTsFiles(srcDir);

for (const file of files) {
  const rel = file.slice(root.length + 1);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  // Never ship eager ReaderUI singleton export again.
  if (/export\s+const\s+readerUI\s*=\s*new\s+ReaderUI\s*\(/u.test(text)) {
    fail(`${rel}: forbidden — export const readerUI = new ReaderUI(); use getReaderUI() only`);
  }

  lines.forEach((line, idx) => {
    const n = idx + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

    if (line.includes("new ReaderUI(")) {
      const okFile = rel.replace(/\\/g, "/").endsWith("src/reader-ui.ts");
      if (!okFile) {
        fail(`${rel}:${n}: new ReaderUI() only allowed in src/reader-ui.ts (inside getReaderUI)`);
      }
    }
  });
}

if (errors > 0) {
  console.error(`\ncheck-bootstrap-invariants: ${errors} violation(s). See docs/BOOTSTRAP.md`);
  process.exit(1);
}

console.log("check-bootstrap-invariants: ok");
