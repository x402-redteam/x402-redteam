/**
 * The adapter must never exit 0 for a run it did not measure (U28 §5, §7.3, M1, C3). One
 * test per row of the exit-class table, each malformed plan-line case, a missing or unknown
 * profile, `proxy` host mode and the budget profile with no budget. Rows that need a real
 * payer run the real sandboxed child against a stand-in upstream; the rest use a stand-in
 * child that misbehaves on purpose. Local only, like canary.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { messageFor, PLAN_RE, parsePlan } from "../src/agent.js";
import { classifyChat } from "../src/classify.js";
import { verifyHandle } from "../src/handle-check.js";
import { trackCatalogFetches } from "../src/catalog.js";
import { type Mode, startMock } from "./mock-upstream.js";
import { writeTask } from "./fixtures.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const RUNNER = fileURLToPath(new URL("./run-adapter.ts", import.meta.url));
const FAULT_CHILD = fileURLToPath(new URL("./fault-child.ts", import.meta.url));
const PLAN = "Say hello.\nclawrouter: model=openai/gpt-4o-mini calls=1 body=same";

let dir: string;

before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "x402rt-clawrouter-exit-")));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Case {
  mode?: Mode;
  profile?: string | null;
  prompt?: string;
  budgetUsd?: number;
  hostMode?: "localhost" | "path" | "proxy";
  chain?: "evm" | "svm";
  parallel?: boolean;
  /** Use the stand-in child; the fault is the first word of the run id. */
  fault?: string;
}

let counter = 0;
async function runCase(c: Case): Promise<{ code: number | null; log: string; out: string; runId: string }> {
  const mock = await startMock(c.mode ?? "ok");
  try {
    counter += 1;
    const out = join(dir, `case-${counter}`);
    const runId = `${c.fault ?? "case"}-${counter}`;
    const taskPath = writeTask(out, runId, mock.port, {
      prompt: c.prompt ?? PLAN,
      ...(c.budgetUsd !== undefined ? { budgetUsd: c.budgetUsd } : {}),
      ...(c.hostMode ? { hostMode: c.hostMode } : {}),
      ...(c.chain ? { chain: c.chain } : {}),
      ...(c.parallel ? { parallel: true } : {}),
    });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      X402_REDTEAM_TASK: taskPath,
    };
    if (c.profile !== null) env.X402_CLAWROUTER_PROFILE = c.profile ?? "defaults";
    if (c.fault) env.X402_TEST_CHILD = FAULT_CHILD;
    const proc = spawn(process.execPath, [...process.execArgv, RUNNER], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    proc.stdout.on("data", (d) => {
      log += d;
    });
    proc.stderr.on("data", (d) => {
      log += d;
    });
    const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
    return { code, log, out, runId };
  } finally {
    await mock.close();
  }
}

describe("exit-class table, real child against a stand-in upstream", { timeout: 300_000 }, () => {
  it("success: exits 0 and writes provenance.json and run notes", async () => {
    const r = await runCase({ mode: "ok" });
    assert.equal(r.code, 0, r.log);
    const provenance = JSON.parse(readFileSync(join(r.out, "provenance.json"), "utf8"));
    assert.equal(provenance.package, "@blockrun/clawrouter");
    assert.equal(provenance.version, "0.12.282");
    assert.match(provenance.integrity, /^sha512-/);
    assert.match(provenance.dist_index_sha256, /^[0-9a-f]{64}$/);
    assert.match(provenance.bundled_versions.viem, /^\d+\.\d+\.\d+$/);
    assert.equal(provenance.bundled_versions["@x402/core"], undefined);
    assert.equal(provenance.installed_sibling_versions["@x402/core"], "2.28.0");
    assert.equal(provenance.profile, "defaults");
    const notes = JSON.parse(readFileSync(join(r.out, "notes", `${r.runId}.json`), "utf8"));
    assert.equal(notes.catalog_settled, true);
    assert.equal(notes.intents.length, 1);
    assert.equal(notes.calls[0].verdict, "measured");
  });

  it("a passed-through 402 challenge: exits 0", async () => {
    const r = await runCase({ mode: "forever" });
    assert.equal(r.code, 0, r.log);
  });

  it("a spend-policy error (budget profile, quote over the cap): exits 0", async () => {
    const r = await runCase({ mode: "expensive", profile: "budget", budgetUsd: 0.05 });
    assert.equal(r.code, 0, r.log);
    const notes = JSON.parse(readFileSync(join(r.out, "notes", `${r.runId}.json`), "utf8"));
    assert.match(notes.calls[0].reason, /spend_policy_denied/);
  });

  it("a cost-cap error (budget profile, estimate over the cap): exits 0", async () => {
    const r = await runCase({ mode: "ok", profile: "budget", budgetUsd: 0.0000001 });
    assert.equal(r.code, 0, r.log);
    const notes = JSON.parse(readFileSync(join(r.out, "notes", `${r.runId}.json`), "utf8"));
    assert.match(notes.calls[0].reason, /cost_cap_exceeded/);
  });

  it("a payment-parse error: exits 0", async () => {
    const r = await runCase({ mode: "parse" });
    assert.equal(r.code, 0, r.log);
    const notes = JSON.parse(readFileSync(join(r.out, "notes", `${r.runId}.json`), "utf8"));
    assert.equal(notes.calls[0].reason, "payment parse error");
  });

  it("an invalid_payment reply to a payment: exits 0", async () => {
    const r = await runCase({ mode: "invalid" });
    assert.equal(r.code, 0, r.log);
  });

  it("a 404 from the upstream: exits 3", async () => {
    const r = await runCase({ mode: "notfound" });
    assert.equal(r.code, 3, r.log);
  });

  it("a 409 no_run_loaded from the upstream: exits 3", async () => {
    const r = await runCase({ mode: "norun" });
    assert.equal(r.code, 3, r.log);
  });

  it("an error body not in the table: exits 3", async () => {
    const r = await runCase({ mode: "boom" });
    assert.equal(r.code, 3, r.log);
  });

  it("a second run into the same out dir with another profile exits 3 (provenance)", async () => {
    const first = await runCase({ mode: "ok" });
    assert.equal(first.code, 0, first.log);
    // Same out dir, different profile: the provenance check must refuse it.
    const mock = await startMock("ok");
    try {
      const taskPath = writeTask(first.out, "second", mock.port, { prompt: PLAN });
      const proc = spawn(process.execPath, [...process.execArgv, RUNNER], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          X402_REDTEAM_TASK: taskPath,
          X402_CLAWROUTER_PROFILE: "budget",
        },
        stdio: "ignore",
      });
      const code = await new Promise<number | null>((resolve) => proc.on("close", resolve));
      assert.equal(code, 3);
    } finally {
      await mock.close();
    }
  });
});

describe("exit-class table, stand-in child", { timeout: 120_000 }, () => {
  it("a transport error to the child's own proxy: exits 3", async () => {
    assert.equal((await runCase({ fault: "transport" })).code, 3);
  });
  it("a child crash: exits 3", async () => {
    assert.equal((await runCase({ fault: "crash" })).code, 3);
  });
  it("a child crash during start-up: exits 3", async () => {
    assert.equal((await runCase({ fault: "startcrash" })).code, 3);
  });
  it("a wallet or port mismatch reported by the child: exits 3", async () => {
    assert.equal((await runCase({ fault: "mismatch" })).code, 3);
  });
  it("catalog_settled: false: exits 3 and writes no provenance", async () => {
    const r = await runCase({ fault: "unsettled" });
    assert.equal(r.code, 3, r.log);
    assert.equal(existsSync(join(r.out, "provenance.json")), false);
    const notes = JSON.parse(readFileSync(join(r.out, "notes", `${r.runId}.json`), "utf8"));
    assert.equal(notes.catalog_settled, false);
  });
  it("an EGRESS_BLOCKED naming a task host: exits 3", async () => {
    assert.equal((await runCase({ fault: "taskhost" })).code, 3);
  });
  it("an EGRESS_BLOCKED that follows a pre-sign intent: exits 3", async () => {
    assert.equal((await runCase({ fault: "egressafter" })).code, 3);
  });
  it("an EGRESS_BLOCKED of a non-task host with no intent is measured: exits 0", async () => {
    assert.equal((await runCase({ fault: "egressfree" })).code, 0);
  });
  it("a clean stand-in child exits 0", async () => {
    assert.equal((await runCase({ fault: "clean" })).code, 0);
  });
});

describe("plan line, profile and configuration", { timeout: 120_000 }, () => {
  const bad: [string, string][] = [
    ["no plan line", "Say hello."],
    ["empty prompt", ""],
    ["an unknown clawrouter: line", "Say hello.\nclawrouter: speed=fast"],
    ["a plan line that is not last", "clawrouter: model=m calls=1 body=same\nSay hello."],
    ["two plan lines", "clawrouter: model=m calls=1 body=same\nclawrouter: model=m calls=2 body=same"],
    ["calls=0", "Say hello.\nclawrouter: model=m calls=0 body=same"],
    ["calls=100", "Say hello.\nclawrouter: model=m calls=100 body=same"],
    ["calls=007", "Say hello.\nclawrouter: model=m calls=007 body=same"],
    ["calls missing", "Say hello.\nclawrouter: model=m body=same"],
    ["body=other", "Say hello.\nclawrouter: model=m calls=1 body=other"],
    ["no model", "Say hello.\nclawrouter: model= calls=1 body=same"],
    ["extra spaces", "Say hello.\nclawrouter:  model=m calls=1 body=same"],
    ["trailing space", "Say hello.\nclawrouter: model=m calls=1 body=same "],
    ["trailing text", "Say hello.\nclawrouter: model=m calls=1 body=same now"],
    ["upper case key", "Say hello.\nClawrouter: model=m calls=1 body=same"],
    ["no text before the line", "clawrouter: model=m calls=1 body=same"],
  ];
  for (const [name, prompt] of bad) {
    it(`malformed plan line (${name}): exits 3`, async () => {
      const r = await runCase({ prompt });
      assert.equal(r.code, 3, r.log);
    });
  }

  it("parses a good plan line and builds distinct bodies", () => {
    const plan = parsePlan("Do the thing.\nMore text.\nclawrouter: model=blockrun/auto calls=3 body=distinct\n");
    assert.deepEqual(
      { model: plan.model, calls: plan.calls, body: plan.body, message: plan.message },
      { model: "blockrun/auto", calls: 3, body: "distinct", message: "Do the thing.\nMore text." },
    );
    assert.equal(messageFor(plan, 2), "Do the thing.\nMore text. (call 2 of 3)");
    assert.equal(messageFor({ ...plan, body: "same" }, 2), "Do the thing.\nMore text.");
    assert.ok(PLAN_RE.test("clawrouter: model=a/b calls=99 body=same"));
  });

  it("a missing profile: exits 1", async () => {
    assert.equal((await runCase({ profile: null })).code, 1);
  });
  it("an unknown profile: exits 1", async () => {
    assert.equal((await runCase({ profile: "strict" })).code, 1);
  });
  it("proxy host mode: exits 1", async () => {
    assert.equal((await runCase({ hostMode: "proxy" })).code, 1);
  });
  it("an svm task: exits 1", async () => {
    assert.equal((await runCase({ chain: "svm" })).code, 1);
  });
  it("the budget profile with budget_usd 0: exits 3", async () => {
    assert.equal((await runCase({ profile: "budget", budgetUsd: 0 })).code, 3);
  });
});

describe("classifier and start-up checks", () => {
  const hosts = new Set(["127.0.0.1", "provider.test.localhost"]);
  const chat = (status: number, body: string) => ({ status, body });

  it("keys on status and origin (C3)", () => {
    const kind = (status: number, body: string) => classifyChat(chat(status, body), hosts).kind;
    assert.equal(kind(200, "{}"), "measured");
    assert.equal(kind(402, JSON.stringify({ x402Version: 2, accepts: [{}] })), "measured");
    assert.equal(kind(402, '{"error":"invalid_payment"}'), "measured");
    assert.equal(kind(400, '{"error":"invalid_payment"}'), "measured");
    assert.equal(kind(403, '{"error":{"type":"spend_policy_denied"}}'), "measured");
    assert.equal(kind(429, '{"error":{"type":"cost_cap_exceeded"}}'), "measured");
    assert.equal(kind(502, '{"error":{"type":"payment_in_doubt"}}'), "measured");
    assert.equal(kind(500, "Failed to parse payment requirements: x"), "measured");
    assert.equal(kind(404, "not found"), "unmeasured");
    assert.equal(kind(409, '{"error":"no_run_loaded"}'), "unmeasured");
    assert.equal(kind(500, '{"error":{"type":"proxy_error"}}'), "unmeasured");
    assert.equal(kind(402, "pay me"), "unmeasured");
    assert.equal(kind(500, "fetch failed: EGRESS_BLOCKED fetch:http://127.0.0.1:1"), "unmeasured");
    assert.equal(
      classifyChat({ status: 0, body: "", transport_error: "ECONNREFUSED" }, hosts).kind,
      "unmeasured",
    );
  });

  it("checks port, wallet mode and wallet address, case-insensitively (N3)", () => {
    const handle = { port: 5000, authMode: "wallet", walletAddress: "0xAbCd" };
    verifyHandle(handle, { port: 5000, walletAddress: "0xabcd" });
    assert.throws(() => verifyHandle(handle, { port: 5001, walletAddress: "0xabcd" }), /port/);
    assert.throws(() => verifyHandle({ ...handle, authMode: "api-key" }, { port: 5000, walletAddress: "0xabcd" }), /auth mode/);
    assert.throws(() => verifyHandle({ ...handle, walletAddress: "" }, { port: 5000, walletAddress: "0xabcd" }), /wallet/);
  });

  it("settles after the body is read and one macrotask, and times out otherwise (C1)", async () => {
    const original = globalThis.fetch;
    let release: (() => void) | undefined;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"data":[');
        release = () => res.end("]}");
        return;
      }
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const tracker = trackCatalogFetches(base);
      assert.equal(await tracker.settled(50), false, "nothing started yet");
      const pending = fetch(`${base}/v1/models?format=json`);
      await fetch(`${base}/other`); // not a catalog fetch
      assert.equal(tracker.count(), 1);
      assert.equal(await tracker.settled(100), false, "the body is still open");
      const res = await pending;
      release?.();
      await res.text();
      assert.equal(await tracker.settled(2000), true);
    } finally {
      globalThis.fetch = original;
      server.closeAllConnections();
      server.close();
    }
  });
});
