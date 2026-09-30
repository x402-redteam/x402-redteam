import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../src/spawn.js";

describe("runAgent", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "x402-redteam-spawn-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("reports the exit code and captures stdout/stderr", async () => {
    const logFile = join(outDir, "run.log");
    const result = await runAgent({
      cmd: "echo out-line; echo err-line 1>&2; exit 7",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
      logFile,
    });

    expect(result.exit_code).toBe(7);
    expect(result.timed_out).toBe(false);
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("out-line");
    expect(log).toContain("err-line");
  });

  it("kills a hung process group within ~2.5s of the timeout", async () => {
    const logFile = join(outDir, "hung.log");
    const start = performance.now();
    // Ignores SIGTERM so the harness must fall through to SIGKILL after the 2s grace period.
    const result = await runAgent({
      cmd: "trap '' TERM; sleep 30",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 200,
      logFile,
    });
    const elapsed = performance.now() - start;

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).not.toBe(0);
    // 200ms to SIGTERM + 2000ms grace to SIGKILL, plus scheduling slack.
    expect(elapsed).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThan(1900);
  });
});
