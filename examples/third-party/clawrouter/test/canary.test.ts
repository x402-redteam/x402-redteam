/**
 * Canary test (U28 §7.2, U25 §3.1 acceptance, ADR-029 §4). Local only: not part of the
 * harness's `pnpm test` or CI. Run from this directory with `pnpm canary`.
 *
 * Proves, inside the child launcher (sandbox.ts):
 *  (a) the OS sandbox alone (guard off) refuses fetch, http.get, WebSocket, net.connect,
 *      curl and DNS for example.com, by name and by IP literal, and refuses decoy
 *      listeners on port 8402 and on a random loopback port (127.0.0.1, ::1 and a
 *      `*.localhost` name). It denies reads of ~/.ssh, .env files, ~/.openclaw and
 *      ~/.blockrun, and writes outside temp and the out dir;
 *  (b) the guard alone (sandbox off) refuses the same egress and the same decoys, logging
 *      EGRESS_BLOCKED, and answers the package's update check locally;
 *  (c) with both on, the harness port and the child's own proxy port still work;
 * and that the allowlist is built only from the harness port and P, that the child
 * environment holds nothing but its four variables, and that the parent refuses to start
 * while something listens on 8402.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHILD_ENV_NAMES, childEnv, startChild } from "../src/child-client.js";
import { allowedPorts, DEFAULT_PAYER_PORT, PORT_ENV } from "../src/ports.js";
import { detectSandbox, macosProfile, spawnSandboxed } from "../src/sandbox.js";
import { TASK_HOST, writeTask } from "./fixtures.js";
import type { ProbeResult } from "./probe.js";

const PLAN_LINE = "Say hello.\nclawrouter: model=openai/gpt-4o-mini calls=1 body=same";
const PROBE = fileURLToPath(new URL("./probe.ts", import.meta.url));

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
/** Decoys the sandbox alone must refuse with EPERM (an IP literal, no name lookup). */
const IP_DECOYS = [
  "decoy:8402-v4",
  "decoy:8402-v6",
  "decoy:random-v4",
  "decoy:random-v6",
  "decoy:random-net.connect",
  "decoy:random-http.get",
  "decoy:8402-net.connect",
];
/** Decoys addressed by name: the sandbox alone cannot resolve the name, which also refuses. */
const NAME_DECOYS = ["decoy:8402-localhost", "decoy:random-localhost-name"];
/** A refusal comes back at once; a packet on the wire would take a round trip or a timeout. */
const FAST_MS = 1500;

let server: Server;
let port: number;
let dir: string;
let taskPath: string;
let dotenvPath: string;
const proxyPort = 0; // replaced in before()
let proxyPortValue = proxyPort;

interface Decoy {
  server: Server;
  connections: number;
  port: number;
}
const decoys: Record<string, Decoy | undefined> = {};

async function startDecoy(host: string, wantedPort: number): Promise<Decoy | undefined> {
  const decoy: Decoy = { server: createServer((_req, res) => res.end("decoy")), connections: 0, port: 0 };
  decoy.server.on("connection", () => {
    decoy.connections += 1;
  });
  const ok = await new Promise<boolean>((resolve) => {
    decoy.server.once("error", () => resolve(false));
    decoy.server.listen(wantedPort, host, () => resolve(true));
  });
  if (!ok) return undefined;
  decoy.port = (decoy.server.address() as AddressInfo).port;
  return decoy;
}

before(async () => {
  server = createServer((_req, res) => res.end("canary-ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  // P: a free port other than the harness's and 8402, as the parent would pick.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  proxyPortValue = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  dir = realpathSync(mkdtempSync(join(tmpdir(), "x402rt-clawrouter-canary-")));
  taskPath = writeTask(dir, "canary", port);
  mkdirSync(join(dir, "envcheck"));
  dotenvPath = join(dir, "envcheck", ".env");
  writeFileSync(dotenvPath, "CANARY_MARKER=1\n");
  decoys.v4_8402 = await startDecoy("127.0.0.1", DEFAULT_PAYER_PORT);
  decoys.v6_8402 = await startDecoy("::1", DEFAULT_PAYER_PORT);
  decoys.v4 = await startDecoy("127.0.0.1", 0);
  decoys.v6 = await startDecoy("::1", 0);
});

after(() => {
  server.close();
  for (const d of Object.values(decoys)) d?.server.close();
  rmSync(dir, { recursive: true, force: true });
});

function totalDecoyConnections(): number {
  return Object.values(decoys).reduce((n, d) => n + (d?.connections ?? 0), 0);
}

async function runProbe(layers: {
  sandbox: boolean;
  guard: boolean;
}): Promise<{ results: Map<string, ProbeResult>; stderr: string }> {
  const proc = spawnSandboxed({
    script: PROBE,
    sandbox: layers.sandbox,
    guard: layers.guard,
    env: {
      ...childEnv({
        ...process.env,
        X402_REDTEAM_TASK: taskPath,
        [PORT_ENV]: String(proxyPortValue),
        ANTHROPIC_API_KEY: "sk-canary",
        BLOCKRUN_API_KEY: "brk_canary",
        CLAWROUTER_PAYMENT_CHAIN: "solana",
        HTTPS_PROXY: "http://127.0.0.1:1",
        NODE_OPTIONS: "--require evil",
      }),
      X402_CANARY_PORT: String(port),
      X402_CANARY_TASK_HOST: TASK_HOST,
      X402_CANARY_DOTENV: dotenvPath,
      X402_CANARY_OUT_DIR: dir,
      X402_CANARY_DECOY_V4: String(decoys.v4?.port ?? 0),
      X402_CANARY_DECOY_V6: String(decoys.v6?.port ?? 0),
      ...(layers.guard ? { X402_CANARY_GUARD: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let out = "";
  let stderr = "";
  (proc.stdio[3] as Readable).on("data", (d) => {
    out += d;
  });
  proc.stdout?.on("data", (d) => {
    stderr += d;
  });
  proc.stderr?.on("data", (d) => {
    stderr += d;
  });
  const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
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
  for (const name of [
    "file:read-ssh",
    "file:read-dotenv",
    "file:read-openclaw",
    "file:read-blockrun",
    "file:write-home",
  ]) {
    const r = get(results, name);
    assert.equal(r.ok, false, `${name} was allowed: ${r.detail}`);
    // A folder that does not exist on this machine reports ENOENT whatever the profile says;
    // the generated profile is tested against real files in a stand-in home below.
    const absent =
      (name === "file:read-openclaw" && !existsSync(join(homedir(), ".openclaw"))) ||
      (name === "file:read-blockrun" && !existsSync(join(homedir(), ".blockrun")));
    assert.equal(r.code, absent ? "ENOENT" : "EPERM", `${name}: ${r.detail}`);
  }
  assert.equal(get(results, "file:write-out").detail, "written");
}

function assertEnvNames(results: Map<string, ProbeResult>): void {
  const names = get(results, "env:names").detail.split(",");
  assert.deepEqual(
    names.filter(
      (n) =>
        !["PATH", "HOME", "X402_REDTEAM_TASK", PORT_ENV].includes(n) &&
        // The probe's own settings, and a variable macOS adds to every process.
        !n.startsWith("X402_CANARY_") &&
        n !== "__CF_USER_TEXT_ENCODING",
    ),
    [],
    "the child sees only PATH, HOME, the task path and P",
  );
  for (const name of names) {
    assert.doesNotMatch(name, /API_KEY|^BLOCKRUN_|^CLAWROUTER_|PROXY|^NODE_OPTIONS$/i, name);
  }
}

describe("clawrouter child isolation canary", { timeout: 180_000 }, () => {
  it("has a working OS sandbox on this machine", () => {
    assert.notEqual(detectSandbox(), "none");
  });

  it("started decoy listeners to test against", () => {
    // 8402 may be taken by something real; the canary then skips the decoy on it rather
    // than touching it, and says so. The random-port decoys are always required.
    assert.ok(decoys.v4, "no decoy on a random 127.0.0.1 port");
    assert.ok(decoys.v6, "no decoy on a random ::1 port");
    if (!decoys.v4_8402) console.error("canary: 127.0.0.1:8402 is taken, no decoy there");
    if (!decoys.v6_8402) console.error("canary: [::1]:8402 is taken, no decoy there");
  });

  it("(a) the OS sandbox alone refuses every public egress path and every decoy at the syscall", async () => {
    const before = totalDecoyConnections();
    const { results } = await runProbe({ sandbox: true, guard: false });
    for (const [name, code] of Object.entries(SANDBOX_CODES)) {
      const r = get(results, name);
      assert.equal(r.ok, false, `${name} got through the sandbox: ${r.detail}`);
      assert.equal(r.code, code, `${name}: ${r.detail}`);
      assert.doesNotMatch(r.detail, /EGRESS_BLOCKED/, `${name} was refused by the guard`);
      assert.ok(r.ms < FAST_MS, `${name} took ${r.ms} ms`);
    }
    for (const name of IP_DECOYS) {
      const r = get(results, name);
      assert.equal(r.ok, false, `${name} got through the sandbox: ${r.detail}`);
      assert.equal(r.code, "EPERM", `${name}: ${r.detail}`);
      assert.doesNotMatch(r.detail, /EGRESS_BLOCKED/, `${name} was refused by the guard`);
    }
    for (const name of NAME_DECOYS) {
      const r = get(results, name);
      assert.equal(r.ok, false, `${name} got through the sandbox: ${r.detail}`);
    }
    assert.equal(totalDecoyConnections(), before, "a decoy accepted a connection");
    assert.equal(get(results, "loopback:fetch-ip").detail, "status 200");
    // The update check is answered by the guard, so the sandbox alone cannot reach it.
    assert.equal(get(results, "update-check:fetch").ok, false);
    assert.equal(get(results, "default-port:listen").ok, false, "the child could listen on 8402");
    assert.equal(get(results, "proxy-port:listen-and-fetch").detail, "status 200");
    assertEnvNames(results);
    assertFileRules(results);
  });

  it("(b) the guard alone refuses every public egress path and every decoy", async () => {
    const before = totalDecoyConnections();
    const { results, stderr } = await runProbe({ sandbox: false, guard: true });
    for (const name of [...PUBLIC_PROBES, ...IP_DECOYS, ...NAME_DECOYS, "update-check:other-path"]) {
      const r = get(results, name);
      assert.equal(r.ok, false, `${name} got through the guard: ${r.detail}`);
      assert.match(r.detail, /EGRESS_BLOCKED/, `${name}: ${r.detail}`);
      assert.ok(r.ms < FAST_MS, `${name} took ${r.ms} ms`);
    }
    // ::1 is refused even on the harness port; only 127.0.0.1 is allowed.
    assert.match(get(results, "harness-port:v6").detail, /EGRESS_BLOCKED/);
    assert.match(stderr, /EGRESS_BLOCKED .*example\.com/);
    assert.match(stderr, /EGRESS_BLOCKED .*93\.184\.215\.14/);
    assert.match(stderr, /EGRESS_BLOCKED .*:8402/);
    assert.equal(totalDecoyConnections(), before, "a decoy accepted a connection");
    // The update check is answered locally and leaves nothing behind.
    assert.equal(get(results, "update-check:fetch").detail, "status 204");
    assert.doesNotMatch(stderr, /registry\.npmjs\.org\/@blockrun/);
    assert.equal(get(results, "task:dns.lookup").detail, "127.0.0.1");
    assert.equal(get(results, "task:fetch").detail, "status 200");
    assert.equal(get(results, "task:http.get").detail, "status 200");
    assert.equal(get(results, "loopback:fetch-localhost").detail, "status 200");
    assert.equal(get(results, "proxy-port:listen-and-fetch").detail, "status 200");
    assertEnvNames(results);
  });

  it("(c) with both layers, the harness port and P work and public ones and decoys do not", async () => {
    const before = totalDecoyConnections();
    const { results } = await runProbe({ sandbox: true, guard: true });
    for (const name of [...PUBLIC_PROBES, ...IP_DECOYS, ...NAME_DECOYS]) {
      assert.equal(get(results, name).ok, false, name);
    }
    assert.equal(totalDecoyConnections(), before, "a decoy accepted a connection");
    assert.match(get(results, "harness-port:v6").detail, /EGRESS_BLOCKED/);
    assert.equal(get(results, "task:dns.lookup").detail, "127.0.0.1");
    assert.equal(get(results, "task:fetch").detail, "status 200");
    assert.equal(get(results, "task:http.get").detail, "status 200");
    assert.equal(get(results, "loopback:fetch-ip").detail, "status 200");
    assert.equal(get(results, "proxy-port:listen-and-fetch").detail, "status 200");
    assert.equal(get(results, "update-check:fetch").detail, "status 204");
    assert.equal(get(results, "default-port:listen").ok, false);
    assertEnvNames(results);
    assertFileRules(results);
  });

  it("denies reads of ~/.openclaw and ~/.blockrun files in a stand-in home (m2)", () => {
    const fakeHome = join(dir, "fake-home");
    mkdirSync(join(fakeHome, ".openclaw"), { recursive: true });
    mkdirSync(join(fakeHome, ".blockrun"), { recursive: true });
    writeFileSync(join(fakeHome, ".openclaw", "wallet.json"), "secret");
    writeFileSync(join(fakeHome, ".blockrun", "key"), "secret");
    writeFileSync(join(fakeHome, "plain.txt"), "fine");
    const profile = macosProfile({ home: fakeHome, ports: [], writable: [], readable: [] });
    const cat = (file: string) =>
      spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", file], { encoding: "utf8" });
    for (const file of [join(".openclaw", "wallet.json"), join(".blockrun", "key")]) {
      const r = cat(join(fakeHome, file));
      assert.notEqual(r.status, 0, `${file} was readable`);
      assert.match(r.stderr, /Operation not permitted/, file);
    }
    assert.equal(cat(join(fakeHome, "plain.txt")).stdout, "fine");
  });

  it("builds both allowlists from the harness port and P and nothing else (N1, C2)", async () => {
    assert.deepEqual(
      allowedPorts(`http://127.0.0.1:${port}`, proxyPortValue),
      [port, proxyPortValue].sort((a, b) => a - b),
    );
    // The payer's default port is never allowed, even when asked for.
    assert.deepEqual(allowedPorts(`http://127.0.0.1:${DEFAULT_PAYER_PORT}`, DEFAULT_PAYER_PORT), []);
    assert.deepEqual(allowedPorts(undefined, undefined), []);
    // The sandbox profile names exactly those ports.
    const profile = macosProfile({
      home: "/h",
      ports: allowedPorts(`http://127.0.0.1:${port}`, proxyPortValue),
      listenPort: proxyPortValue,
      writable: [],
      readable: [],
    });
    const named = [...profile.matchAll(/localhost:(\d+)"/g)].map((m) => Number(m[1]));
    assert.deepEqual([...new Set(named)].sort((a, b) => a - b), [port, proxyPortValue].sort((a, b) => a - b));
    assert.doesNotMatch(profile, /localhost:\*/);
    assert.match(profile, /\.openclaw/);
    assert.match(profile, /\.blockrun/);
    // The guard, running in the child, reports the same two ports.
    const { results } = await runProbe({ sandbox: false, guard: true });
    assert.deepEqual(
      JSON.parse(get(results, "guard:ports").detail),
      [port, proxyPortValue].sort((a, b) => a - b),
    );
  });

  it("passes the child only PATH, HOME, the task path and P", () => {
    const env = childEnv({
      PATH: "/bin",
      HOME: "/h",
      ANTHROPIC_API_KEY: "sk-canary",
      BLOCKRUN_WALLET_KEY: "0x1",
      CLAWROUTER_PAYMENT_CHAIN: "solana",
      HTTP_PROXY: "http://x",
      HTTPS_PROXY: "http://x",
      NODE_OPTIONS: "--require evil",
      X402_REDTEAM_TASK: "/t/task.json",
      [PORT_ENV]: "5555",
    });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", PORT_ENV, "X402_REDTEAM_TASK"].sort());
    for (const name of Object.keys(env)) assert.ok(CHILD_ENV_NAMES.includes(name as never));
  });

  it("the real child, sandboxed with the guard, sees only its four variables", async () => {
    const child = startChild({
      env: {
        ...process.env,
        X402_REDTEAM_TASK: taskPath,
        [PORT_ENV]: String(proxyPortValue),
        ANTHROPIC_API_KEY: "sk-canary",
        BLOCKRUN_API_KEY: "brk_canary",
        CLAWROUTER_PAYMENT_CHAIN: "solana",
        HTTPS_PROXY: "http://127.0.0.1:1",
        NODE_OPTIONS: "--require evil",
      },
    });
    const names = (await Promise.race([child.call("__env_names"), child.crashed])) as string[];
    await child.close();
    assert.deepEqual(
      names.filter((n) => n !== "__CF_USER_TEXT_ENCODING"),
      ["HOME", "PATH", PORT_ENV, "X402_REDTEAM_TASK"].sort(),
    );
  });

  it("the parent refuses to start while something listens on 8402", async () => {
    // The decoy holds 8402, or something else already does; the parent's check is only a
    // connect, so either way it must refuse.
    const outDir = join(dir, "parent-8402");
    const task = writeTask(outDir, "p8402", port, {
      prompt: PLAN_LINE,
    });
    const proc = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(new URL("../src/agent.ts", import.meta.url))],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          X402_REDTEAM_TASK: task,
          X402_CLAWROUTER_PROFILE: "defaults",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    proc.stdout.on("data", (d) => {
      log += d;
    });
    proc.stderr.on("data", (d) => {
      log += d;
    });
    const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
    assert.equal(code, 1, log);
    assert.match(log, /8402/);
  });

  it("the parent refuses to start with only a ::1 listener on 8402", async () => {
    // Needs 8402 free on both addresses: close the decoys, then listen on ::1 alone.
    for (const key of ["v4_8402", "v6_8402"]) {
      const d = decoys[key];
      if (d) {
        await new Promise<void>((resolve) => d.server.close(() => resolve()));
        decoys[key] = undefined;
      }
    }
    const only6 = await startDecoy("::1", DEFAULT_PAYER_PORT);
    if (!only6) {
      console.error("canary: [::1]:8402 is taken by something else; skipping the ::1-only test");
      return;
    }
    try {
      const outDir = join(dir, "parent-8402-v6");
      const task = writeTask(outDir, "p8402v6", port, { prompt: PLAN_LINE });
      const proc = spawn(
        process.execPath,
        [...process.execArgv, fileURLToPath(new URL("../src/agent.ts", import.meta.url))],
        {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            X402_REDTEAM_TASK: task,
            X402_CLAWROUTER_PROFILE: "defaults",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let log = "";
      proc.stdout.on("data", (d) => {
        log += d;
      });
      proc.stderr.on("data", (d) => {
        log += d;
      });
      const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
      assert.equal(code, 1, log);
      assert.match(log, /8402/);
    } finally {
      only6.server.close();
    }
  });
});
