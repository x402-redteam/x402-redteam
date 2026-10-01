#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Spawns `tsx src/main.ts`, mirroring packages/cli/bin/x402-redteam.mjs - the driver has
// no build step either; this keeps it runnable straight from source in dev and in CI.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const mainPath = resolve(__dirname, "..", "src", "main.ts");
const tsxCli = require.resolve("tsx/cli");

const result = spawnSync(process.execPath, [tsxCli, mainPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
