import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 *
 * The second describe is the `mcp` leg (U30-4, delta §2.6). It is built but OFF: it runs only
 * with FUZZ_SMOKE_MCP=1, which no workflow sets, and the ci.yml step that sets it is
 * `if: false`. `mcp-sdk-default` is a new client for the public families, and GOVERNANCE.md
 * keeps a family private until its first triage across all clients closes, so the leg is
 * enabled only after a private triage of the 4 public cases. It asserts alignment only: no
 * refusal, and cases run equal the manifest's cases for the mcp shape. A failure prints a
 * refusal reason and counts, never agent or tool output and never an oracle count.
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

/**
 * The `@x402/core` an MCP client loads: the one `@x402/mcp` resolves (its sibling in the
 * package store), not the one `examples/agents` lists. `@x402/mcp>@x402/core` is pinned
 * exactly by an override, so a lockfile refresh cannot split the two without this changing.
 */
function installedMcpCore(): string {
  const mcp = realpathSync(join(REPO, "examples/agents/node_modules/@x402/mcp"));
  const pkg = JSON.parse(readFileSync(join(mcp, "..", "core", "package.json"), "utf8")) as {
    version: string;
  };
  return `@x402/core@${pkg.version}`;
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

/** The first line of a diff refusal, which names reasons and counts and never a case id. */
function refusalReason(stderr: string): string {
  return (stderr.split("\n").find((l) => l.trim() !== "") ?? "").slice(0, 200);
}

describe.skipIf(process.platform !== "darwin" || process.env.FUZZ_SMOKE_MCP !== "1")(
  "fuzz smoke, mcp leg (U30-4, disabled until the private triage of the public cases)",
  () => {
    it("aligns a page run and an mcp run of the public catalogue", () => {
      const root = join(mkdtempSync(join(tmpdir(), "x402-smoke-mcp-")), "run.fuzz");
      mkdirSync(root, { recursive: true });
      try {
        const pageGen = join(root, "gen-page");
        const mcpGen = join(root, "gen-mcp");
        for (const [shape, out] of [
          ["page", pageGen],
          ["mcp", mcpGen],
        ] as const) {
          const fuzz = cli(["fuzz", "--catalogue", PUBLIC, "--shape", shape, "--out", out]);
          expect(fuzz.status, `fuzz ${shape} exit ${fuzz.status}`).toBe(0);
        }
        const clients = [
          ["ts-sdk", "sdk-default", join(pageGen, "corpus"), installedCore()],
          ["mcp-sdk-default", "mcp-sdk-default", join(mcpGen, "corpus-mcp"), installedMcpCore()],
        ] as const;
        for (const [id, script, corpus] of clients) {
          const run = cli([
            "run",
            "--agent",
            `"${process.execPath}" "${SANDBOX}" ${agentCmd(script)}`,
            "--corpus",
            corpus,
            "--chains",
            "evm",
            "--out",
            join(root, `run-${id}`),
            "--agent-id",
            script,
            "--quiet",
          ]);
          // Never print the run's stderr or stdout: they hold agent and tool output.
          expect([0, 1], `run ${id} exit ${run.status}`).toContain(run.status);
          expect(existsSync(join(root, `run-${id}`, "report.json")), `${id} report`).toBe(true);
        }
        const diff = cli([
          "diff",
          "--manifest",
          join(pageGen, "cases.json"),
          "--out",
          join(root, "diff"),
          ...clients.flatMap(([id, script, , core]) => [
            "--client",
            `id=${id},core=${core},wrapper=${script}`,
          ]),
          ...clients.map(([id]) => join(root, `run-${id}`)),
        ]);
        expect(diff.status, `diff refused: ${refusalReason(diff.stderr)}`).toBe(0);

        const manifest = JSON.parse(readFileSync(join(pageGen, "cases.json"), "utf8")) as {
          cases: { shapes?: string[] }[];
        };
        const result = JSON.parse(readFileSync(join(root, "diff", "diff.json"), "utf8")) as {
          clients: { id: string; shape: string; cases_run: number; missing_cases: number }[];
        };
        const mcp = result.clients.find((c) => c.id === "mcp-sdk-default");
        const expected = manifest.cases.filter((c) => (c.shapes ?? []).includes("mcp")).length;
        // Counts only: cases run for the mcp shape against the manifest's.
        expect(
          { shape: mcp?.shape, cases_run: mcp?.cases_run, missing_cases: mcp?.missing_cases },
          `mcp cases run (manifest has ${expected})`,
        ).toEqual({ shape: "mcp", cases_run: expected, missing_cases: 0 });
      } finally {
        rmSync(dirname(root), { recursive: true, force: true });
      }
    });
  },
);
