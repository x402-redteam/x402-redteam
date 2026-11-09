/**
 * Canary test (U25 §3.1 acceptance, §3.5.2, ADR-029 §4). Local only: not part of the
 * harness's `pnpm test` or CI. Run from this directory with `pnpm canary`.
 *
 * Proves, inside the child launcher (sandbox.ts):
 *  (a) the OS sandbox alone (guard off) refuses fetch, http.get, WebSocket, net.connect,
 *      curl and DNS for example.com, by name and by IP literal, before any packet leaves:
 *      names fail to resolve (ENOTFOUND) and IP connects are denied (EPERM). It also
 *      denies reads of ~/.ssh and of .env files, and writes outside temp and the out dir;
 *  (b) the guard alone (sandbox off) refuses the same egress, logging EGRESS_BLOCKED;
 *  (c) with both on, task *.localhost hosts still resolve and connect;
 * and that the real AgentKit child starts sandboxed without ANTHROPIC_API_KEY.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TASK_HOST, writeTask } from "./fixtures.js";
import { detectSandbox, spawnSandboxed } from "@x402-redteam/sandbox";
import { runConformance } from "@x402-redteam/sandbox/conformance";
import { TEST_ONLY } from "@x402-redteam/sandbox/testing";
import { CHILD_ENV_NAMES, childEnv, startChild } from "../src/child-client.js";
import type { ProbeResult } from "./probe.js";

const PROBE = fileURLToPath(new URL("./probe.ts", import.meta.url));
const LOADER = import.meta.resolve("tsx");
const GUARD_ENTRY = fileURLToPath(new URL("../src/guard.ts", import.meta.url));
const ADAPTER_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** Set by bracket-2.0.0/resolve.mjs when this runs against the bracket install (m1). */
const DEPS_HOOK = (globalThis as { __x402AgentkitDepsHook?: unknown }).__x402AgentkitDepsHook;
const PRE_IMPORTS = typeof DEPS_HOOK === "string" ? [DEPS_HOOK] : [];

runConformance({
  label: "agentkit",
  adapterRoot: ADAPTER_ROOT,
  guardEntry: GUARD_ENTRY,
  loader: LOADER,
  preImports: PRE_IMPORTS,
});

/** Each public probe and the error code the OS sandbox alone must produce for it. */
const SANDBOX_CODES: Record<string, string> = {
  "public:fetch": "ENOTFOUND",
  "public:fetch-ip": "EPERM",
  "public:http.get": "ENOTFOUND",
  "public:http.get-ip": "EPERM",
  "public:websocket": "ENOTFOUND",
  "public:websocket-ip": "EPERM",
  "public:net.connect": "ENOTFOUND",
  "public:net.connect-ip": "EPERM",
  "public:curl": "6", // curl: could not resolve host
  "public:curl-ip": "7", // curl: failed to connect
  "public:dns.lookup": "ENOTFOUND",
};
const PUBLIC_PROBES = Object.keys(SANDBOX_CODES);
/** A refusal comes back at once; a packet on the wire would take a round trip or a timeout. */
const FAST_MS = 1500;

let server: Server;
let port: number;
let dir: string;
let taskPath: string;
let dotenvPath: string;

before(async () => {
  server = createServer((_req, res) => res.end("canary-ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "x402rt-agentkit-canary-")));
  taskPath = writeTask(dir, "canary", port);
  mkdirSync(join(dir, "envcheck"));
  dotenvPath = join(dir, "envcheck", ".env");
  writeFileSync(dotenvPath, "CANARY_MARKER=1\n");
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function runProbe(layers: {
  sandbox: boolean;
  guard: boolean;
}): Promise<{ results: Map<string, ProbeResult>; stderr: string }> {
  const canary: Record<string, string> = {
    X402_CANARY_PORT: String(port),
    X402_CANARY_TASK_HOST: TASK_HOST,
    X402_CANARY_DOTENV: dotenvPath,
    X402_CANARY_OUT_DIR: dir,
    X402_CANARY_REALHOME: realpathSync(homedir()),
  };
  const spawned = spawnSandboxed({
    label: "agentkit",
    script: PROBE,
    loader: LOADER,
    guardEntry: GUARD_ENTRY,
    taskPath,
    preImports: PRE_IMPORTS,
    sandbox: layers.sandbox,
    guard: layers.guard,
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-canary", ...canary },
    extraEnv: Object.keys(canary),
    // The layers are the subject here; the runtime preflight has its own conformance case.
    [TEST_ONLY]: { skipPreflight: true },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const proc = spawned.proc;
  let out = "";
  let stderr = "";
  (proc.stdio[3] as Readable).on("data", (d: Buffer) => {
    out += d;
  });
  proc.stdout?.on("data", (d: Buffer) => {
    stderr += d;
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d;
  });
  const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
  spawned.dispose();
  assert.equal(code, 0, `probe exited ${code}\n${stderr}`);
  const list = JSON.parse(out) as ProbeResult[];
  if (process.env.CANARY_VERBOSE) {
    for (const r of list) {
      console.error(`${JSON.stringify(layers)} ${r.name}: [${r.code ?? ""}] ${r.detail}`);
    }
  }
  return { results: new Map(list.map((r) => [r.name, r])), stderr };
}

function get(results: Map<string, ProbeResult>, name: string): ProbeResult {
  const r = results.get(name);
  assert.ok(r, `missing probe ${name}`);
  return r;
}

function assertFileRules(results: Map<string, ProbeResult>): void {
  for (const name of ["file:read-ssh", "file:read-dotenv", "file:write-home"]) {
    const r = get(results, name);
    assert.equal(r.ok, false, `${name} was allowed: ${r.detail}`);
    assert.equal(r.code, "EPERM", `${name}: ${r.detail}`);
  }
  // The out dir is read-only to the child (U35).
  assert.equal(get(results, "file:write-out").ok, false);
  assert.equal(get(results, "file:write-out").code, "EPERM");
}

describe("agentkit child isolation canary", { timeout: 120_000 }, () => {
  it("has a working OS sandbox on this machine", () => {
    assert.notEqual(detectSandbox(), "none");
  });

  it("(a) the OS sandbox alone refuses every public egress path at the syscall", async () => {
    const { results } = await runProbe({ sandbox: true, guard: false });
    for (const [name, code] of Object.entries(SANDBOX_CODES)) {
      const r = get(results, name);
      assert.equal(r.ok, false, `${name} got through the sandbox: ${r.detail}`);
      assert.equal(r.code, code, `${name}: ${r.detail}`);
      assert.doesNotMatch(r.detail, /EGRESS_BLOCKED/, `${name} was refused by the guard`);
      assert.ok(r.ms < FAST_MS, `${name} took ${r.ms} ms`);
    }
    assert.equal(get(results, "loopback:fetch-ip").detail, "status 200");
    assert.equal(get(results, "env-has-anthropic-key").detail, "false");
    assertFileRules(results);
  });

  it("(b) the guard alone refuses every public egress path", async () => {
    const { results, stderr } = await runProbe({ sandbox: false, guard: true });
    for (const name of PUBLIC_PROBES) {
      const r = get(results, name);
      assert.equal(r.ok, false, `${name} got through the guard: ${r.detail}`);
      assert.match(r.detail, /EGRESS_BLOCKED/, `${name}: ${r.detail}`);
      assert.ok(r.ms < FAST_MS, `${name} took ${r.ms} ms`);
    }
    assert.match(stderr, /EGRESS_BLOCKED .*example\.com/);
    assert.match(stderr, /EGRESS_BLOCKED .*93\.184\.215\.14/);
    assert.equal(get(results, "analytics:fetch").detail, "status 204");
    assert.equal(get(results, "task:dns.lookup").detail, "127.0.0.1");
    assert.equal(get(results, "task:fetch").detail, "status 200");
    assert.equal(get(results, "task:http.get").detail, "status 200");
  });

  it("(c) with both layers, task hosts resolve and connect and public ones do not", async () => {
    const { results } = await runProbe({ sandbox: true, guard: true });
    for (const name of PUBLIC_PROBES) assert.equal(get(results, name).ok, false, name);
    assert.equal(get(results, "task:dns.lookup").detail, "127.0.0.1");
    assert.equal(get(results, "task:fetch").detail, "status 200");
    assert.equal(get(results, "task:http.get").detail, "status 200");
    assert.equal(get(results, "loopback:fetch-ip").detail, "status 200");
    assert.equal(get(results, "analytics:fetch").detail, "status 204");
    assert.equal(get(results, "env-has-anthropic-key").detail, "false");
    assertFileRules(results);
  });

  it("passes the child only PATH, HOME, the task path and the mock URLs", () => {
    const env = childEnv({
      PATH: "/bin",
      HOME: "/h",
      ANTHROPIC_API_KEY: "sk-canary",
      NODE_OPTIONS: "--require evil",
      RPC_URL: "https://public.example",
      X402_REDTEAM_TASK: "/t/task.json",
    });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "X402_REDTEAM_TASK"]);
    for (const name of Object.keys(env)) assert.ok(CHILD_ENV_NAMES.includes(name as never));
  });

  it("starts the real AgentKit child sandboxed and lists exactly the three providers", async () => {
    const child = startChild({
      env: { ...process.env, X402_REDTEAM_TASK: taskPath, ANTHROPIC_API_KEY: "sk-canary" },
    });
    const actions = (await Promise.race([
      child.call("__list_actions"),
      child.crashed,
    ])) as { name: string }[];
    await child.close();
    const providers = new Set(actions.map((a) => a.name.split("_")[0]));
    assert.deepEqual(
      [...providers].sort(),
      ["ERC20ActionProvider", "WalletActionProvider", "X402ActionProvider"].sort(),
    );
  });
});
