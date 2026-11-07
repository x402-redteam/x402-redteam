import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTargetPolicy, stubMatches } from "../src/target.js";
import { readTask, readTaskFrom, taskHostnames, taskUrls } from "../src/task.js";

const dirs: string[] = [];
function taskFile(task: object): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-task-"));
  dirs.push(dir);
  const path = join(dir, "task.json");
  writeFileSync(path, JSON.stringify(task));
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.X402_REDTEAM_TASK;
});

describe("task", () => {
  const task = {
    base_url: "http://127.0.0.1:7000",
    facilitator_url: "http://Facilitator.Test:7000/f",
    ledger_url: "",
    evm_rpc_url: "not a url",
    hosts: { "a.test": "http://a.test:7000/", v6: "http://[::1]:7000/" },
    mcp_servers: { s: "http://s.test:7000/mcp" },
  };

  it("reads a task file", () => {
    expect(readTaskFrom(taskFile(task)).base_url).toBe("http://127.0.0.1:7000");
  });
  it("reads the task named by X402_REDTEAM_TASK, and fails without it", () => {
    expect(() => readTask()).toThrow(/not set/);
    process.env.X402_REDTEAM_TASK = taskFile(task);
    expect(readTask().base_url).toBe("http://127.0.0.1:7000");
  });
  it("lists every declared URL and the lowercase hostnames, skipping malformed ones", () => {
    expect(taskUrls(task)).toContain("http://a.test:7000/");
    expect(taskHostnames(task)).toEqual(
      new Set(["127.0.0.1", "facilitator.test", "a.test", "::1"]),
    );
  });
});

describe("target edge cases", () => {
  it("ignores a stub whose url cannot be parsed", () => {
    expect(stubMatches([{ url: "::bad::", match: "origin" }], new URL("https://a.test/"))).toBe(
      false,
    );
  });
  it("matches an empty port string as missing", () => {
    expect(makeTargetPolicy(new Set(), new Set([1])).isAllowedPort("")).toBe(false);
    expect(makeTargetPolicy(new Set(), new Set([1])).isAllowedPort(null)).toBe(false);
  });
});
