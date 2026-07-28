#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const cliPath = resolve(root, "packages/agent-bus/src/cli.ts");
const args = process.argv.slice(2);
const isHook = args[0] === "hook";
// Mirrors the CLI's own resolution order so the opt-in check below looks at the
// same directory the CLI will use.
const busRoot = process.env.CODEX_AGENT_BUS_ROOT ?? root;

// The bus is opt-in: without a .coop directory the committed hooks stay inert,
// so cloning this repo does not start posting messages nobody asked for.
if (isHook && !existsSync(resolve(busRoot, ".coop"))) {
  process.exit(0);
}

let tsxCliPath;
try {
  tsxCliPath = require.resolve("tsx/cli");
} catch {
  if (isHook) process.exit(0);
  process.stderr.write("agent-bus: tsx is not installed; run pnpm install first\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsxCliPath, cliPath, ...args], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, CODEX_AGENT_BUS_ROOT: busRoot },
});

// A failing hook must never block the session that triggered it.
process.exit(isHook ? 0 : (result.status ?? 1));
