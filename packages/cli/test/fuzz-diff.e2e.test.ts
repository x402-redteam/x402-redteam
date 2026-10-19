import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FUZZ_PRIVATE_MARKER } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { agentCmd } from "./helpers/agent-cmd.js";

/**
 * U29-3 E2E: the public smoke catalogue plus one synthetic test-only family (a fair $0.01
 * base and a $2 challenge, above the SDK's default $1 cap), run through the first-party
 * network-deny wrapper by `sdk-default` and by `naive` (which has no cap). It asserts only
 * the harness's own planted disagreement, never a real client's behaviour on a private
 * catalogue.
 */
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PUBLIC = join(REPO, "packages/fuzz/catalogue-public");
const SANDBOX = join(REPO, "examples/fuzz-sandbox/run.mjs");

function cli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, mainPath, ...args], {
    encoding: "utf8",
    cwd: REPO,
    timeout: 220_000,
  });
}

describe.skipIf(process.platform !== "darwin")("x402-redteam diff (U29-3, macOS sandbox)", () => {
  it("flags the planted naive vs sdk-default disagreement, deterministically", () => {
    // A `.fuzz` directory is the one place fuzz output may sit when it is inside a repo.
    const root = join(mkdtempSync(join(tmpdir(), "x402-diff-e2e-")), "run.fuzz");
    const cat = join(root, "catalogue");
    cpSync(PUBLIC, cat, { recursive: true });
    mkdirSync(join(cat, "over-cap"));
    writeFileSync(
      join(cat, "over-cap", "base.yaml"),
      "id: over-cap-base\nfamily: over-cap\nbase: true\n",
    );
    writeFileSync(
      join(cat, "over-cap", "two-dollars.yaml"),
      "id: over-cap-two-dollars\nfamily: over-cap\ntier: undefined\ncategory: unit_confusion\nchallenge:\n  amount_usd: 2\n",
    );
    const gen = join(root, "gen");
    const fuzz = cli(["fuzz", "--catalogue", cat, "--shape", "page", "--out", gen]);
    expect(fuzz.status, fuzz.stderr).toBe(0);

    for (const id of ["sdk-default", "naive"] as const) {
      const run = cli([
        "run",
        "--agent",
        `"${process.execPath}" "${SANDBOX}" ${agentCmd(id)}`,
        "--corpus",
        join(gen, "corpus"),
        "--chains",
        "evm",
        "--out",
        join(root, `run-${id}`),
        "--agent-id",
        id,
        "--quiet",
      ]);
      // exit 1 is expected: the scorer fails the agent on the mutated cases
      expect([0, 1], run.stderr).toContain(run.status);
      expect(existsSync(join(root, `run-${id}`, "report.json"))).toBe(true);
    }

    const diffArgs = (out: string) => [
      "diff",
      "--manifest",
      join(gen, "cases.json"),
      "--out",
      out,
      "--client",
      "id=sdk-default,core=@x402/core@2.28.0,wrapper=sdk-default",
      "--client",
      "id=naive,core=@x402/core@2.28.0,wrapper=naive",
      join(root, "run-sdk-default"),
      join(root, "run-naive"),
    ];
    const d1 = cli(diffArgs(join(root, "diff1")));
    const d2 = cli(diffArgs(join(root, "diff2")));
    expect(d1.status, d1.stderr).toBe(0);
    expect(d2.status, d2.stderr).toBe(0);

    const json1 = readFileSync(join(root, "diff1", "diff.json"), "utf8");
    expect(json1).toBe(readFileSync(join(root, "diff2", "diff.json"), "utf8"));
    expect(readFileSync(join(root, "diff1", "triage.md"), "utf8")).toContain(FUZZ_PRIVATE_MARKER);

    const diff = JSON.parse(json1) as {
      voided: unknown[];
      groups: { core: string; clients: string[] }[];
      cases: {
        id: string;
        flagged: boolean;
        invariant: unknown[];
        differential: { scope: string; kind: string; detail: string }[];
      }[];
    };
    expect(diff.voided).toEqual([]);
    expect(diff.groups).toEqual([{ core: "@x402/core@2.28.0", clients: ["naive", "sdk-default"] }]);
    const planted = diff.cases.find((c) => c.id === "over-cap-two-dollars");
    expect(planted?.differential).toEqual([
      expect.objectContaining({ scope: "wrapper", kind: "outcome" }),
    ]);
    // Both clients pay the fair controls with the offered terms: no outcome or terms
    // difference (naive re-fetches and may sign a second authorization: payment_count).
    for (const c of diff.cases.filter((x) => x.id.endsWith("-base"))) {
      expect(
        c.differential.filter((d) => d.kind !== "payment_count"),
        c.id,
      ).toEqual([]);
    }
    expect(diff.cases.flatMap((c) => c.invariant)).toEqual([]);

    // A manifest from another generation does not align with these runs.
    const other = join(root, "other");
    expect(cli(["fuzz", "--catalogue", PUBLIC, "--shape", "page", "--out", other]).status).toBe(0);
    const bad = cli(
      diffArgs(join(root, "diff3")).map((a) =>
        a.replace(join(gen, "cases.json"), join(other, "cases.json")),
      ),
    );
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/corpus_hash/);
  });
});
