/**
 * Canary test for the fuzz network-deny launcher (U29-00). Manual: not part of
 * `pnpm test` or CI. Run from the repository root with
 *
 *   node --test examples/fuzz-sandbox/canary.mjs
 *
 * Proves that, under run.mjs, public egress fails (fetch and DNS by name, a raw TCP connect
 * to example.com, and an IP literal over fetch and TCP) while the harness port still works
 * by IP and by a `*.localhost` name. It also proves the launcher refuses to start without a
 * harness port. The Python half runs when examples/agents-py/.venv exists, else is skipped.
 * No traffic leaves the machine: every public attempt is refused by the OS layer.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { detectSandbox } from "./run.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUN = join(HERE, "run.mjs");
// FUZZ_CANARY_PYTHON overrides the venv python (a worktree has no venv of its own).
const VENV_PY =
  process.env.FUZZ_CANARY_PYTHON ?? join(HERE, "..", "agents-py", ".venv", "bin", "python");

let server;
let port;
let dir;
let taskPath;

function run(argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN, ...argv], {
      env: {
        ...process.env,
        X402_REDTEAM_TASK: taskPath,
        CANARY_HARNESS_PORT: String(port),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

before(async () => {
  assert.notEqual(detectSandbox(), "none", "no OS sandbox here; the launcher would refuse");
  server = createServer((_q, r) => r.end("harness")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;
  dir = mkdtempSync(join(tmpdir(), "fuzz-canary-"));
  taskPath = join(dir, "task.json");
  writeFileSync(taskPath, JSON.stringify({ base_url: `http://127.0.0.1:${port}` }));
});

after(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function assertDenied(results) {
  for (const name of [
    "public:fetch",
    "public:fetch-ip",
    "public:dns",
    "public:tcp-name",
    "public:tcp-ip",
  ]) {
    assert.notEqual(results[name], "ok", `${name} must fail, got ${results[name]}`);
  }
  assert.equal(results["harness:fetch-ip"], "ok");
  assert.equal(results["harness:fetch-localhost-name"], "ok");
  assert.equal(results["harness:tcp"], "ok");
  if ("unix:outside-run-dir" in results) {
    assert.notEqual(results["unix:outside-run-dir"], "ok", "unix socket outside the run dir");
    assert.equal(results["unix:run-dir"], "ok", "unix socket inside the run dir");
  }
  // The Python probe also goes through httpx/asyncio, as the Python payer does.
  if ("harness:httpx-localhost-name" in results) {
    assert.equal(results["harness:httpx-localhost-name"], "ok");
  }
}

describe("fuzz-sandbox launcher", { concurrency: false }, () => {
  it("Node: public egress fails, the harness port works", async () => {
    const r = await run([process.execPath, join(HERE, "probe.mjs")]);
    assert.equal(r.status, 0, r.stderr);
    assertDenied(JSON.parse(r.stdout));
  });

  it("Node via the tsx CLI (as sdk-default runs): same result", async () => {
    const tsx = join(HERE, "..", "..", "node_modules", ".bin", "tsx");
    const r = await run([tsx, join(HERE, "probe.mjs")]);
    assert.equal(r.status, 0, r.stderr);
    assertDenied(JSON.parse(r.stdout));
  });

  it("Python: public egress fails, the harness port works", {
    skip: !existsSync(VENV_PY),
  }, async () => {
    const r = await run([VENV_PY, join(HERE, "probe.py")]);
    assert.equal(r.status, 0, r.stderr);
    assertDenied(JSON.parse(r.stdout));
  });

  it("passes the child's exit code through", async () => {
    const r = await run([process.execPath, "-e", "process.exit(7)"]);
    assert.equal(r.status, 7);
  });

  it("removes its per-run temp dir on exit", async () => {
    const count = () =>
      readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith("fz-")).length;
    const before = count();
    await run([process.execPath, "-e", "0"]);
    assert.equal(count(), before);
  });

  it("works when started through a symlink", async () => {
    const link = join(dir, "link-run.mjs");
    symlinkSync(RUN, link);
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [link, process.execPath, "-e", "process.exit(7)"], {
        env: { ...process.env, X402_REDTEAM_TASK: taskPath },
        stdio: "ignore",
      });
      child.on("close", resolve);
    });
    assert.equal(r, 7);
  });

  it("refuses an empty port, and proxy host mode", async () => {
    for (const task of [
      { base_url: "http://127.0.0.1:" },
      { base_url: "http://x", host_mode: "proxy" },
    ]) {
      const p = join(dir, "bad.json");
      writeFileSync(p, JSON.stringify(task));
      const r = await run([process.execPath, "-e", "0"], { X402_REDTEAM_TASK: p });
      assert.equal(r.status, 2, JSON.stringify(task));
    }
  });

  it("refuses to start without a harness port", async () => {
    const r = await run([process.execPath, "-e", "0"], { X402_REDTEAM_TASK: "" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to start/);
  });
});
