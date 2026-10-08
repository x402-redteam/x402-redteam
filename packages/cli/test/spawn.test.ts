import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RESERVED_AGENT_UIDS,
  killAgentUidProcesses,
  runAgent,
  scrubSecretsFromLog,
  validateAgentUid,
} from "../src/spawn.js";

/** Security review HIGH-4: `execFileSync` (what `killAgentUidProcesses` calls) and
 * `spawn` are mocked file-wide (both default to the real implementation) so
 * `runAgent`'s own post-run sweep can be observed without a real `pkill` call, and
 * without actually needing root to exercise the `agentUid` code path (a real
 * `spawn({uid})` on a non-root dev machine throws EPERM before `finish()` ever runs). */
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) };
});

/** A minimal stand-in child process: no real OS process, just an `EventEmitter` that
 * emits a successful `close` shortly after creation - enough for `runAgent` to reach
 * its normal completion path (`finish()`) without ever calling the real `spawn`. */
class FakeChild extends EventEmitter {
  pid = 424242;
  stdout = null;
  stderr = null;
}

/** `process.kill(pid, 0)` sends no signal and only checks whether `pid` exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

  it("kills a background child left in the agent's own process group after a normal (non-timeout) exit", async () => {
    const logFile = join(outDir, "bg-child.log");
    // A non-interactive `sh -c` script has no job control, so this background job stays
    // in the same process group as the script itself rather than starting its own - the
    // case the group signal on a normal exit (not only on a timeout) is meant to reach.
    const result = await runAgent({
      cmd: "sleep 30 >/dev/null 2>&1 & echo $!; exit 0",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
      logFile,
    });

    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);

    const childPid = Number(readFileSync(logFile, "utf8").trim());
    expect(childPid).toBeGreaterThan(0);

    // The group signal `finish()` sends on every exit path is fire-and-forget (it must
    // not add wall-clock time to the run) - give it a brief moment to actually land.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(isAlive(childPid)).toBe(false);
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

describe("scrubSecretsFromLog (U22 code review round 2, item 3)", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "x402-redteam-scrub-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("redacts every literal occurrence of a secret >= 8 chars", () => {
    const logFile = join(outDir, "run.log");
    writeFileSync(
      logFile,
      "agent booted\nANTHROPIC_API_KEY=sk-ant-super-secret-value\ndone: sk-ant-super-secret-value\n",
    );
    scrubSecretsFromLog(logFile, ["sk-ant-super-secret-value"]);
    const content = readFileSync(logFile, "utf8");
    expect(content).not.toContain("sk-ant-super-secret-value");
    expect(content.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(content).toContain("agent booted");
  });

  it("skips values under 8 characters (too likely to false-positive)", () => {
    const logFile = join(outDir, "short.log");
    writeFileSync(logFile, "port=8080, ok=true\n");
    scrubSecretsFromLog(logFile, ["8080", "true"]);
    expect(readFileSync(logFile, "utf8")).toBe("port=8080, ok=true\n");
  });

  it("is a no-op when no secret value appears in the log", () => {
    const logFile = join(outDir, "clean.log");
    const original = "nothing sensitive here, just agent output\n";
    writeFileSync(logFile, original);
    scrubSecretsFromLog(logFile, ["totally-unrelated-secret-value"]);
    expect(readFileSync(logFile, "utf8")).toBe(original);
  });

  it("is a no-op given an empty secrets list", () => {
    const logFile = join(outDir, "empty-secrets.log");
    const original = "sk-ant-super-secret-value appears but nothing was passed to redact\n";
    writeFileSync(logFile, original);
    scrubSecretsFromLog(logFile, []);
    expect(readFileSync(logFile, "utf8")).toBe(original);
  });

  it("does not throw when the log file doesn't exist", () => {
    expect(() =>
      scrubSecretsFromLog(join(outDir, "missing.log"), ["some-long-secret-value"]),
    ).not.toThrow();
  });
});

describe("validateAgentUid (ADR-011, U19: --agent-uid, Linux + root only)", () => {
  it("is a no-op when uid is undefined", () => {
    expect(validateAgentUid(undefined)).toBeUndefined();
  });

  it("security review HIGH-4/LOW: rejects uid 0 unconditionally, before any platform/root check", () => {
    const message = validateAgentUid(0);
    expect(message).toBeDefined();
    expect(message).toMatch(/0 is refused/);
  });

  it("security review HIGH-4: rejects every default-reserved uid (1000, 1001), before any platform/root check", () => {
    for (const uid of DEFAULT_RESERVED_AGENT_UIDS) {
      const message = validateAgentUid(uid);
      expect(message).toBeDefined();
      expect(message).toMatch(/reserved/);
    }
  });

  it("a caller-supplied reservedUids set is honored instead of the default", () => {
    expect(validateAgentUid(1001, new Set())).not.toMatch(/reserved/);
    const message = validateAgentUid(9999, new Set([9999]));
    expect(message).toMatch(/reserved/);
  });

  it("rejects on a non-Linux platform (e.g. macOS, where this suite normally runs)", () => {
    if (process.platform === "linux") return; // covered by the root-check test instead
    const message = validateAgentUid(2001);
    expect(message).toBeDefined();
    expect(message).toMatch(/Linux/);
  });

  it("on Linux, rejects when the harness itself isn't running as root", () => {
    if (process.platform !== "linux") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // covered elsewhere
    const message = validateAgentUid(2001);
    expect(message).toBeDefined();
    expect(message).toMatch(/root/);
  });
});

describe("killAgentUidProcesses (security review HIGH-4)", () => {
  it("never throws, even when no process matches (the common case on this dev machine)", () => {
    expect(() => killAgentUidProcesses(999999)).not.toThrow();
  });

  it("calls pkill -9 -u <uid>, never touching any other uid", () => {
    const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
    execFileSyncMock.mockClear();
    killAgentUidProcesses(2001);
    expect(execFileSyncMock).toHaveBeenCalledWith("pkill", ["-9", "-u", "2001"], expect.anything());
  });

  it("security re-review 4-residual: fails loudly (throws) when pkill itself is missing (ENOENT), never silently skipping the sweep", () => {
    const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
    const enoent = Object.assign(new Error("spawnSync pkill ENOENT"), { code: "ENOENT" });
    execFileSyncMock.mockImplementationOnce(() => {
      throw enoent;
    });
    expect(() => killAgentUidProcesses(2001)).toThrow(/pkill is not installed/);
  });

  it("still swallows pkill's own exit 1 (no matching process - the common, harmless case)", () => {
    const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
    const exitError = Object.assign(new Error("Command failed"), { status: 1 });
    execFileSyncMock.mockImplementationOnce(() => {
      throw exitError;
    });
    expect(() => killAgentUidProcesses(2001)).not.toThrow();
  });
});

describe("runAgent sweeps agentUid processes after every run, not only on timeout (security review HIGH-4)", () => {
  it("calls killAgentUidProcesses after a normal (non-timeout) exit when agentUid is set", async () => {
    const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    execFileSyncMock.mockClear();
    spawnMock.mockImplementationOnce(() => {
      const fake = new FakeChild();
      setTimeout(() => fake.emit("close", 0), 5);
      return fake;
    });

    const outDirLocal = mkdtempSync(join(tmpdir(), "x402-redteam-spawn-sweep-"));
    await runAgent({
      cmd: "true",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
      agentUid: 2001,
      logFile: join(outDirLocal, "run.log"),
    });

    const pkillCalls = execFileSyncMock.mock.calls.filter((args) => args[0] === "pkill");
    expect(pkillCalls).toEqual([["pkill", ["-9", "-u", "2001"], expect.anything()]]);
    rmSync(outDirLocal, { recursive: true, force: true });
  });

  it("never sweeps when agentUid is not set", async () => {
    const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
    execFileSyncMock.mockClear();
    const outDirLocal = mkdtempSync(join(tmpdir(), "x402-redteam-spawn-nosweep-"));
    await runAgent({
      cmd: "true",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
      logFile: join(outDirLocal, "run.log"),
    });
    const pkillCalls = execFileSyncMock.mock.calls.filter((args) => args[0] === "pkill");
    expect(pkillCalls).toEqual([]);
    rmSync(outDirLocal, { recursive: true, force: true });
  });
  it("ends a killed run after the abandon window when the agent never closes", async () => {
    // A detached grandchild inherits the agent's stdout and outlives the group kill, so
    // the agent's stdio never closes; the run must still end shortly after SIGKILL.
    const holder =
      "require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref(); setInterval(() => {}, 1000)";
    const start = performance.now();
    const result = await runAgent({
      cmd: `node -e "${holder}"`,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 60_000,
      startupTimeoutMs: 300,
      hasStarted: () => false,
      abandonAfterKillMs: 500,
      logFile: join(mkdtempSync(join(tmpdir(), "x402-redteam-abandon-")), "abandon.log"),
    });
    expect(result.timed_out).toBe(true);
    expect(performance.now() - start).toBeLessThan(8000);
  });
});
