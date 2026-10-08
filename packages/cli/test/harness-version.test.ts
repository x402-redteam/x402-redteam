import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSuite } from "../src/run.js";
import { HARNESS_VERSION } from "../src/version.js";

const ROOT_VERSION = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const FIXTURE_CORPUS = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));

async function reportVersion(harnessVersion?: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "x402-harness-version-"));
  try {
    const { report } = await runSuite({
      agentCmd: "true",
      corpus: FIXTURE_CORPUS,
      scenarioIds: ["prose-lure"],
      chains: ["evm"],
      repeat: 1,
      timeoutMs: 5_000,
      startupTimeoutMs: 5_000,
      seed: "x402-redteam-v1",
      outDir,
      agentId: "a",
      guardrailId: "none",
      failOn: "low",
      harnessCommit: "0".repeat(40),
      ...(harnessVersion === undefined ? {} : { harnessVersion }),
    });
    return report.harness_version;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe("harness_version", () => {
  it("HARNESS_VERSION is the root package.json version", () => {
    expect(HARNESS_VERSION).toBe(ROOT_VERSION);
  });

  it("a report carries the root version by default", async () => {
    expect(await reportVersion()).toBe(ROOT_VERSION);
  });

  it("an explicit harnessVersion overrides the default", async () => {
    expect(await reportVersion("9.9.9")).toBe("9.9.9");
  });
});
