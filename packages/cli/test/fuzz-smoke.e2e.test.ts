import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FUZZ_PRIVATE_MARKER } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { agentCmd } from "./helpers/agent-cmd.js";

/**
 * U29-4 CI smoke run (ADR-028 #7). Generates from the public smoke catalogue only, runs
 * `sdk-default` through the first-party network-deny wrapper, diffs it as a single `ts-sdk`
 * client and compares `diff.json` byte for byte with a committed golden. A mismatch prints
 * counts only. `UPDATE_GOLDEN=1` rewrites the golden (after an `@x402/*` bump; see
 * examples/fuzz-sandbox/README.md). It fails closed: if the wrapper finds no sandbox
 * (exit 2) the test fails, it never skips on macOS.
 */
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PUBLIC = join(REPO, "packages/fuzz/catalogue-public");
const SANDBOX = join(REPO, "examples/fuzz-sandbox/run.mjs");
const GOLDEN = join(REPO, "packages/fuzz/test/golden/smoke-diff.json");

function cli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, mainPath, ...args], {
    encoding: "utf8",
    cwd: REPO,
    timeout: 220_000,
  });
}

/** The installed `@x402/core` version, read from the package `sdk-default` loads. */
function installedCore(): string {
  const manifest = join(REPO, "examples/agents/node_modules/@x402/core/package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  return `@x402/core@${pkg.version}`;
}

/**
 * diff.json is stamped with the private marker (the repo's fuzz guard refuses any .json
 * carrying it outside the public catalogue). The golden is stored without it, so drop it
 * before comparing. Everything else in diff.json is already free of absolute paths,
 * timestamps and machine data, so nothing else is normalised.
 */
function normalise(text: string): string {
  const obj = JSON.parse(text) as Record<string, unknown>;
  delete obj[FUZZ_PRIVATE_MARKER];
  return `${JSON.stringify(obj, null, 2)}\n`;
}

interface Counts {
  cases: number;
  flagged: number;
  invariant: number;
  voided: number;
}

function countsOf(text: string): Counts {
  const c = (JSON.parse(text) as { counts: Counts }).counts;
  return { cases: c.cases, flagged: c.flagged, invariant: c.invariant, voided: c.voided };
}

describe.skipIf(process.platform !== "darwin")("fuzz smoke (U29-4, macOS sandbox)", () => {
  it("matches the committed golden diff.json for the public catalogue", () => {
    // A `.fuzz` directory is the one place fuzz output may sit when it is inside a repo.
    const root = join(mkdtempSync(join(tmpdir(), "x402-smoke-e2e-")), "run.fuzz");
    mkdirSync(root, { recursive: true });
    try {
      const gen = join(root, "gen");
      const fuzz = cli(["fuzz", "--catalogue", PUBLIC, "--shape", "page", "--out", gen]);
      expect(fuzz.status, fuzz.stderr).toBe(0);

      const run = cli([
        "run",
        "--agent",
        `"${process.execPath}" "${SANDBOX}" ${agentCmd("sdk-default")}`,
        "--corpus",
        join(gen, "corpus"),
        "--chains",
        "evm",
        "--out",
        join(root, "run"),
        "--agent-id",
        "sdk-default",
        "--quiet",
      ]);
      // exit 1 is expected: the scorer fails the agent on the mutated cases. A wrapper
      // with no sandbox exits 2; that fails the test, it never skips.
      expect([0, 1], run.stderr).toContain(run.status);
      expect(existsSync(join(root, "run", "report.json"))).toBe(true);

      const diff = cli([
        "diff",
        "--manifest",
        join(gen, "cases.json"),
        "--out",
        join(root, "diff"),
        "--client",
        `id=ts-sdk,core=${installedCore()},wrapper=sdk-default`,
        join(root, "run"),
      ]);
      expect(diff.status, diff.stderr).toBe(0);

      const actual = normalise(readFileSync(join(root, "diff", "diff.json"), "utf8"));
      if (process.env.UPDATE_GOLDEN === "1") {
        writeFileSync(GOLDEN, actual);
        return;
      }
      const expected = readFileSync(GOLDEN, "utf8");
      if (actual !== expected) {
        // Counts only: never case contents or a diff of the JSON.
        expect.fail(
          `smoke diff.json differs from the golden\nexpected: ${JSON.stringify(countsOf(expected))}\nactual:   ${JSON.stringify(countsOf(actual))}`,
        );
      }
    } finally {
      rmSync(dirname(root), { recursive: true, force: true });
    }
  });
});
