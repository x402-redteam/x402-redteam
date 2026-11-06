/**
 * U38 (adversary resource limits), channels that are not HTTP: AC-16 (log cap, fail-closed
 * scrub) and AC-17 (GDP record), functional-design.md sections 2.2 and 4.10-4.12.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGdpRecordFromDir } from "../src/guardrail-track.js";
import {
  LOG_TRUNCATED_MARKER,
  MAX_GDP_LABEL_CHARS,
  MAX_GDP_RECORD_BYTES,
  MAX_LOG_BYTES,
} from "../src/limits.js";
import { runAgent, scrubSecretsFromLog } from "../src/spawn.js";

const fsControl = vi.hoisted(() => ({ failWrite: false, failRm: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsControl.failWrite) throw new Error("disk full (test)");
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
      if (fsControl.failRm) throw new Error("cannot delete (test)");
      return actual.rmSync(...args);
    }) as typeof actual.rmSync,
  };
});

const SECRET = "sk-ant-straddling-secret-value";
const MARKER_LINE = `\n${LOG_TRUNCATED_MARKER}\n`;

describe("U38 AC-16: agent log cap and fail-closed scrub", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-redteam-u38-"));
    fsControl.failWrite = false;
    fsControl.failRm = false;
  });
  afterEach(() => {
    fsControl.failWrite = false;
    fsControl.failRm = false;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a child writing 20 MiB leaves an 8 MiB log plus one marker, and is not blocked", async () => {
    const logFile = join(dir, "flood.log");
    const script =
      'const c = Buffer.alloc(1 << 20, 0x61); for (let i = 0; i < 20; i++) process.stdout.write(c); process.stderr.write("done\\n");';
    const result = await runAgent({
      cmd: `node -e '${script}'`,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 30_000,
      logFile,
    });
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    const log = readFileSync(logFile);
    expect(log.length).toBe(MAX_LOG_BYTES + Buffer.byteLength(MARKER_LINE));
    expect(log.subarray(log.length - Buffer.byteLength(MARKER_LINE)).toString("utf8")).toBe(
      MARKER_LINE,
    );
    expect(log.toString("utf8").split(LOG_TRUNCATED_MARKER)).toHaveLength(2);
  }, 60_000);

  it("a log under the cap is unchanged and carries no marker", async () => {
    const logFile = join(dir, "small.log");
    await runAgent({
      cmd: "echo hello",
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
      logFile,
    });
    expect(readFileSync(logFile, "utf8")).toBe("hello\n");
  });

  it("a secret cut by the truncation is not left as a prefix of 4 or more characters", () => {
    const logFile = join(dir, "cut.log");
    // The cut fell after the first 12 characters of the secret.
    writeFileSync(logFile, `${"a".repeat(100)}${SECRET.slice(0, 12)}${MARKER_LINE}`);
    scrubSecretsFromLog(logFile, [SECRET]);
    const log = readFileSync(logFile, "utf8");
    expect(log).not.toContain(SECRET.slice(0, 4));
    expect(log.endsWith(MARKER_LINE)).toBe(true);
    expect(log).toContain("[REDACTED]");
    // A 3-character leak at the cut is accepted.
    const short = join(dir, "short-cut.log");
    writeFileSync(short, `${"a".repeat(100)}${SECRET.slice(0, 3)}${MARKER_LINE}`);
    scrubSecretsFromLog(short, [SECRET]);
    expect(readFileSync(short, "utf8")).toContain(SECRET.slice(0, 3));
  });

  it("a whole secret is still redacted when the log was also truncated", () => {
    const logFile = join(dir, "whole.log");
    writeFileSync(logFile, `x ${SECRET} y${MARKER_LINE}`);
    scrubSecretsFromLog(logFile, [SECRET]);
    expect(readFileSync(logFile, "utf8")).toBe(`x [REDACTED] y${MARKER_LINE}`);
  });

  it("a scrub whose write throws deletes the log", () => {
    const logFile = join(dir, "write-fails.log");
    writeFileSync(logFile, `token ${SECRET}\n`);
    fsControl.failWrite = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    scrubSecretsFromLog(logFile, [SECRET]);
    err.mockRestore();
    fsControl.failWrite = false;
    expect(() => statSync(logFile)).toThrow();
  });

  it("a scrub whose read throws deletes the log; a delete that also fails throws", () => {
    // A directory cannot be read as a file.
    const logFile = join(dir, "unreadable.log");
    mkdirSync(logFile);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fsControl.failRm = true;
    expect(() => scrubSecretsFromLog(logFile, [SECRET])).toThrow(/could not scrub or delete/);
    fsControl.failRm = false;
    err.mockRestore();
  });

  it("a log that cannot be scrubbed is never returned silently", () => {
    const logFile = join(dir, "both-fail.log");
    writeFileSync(logFile, `token ${SECRET}\n`);
    fsControl.failWrite = true;
    fsControl.failRm = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => scrubSecretsFromLog(logFile, [SECRET])).toThrow(/could not scrub or delete/);
    err.mockRestore();
    fsControl.failWrite = false;
    fsControl.failRm = false;
  });
});

describe("U38 AC-17: GDP record bounds", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-redteam-u38-gdp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a 65 KiB gdp.json is no record (the existing integrity-failure path)", () => {
    writeFileSync(
      join(dir, "gdp.json"),
      JSON.stringify({ hooks: ["payment"], name: "x".repeat(65 * 1024) }),
    );
    expect(statSync(join(dir, "gdp.json")).size).toBeGreaterThan(MAX_GDP_RECORD_BYTES);
    expect(readGdpRecordFromDir(dir)).toBeUndefined();
  });

  it("a 10,000-character name and version are truncated to 256 on read", () => {
    writeFileSync(
      join(dir, "gdp.json"),
      JSON.stringify({
        hooks: ["payment"],
        name: "n".repeat(10_000),
        version: "v".repeat(10_000),
        guardrail_errors: 0,
      }),
    );
    const record = readGdpRecordFromDir(dir);
    expect(String(record?.name).length).toBe(MAX_GDP_LABEL_CHARS);
    expect(String(record?.version).length).toBe(MAX_GDP_LABEL_CHARS);
    expect(record?.hooks).toEqual(["payment"]);
  });

  it("a normal record is returned unchanged", () => {
    const original = { hooks: ["payment"], name: "g", version: "1", guardrail_errors: 2 };
    writeFileSync(join(dir, "gdp.json"), JSON.stringify(original));
    expect(readGdpRecordFromDir(dir)).toEqual(original);
  });
});
