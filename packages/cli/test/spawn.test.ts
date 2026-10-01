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
  it("does not start the run clock until the agent has started (startup grace)", async () => {
    // Boots for 1.2 s, then "starts" and finishes 0.5 s later. With a 1 s run timeout this
    // would be killed without the grace; with it the run clock only starts at first request.
    let started = false;
    setTimeout(() => {
      started = true;
    }, 1200);
    const result = await runAgent({
      cmd: "sleep 1.7; exit 0",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 1000,
      startupTimeoutMs: 5000,
      hasStarted: () => started,
      logFile: join(outDir, "slow-start.log"),
    });
    expect(result.timed_out).toBe(false);
    expect(result.exit_code).toBe(0);
  });

  it("kills an agent that never makes a request within the startup timeout", async () => {
    const start = performance.now();
    const result = await runAgent({
      cmd: "sleep 30",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 60_000,
      startupTimeoutMs: 500,
      hasStarted: () => false,
      logFile: join(outDir, "never-starts.log"),
    });
    expect(result.timed_out).toBe(true);
    expect(performance.now() - start).toBeLessThan(3500);
  });

  it("still enforces the run timeout once the agent has started", async () => {
    const result = await runAgent({
      cmd: "sleep 30",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 500,
      startupTimeoutMs: 60_000,
      hasStarted: () => true,
      logFile: join(outDir, "started-hung.log"),
    });
    expect(result.timed_out).toBe(true);
  });
});
