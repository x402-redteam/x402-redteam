/**
 * The adapter must never exit 0 for a run it did not measure (review item 1): an action
 * error in the child is swallowed by the crawl, so it is recorded separately and ends the
 * run with exit 3. Also checks that provenance.json is written next to the out dir.
 * Local only, like canary.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TASK_HOST, writeTask } from "./fixtures.js";

const RUNNER = fileURLToPath(new URL("./run-with-actions.ts", import.meta.url));

let server: Server;
let port: number;
let dir: string;

before(async () => {
  server = createServer((_req, res) => res.end("a plain page with no links"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "x402rt-agentkit-exit-")));
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function runAdapter(outDir: string, actions: object): Promise<{ code: number | null; log: string }> {
  const taskPath = writeTask(outDir, "exit", port, `Fetch http://${TASK_HOST}:${port}/page`);
  const proc = spawn(process.execPath, [...process.execArgv, RUNNER], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      X402_REDTEAM_TASK: taskPath,
      X402_AGENTKIT_MODE: "autopay",
      X402_TEST_ACTIONS: JSON.stringify(actions),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => {
    log += d;
  });
  proc.stderr.on("data", (d) => {
    log += d;
  });
  return new Promise((resolve) => proc.on("close", (code) => resolve({ code, log })));
}

describe("adapter exit codes", { timeout: 120_000 }, () => {
  it("exits 0 for a clean crawl and writes provenance.json", async () => {
    const out = join(dir, "clean");
    const { code, log } = await runAdapter(out, {});
    assert.equal(code, 0, log);
    const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"));
    assert.equal(provenance.mode, "autopay");
    assert.equal(provenance.versions["@coinbase/agentkit"], "0.10.4");
    assert.equal(provenance.versions["@x402/core"], provenance.x402_override);
    assert.match(provenance.agentkit_integrity, /^sha512-/);
    assert.match(provenance.lockfile_sha256, /^[0-9a-f]{64}$/);
  });

  it("exits 3, not 0, when an action name is wrong", async () => {
    const out = join(dir, "wrong-action");
    const { code, log } = await runAdapter(out, {
      autopay: "X402ActionProvider_no_such_action",
    });
    assert.equal(code, 3, log);
    assert.match(log, /unknown action X402ActionProvider_no_such_action/);
    assert.ok(existsSync(join(out, "provenance.json")));
  });
});
