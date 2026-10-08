/**
 * The path classifier behind ci.yml's `changes` job (ADR-018 §1): a pull request runs the
 * E2E shards and the self-test matrix only when it touches a runtime path.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify, isRuntimePath } from "../../../scripts/ci-changes.mjs";

const SCRIPT = fileURLToPath(new URL("../../../scripts/ci-changes.mjs", import.meta.url));

describe("isRuntimePath", () => {
  it.each([
    "packages/cli/src/run.ts",
    "packages/schema/package.json",
    "corpus/attacks/prose-lure.yaml",
    "examples/agents/src/naive.ts",
    "examples/agents-py/agent.py",
    "action.yml",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
    ".github/workflows/self-test.yml",
    "package.json",
    "pnpm-workspace.yaml",
    "vitest.config.ts",
    ".node-version",
    "tsconfig.json",
    "tsconfig.base.json",
    "scripts/ci-changes.mjs",
  ])("%s is a runtime path", (path) => {
    expect(isRuntimePath(path)).toBe(true);
  });

  it.each([
    "README.md",
    "docs/guide.md",
    "aidlc-docs/audit.md",
    "LEADERBOARD.md",
    "results/some-guardrail.json",
    ".github/workflows/nightly.yml",
    ".github/workflows/rank.yml",
    "packages.md",
    "corpus.txt",
    "subdir/packages/cli/src/run.ts",
    "action.yml.bak",
    "packages.json",
    "docs/tsconfig.json",
    "docs/package.json",
    "tsconfig.json.bak",
    "scripts/other.mjs",
    "",
  ])("%s is not a runtime path", (path) => {
    expect(isRuntimePath(path)).toBe(false);
  });

  it("accepts a leading ./", () => {
    expect(isRuntimePath("./packages/cli/src/run.ts")).toBe(true);
  });
});

describe("classify", () => {
  it("is true when any listed path is a runtime path", () => {
    expect(classify(["README.md", "packages/cli/src/run.ts"])).toBe(true);
  });

  it("is false for docs-only changes", () => {
    expect(classify(["README.md", "aidlc-docs/audit.md"])).toBe(false);
  });

  it("is true for a file moved out of packages/ (both sides of the rename are listed)", () => {
    // `git diff --no-renames --name-only` lists a rename as a deletion plus an addition.
    expect(classify(["docs/old-run.ts", "packages/cli/src/old-run.ts"])).toBe(true);
  });

  it("is false for an empty change list", () => {
    expect(classify([])).toBe(false);
  });
});

describe("ci-changes.mjs CLI", () => {
  function runCli(input: string) {
    return spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8" });
  }

  it("prints runtime=true for a runtime change read from stdin", () => {
    const result = runCli("README.md\npackages/cli/src/run.ts\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("runtime=true\n");
  });

  it("prints runtime=false for docs-only changes", () => {
    const result = runCli("README.md\ndocs/guide.md\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("runtime=false\n");
  });

  it("prints runtime=false for empty input", () => {
    const result = runCli("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("runtime=false\n");
  });
});
