// Classifies a pull request's changed files for ci.yml's `changes` job (ADR-018 §1).
// The E2E shards and the self-test matrix run only when a runtime path changes.
//
// CLI: reads one path per line on stdin (`git diff --name-only` output) and prints
// `runtime=true` or `runtime=false`, ready to append to $GITHUB_OUTPUT. Runtime paths
// found are listed on stderr. No dependencies, so it runs on the runner's own node.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUNTIME_PREFIXES = ["packages/", "corpus/", "examples/"];
/** Third-party adapters (U25, ADR-028/029) sit outside the workspace and CI and run only
 * by hand, so changing one never needs the heavy suites. */
const NON_RUNTIME_PREFIXES = ["examples/third-party/"];
const RUNTIME_FILES = new Set([
  "action.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  ".node-version",
  ".github/workflows/ci.yml",
  ".github/workflows/self-test.yml",
  "scripts/ci-changes.mjs",
]);
/** Root-level TypeScript configs: tsconfig.json, tsconfig.base.json, ... */
const ROOT_TSCONFIG = /^tsconfig(\.[^/]+)?\.json$/;

/** True when a change to this repo-relative path must run the heavy suites. */
export function isRuntimePath(path) {
  const p = path.startsWith("./") ? path.slice(2) : path;
  if (NON_RUNTIME_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  return (
    RUNTIME_FILES.has(p) ||
    ROOT_TSCONFIG.test(p) ||
    RUNTIME_PREFIXES.some((prefix) => p.startsWith(prefix))
  );
}

/** True when any of the paths is a runtime path. */
export function classify(paths) {
  return paths.some(isRuntimePath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const runtime = paths.filter(isRuntimePath);
  for (const path of runtime) process.stderr.write(`runtime path: ${path}\n`);
  process.stdout.write(`runtime=${runtime.length > 0}\n`);
}
