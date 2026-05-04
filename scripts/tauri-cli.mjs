#!/usr/bin/env node
/**
 * `package.json` points `pnpm tauri` here. For `tauri dev`, we merge
 * `build.devUrl` from PRISM_DEV_PORT so it always matches Vite (see vite.config.ts).
 * Other subcommands are forwarded to the real CLI unchanged.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriBin = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

const DEFAULT_DEV_PORT = 1420;

function loadDotEnv() {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

const args = process.argv.slice(2);

function runTauri(forwardArgs) {
  const child = spawn(process.execPath, [tauriBin, ...forwardArgs], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

if (args[0] === "dev") {
  loadDotEnv();
  const port = String(process.env.PRISM_DEV_PORT || DEFAULT_DEV_PORT).trim();
  const devUrl = `http://localhost:${port}`;
  const merge = JSON.stringify({ build: { devUrl } });
  runTauri(["dev", "-c", merge, ...args.slice(1)]);
} else {
  runTauri(args);
}
