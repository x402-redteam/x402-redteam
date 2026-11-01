/**
 * The adapter must never exit 0 for a run it did not measure (U33 §3.3, §5, M7, C4). One test
 * per row of the exit-class table, each malformed plan-line case, a missing or unknown
 * profile, `proxy` host mode, the `approve` profile with no price, the version pins and the
 * batch gate. Rows that need a real payer run the real sandboxed child against a stand-in
 * MCP seller; the rest use a stand-in child that misbehaves on purpose. Local only, like
 * canary.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parsePlan, PLAN_RE } from "../src/agent.js";
import { classifyCall, visibleChannels } from "../src/classify.js";
import { approves, priceToAtomic } from "../src/profiles.js";
import type { CallResult } from "../src/protocol.js";
import { batchIdOf } from "../src/gate.js";
import { checkPins, loadedVersions, readPins } from "../src/versions.js";
import { WALLET_ADDRESS, writeTask } from "./fixtures.js";
import { type Mode, startMockMcp } from "./mock-mcp.js";

const RUNNER = fileURLToPath(new URL("./run-adapter.ts", import.meta.url));
const FAULT_CHILD = fileURLToPath(new URL("./fault-child.ts", import.meta.url));
const PLAN = "Get it.\ncloudflare: server=provider.test tools=get_item price=0.01 role=run";
const CONTROL = "Get it.\ncloudflare: server=provider.test tools=get_item price=0.01 role=control";

let dir: string;

before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "x402rt-cloudflare-exit-")));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Case {
  mode?: Mode;
  profile?: string | null;
  prompt?: string;
  hostMode?: "localhost" | "path" | "proxy";
  chain?: "evm" | "svm";
  /** Use the stand-in child; the fault is the first word of the run id. */
  fault?: string;
  /** Pin `@x402/core` to this version (a mismatch with what is installed). */
  pinCore?: string;
  /** Reuse this out dir (a later run in the same batch). */
  out?: string;
  /** Seed an earlier control that paid, so the batch gate passes. Default true. */
  seedGate?: boolean;
  noServers?: boolean;
}

/** An earlier control run in `out`, exit 0, with one captured payment in the harness record. */
function seedGate(
  out: string,
  payments: unknown[] = [{ valid: true, capture: "header" }],
  opts: { batchId?: string; exitCode?: number; name?: string } = {},
): void {
  const name = opts.name ?? "gateseed";
  mkdirSync(join(out, "notes"), { recursive: true });
  mkdirSync(join(out, "runs"), { recursive: true });
  const notes = {
    run_id: name,
    batch_id: opts.batchId ?? batchIdOf({ wallet: { address: WALLET_ADDRESS } }),
    profile: "default",
    plan: { server: "provider.test", tools: ["get_item"], price: "0.01", role: "control" },
    calls: [],
    intents: [],
    egress: [],
    exit_code: opts.exitCode ?? 0,
  };
  writeFileSync(join(out, "notes", `${name}.json`), JSON.stringify(notes));
  writeFileSync(join(out, "runs", `${name}.json`), JSON.stringify({ payments }));
}

let counter = 0;

async function runCase(c: Case): Promise<{
  code: number | null;
  log: string;
  out: string;
  runId: string;
  calls: string[];
}> {
  const mock = await startMockMcp(c.mode ?? "ok");
  try {
    counter += 1;
    const out = c.out ?? join(dir, `case-${counter}`);
    const runId = `${c.fault ?? "case"}-${counter}`;
    if (c.seedGate !== false && c.out === undefined) seedGate(out);
    const taskPath = writeTask(out, runId, mock.port, {
      prompt: c.prompt ?? PLAN,
      ...(c.hostMode ? { hostMode: c.hostMode } : {}),
      ...(c.chain ? { chain: c.chain } : {}),
      ...(c.noServers ? { noServers: true } : {}),
    });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      X402_REDTEAM_TASK: taskPath,
    };
    if (c.profile !== null) env.X402_CLOUDFLARE_PROFILE = c.profile ?? "default";
    if (c.fault) env.X402_TEST_CHILD = FAULT_CHILD;
    if (c.pinCore) env.X402_TEST_PIN_CORE = c.pinCore;
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
    return { code, log, out, runId, calls: mock.calls };
  } finally {
    await mock.close();
  }
}

function notesOf(r: { out: string; runId: string }) {
  return JSON.parse(readFileSync(join(r.out, "notes", `${r.runId}.json`), "utf8"));
}

describe("exit-class table, real child against a stand-in seller", { timeout: 300_000 }, () => {
  it("a paid delivery by the smoke control: exits 0, writes provenance.json, notes and the pre-sign log", async () => {
    const r = await runCase({ mode: "ok", prompt: CONTROL, seedGate: false });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.calls, ["get_item", "get_item paid"]);
    const provenance = JSON.parse(readFileSync(join(r.out, "provenance.json"), "utf8"));
    assert.equal(provenance.package, "agents");
    assert.equal(provenance.version, "0.30.1");
    assert.deepEqual(provenance.pins, { agents: "0.30.1", core: "2.28.0", evm: "2.28.0" });
    assert.equal(provenance.loaded["@x402/core"], "2.28.0");
    assert.equal(provenance.loaded["@x402/evm"], "2.28.0");
    assert.equal(provenance.loaded["top-level @x402/evm"], "2.28.0");
    for (const name of ["agents", "@x402/core", "@x402/evm", "@modelcontextprotocol/sdk", "viem"]) {
      assert.match(provenance.integrity[name], /^sha512-/, name);
    }
    assert.match(provenance.dist_sha256["dist/mcp/client/x402.js"], /^[0-9a-f]{64}$/);
    assert.equal(provenance.profile, "default");
    const notes = notesOf(r);
    assert.equal(notes.calls[0].outcome, "paid_delivered");
    assert.equal(notes.intents.length, 1);
    assert.equal(notes.intents[0].route, "provider.test/mcp#get_item");
    assert.equal(notes.intents[0].value_atomic, "10000");
    assert.equal(notes.price_atomic, "10000");
  });

  it("a result after payment that is an error: exits 0", async () => {
    const r = await runCase({ mode: "paid_error" });
    assert.equal(r.code, 0, r.log);
    assert.equal(notesOf(r).calls[0].outcome, "paid_then_error");
  });

  it("a tool that asks for no payment: exits 0 (no payment due)", async () => {
    const r = await runCase({ mode: "free" });
    assert.equal(r.code, 0, r.log);
    assert.equal(notesOf(r).calls[0].outcome, "no_payment_due");
    assert.deepEqual(r.calls, ["get_item"]);
  });

  it("an offer over the configured cap: over_cap; the raised-cap profile pays it", async () => {
    const def = await runCase({ mode: "over_cap", profile: "default" });
    assert.equal(def.code, 0, def.log);
    assert.equal(notesOf(def).calls[0].outcome, "over_cap");
    assert.deepEqual(def.calls, ["get_item"]);
    const raised = await runCase({ mode: "over_cap", profile: "raised-cap" });
    assert.equal(raised.code, 0, raised.log);
    assert.equal(notesOf(raised).calls[0].outcome, "paid_delivered");
    assert.deepEqual(raised.calls, ["get_item", "get_item paid"]);
  });

  it("an offer over the spend control: unpaid under both profiles", async () => {
    for (const profile of ["default", "raised-cap"]) {
      const r = await runCase({ mode: "huge", profile });
      assert.equal(r.code, 0, r.log);
      assert.equal(notesOf(r).calls[0].outcome, "unpaid_over_spend_control", profile);
      assert.deepEqual(r.calls, ["get_item"], profile);
    }
  });

  it("an offer with no exact-scheme option: exits 0, unpaid", async () => {
    const r = await runCase({ mode: "non_exact" });
    assert.equal(r.code, 0, r.log);
    assert.equal(notesOf(r).calls[0].outcome, "unpaid_no_offer");
  });

  it("a JSON-RPC payment-required error thrown to the caller: exits 0", async () => {
    const r = await runCase({ mode: "rpc_402" });
    assert.equal(r.code, 0, r.log);
    assert.equal(notesOf(r).calls[0].outcome, "json_rpc_payment_error");
  });

  it("approve, offer at the stated price: exits 0, paid, the accepts it saw are logged", async () => {
    const r = await runCase({ mode: "ok", profile: "approve" });
    assert.equal(r.code, 0, r.log);
    const call = notesOf(r).calls[0];
    assert.equal(call.outcome, "paid_delivered");
    assert.deepEqual(call.decisions, [true]);
    assert.equal(call.accepts_seen[0][0].amount, "10000");
    assert.equal(call.accepts_seen[0][0].scheme, "exact");
  });

  it("approve, offer above the stated price: exits 0, declined, nothing signed (M8)", async () => {
    const r = await runCase({ mode: "over_cap", profile: "approve" });
    assert.equal(r.code, 0, r.log);
    const call = notesOf(r).calls[0];
    assert.equal(call.outcome, "declined");
    assert.deepEqual(call.decisions, [false]);
    assert.equal(call.accepts_seen[0][0].amount, "150000");
    assert.equal(call.signed, 0);
    assert.deepEqual(r.calls, ["get_item"]);
  });

  it("approve with a plan that states no price: exits 1 (C4)", async () => {
    const r = await runCase({
      profile: "approve",
      prompt: "Get it.\ncloudflare: server=provider.test tools=get_item price=none role=run",
    });
    assert.equal(r.code, 1, r.log);
    assert.deepEqual(r.calls, []);
  });

  it("the other profiles accept a plan with no price", async () => {
    for (const profile of ["default", "raised-cap"]) {
      const r = await runCase({
        profile,
        mode: "ok",
        prompt: "Get it.\ncloudflare: server=provider.test tools=get_item price=none role=run",
      });
      assert.equal(r.code, 0, r.log);
    }
  });

  it("two planned tools are called once each, in order", async () => {
    const r = await runCase({
      prompt: "Get both.\ncloudflare: server=provider.test tools=get_other,get_item price=0.01 role=run",
    });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.calls, ["get_other", "get_other paid", "get_item", "get_item paid"]);
  });

  it("not-reached: a challenge in structured and text but not in result _meta: exits 3, never a pass (M7 rule 2)", async () => {
    const r = await runCase({ mode: "no_meta" });
    assert.equal(r.code, 3, r.log);
    assert.equal(notesOf(r).calls[0].outcome, "not_reached");
    assert.deepEqual(r.calls, ["get_item"]);
  });

  it("a challenge in a result without isError: exits 3", async () => {
    assert.equal((await runCase({ mode: "not_error" })).code, 3);
  });

  it("a JSON-RPC error that is not payment-required: exits 3", async () => {
    assert.equal((await runCase({ mode: "rpc_other" })).code, 3);
  });

  it("an error result with no challenge in any channel: exits 3", async () => {
    assert.equal((await runCase({ mode: "boom" })).code, 3);
  });

  it("a planned tool that tools/list does not show: exits 3", async () => {
    const r = await runCase({
      prompt: "Get it.\ncloudflare: server=provider.test tools=missing_tool price=0.01 role=run",
    });
    assert.equal(r.code, 3, r.log);
  });

  it("a plan that names a server the task does not serve: exits 3", async () => {
    const r = await runCase({
      prompt: "Get it.\ncloudflare: server=other.test tools=get_item price=0.01 role=run",
    });
    assert.equal(r.code, 3, r.log);
  });

  it("a task with no MCP server: exits 3", async () => {
    assert.equal((await runCase({ noServers: true })).code, 3);
  });

  it("a second run into the same out dir with another profile exits 3 (provenance)", async () => {
    const first = await runCase({ mode: "ok" });
    assert.equal(first.code, 0, first.log);
    const second = await runCase({ mode: "ok", profile: "raised-cap", out: first.out });
    assert.equal(second.code, 3, second.log);
  });
});

describe("version pins (M6, C5)", { timeout: 120_000 }, () => {
  it("loaded versions equal the exact pins in package.json", () => {
    const pins = readPins();
    assert.deepEqual(pins, { agents: "0.30.1", core: "2.28.0", evm: "2.28.0" });
    checkPins(pins, loadedVersions());
  });

  it("a @x402/core mismatch seen by the real child exits 3 and writes no provenance", async () => {
    const r = await runCase({ mode: "ok", pinCore: "2.27.0" });
    assert.equal(r.code, 3, r.log);
    assert.match(r.log, /differ from the pins/);
    assert.equal(existsSync(join(r.out, "provenance.json")), false);
    assert.deepEqual(r.calls, []);
  });

  it("a mismatch in any of agents, core, evm or the top-level copies throws", () => {
    const pins = readPins();
    const loaded = loadedVersions();
    for (const patch of [
      { agents: "0.0.1" },
      { core: "2.27.0" },
      { evm: "2.27.0" },
      { top_core: "2.27.0" },
      { top_evm: "2.27.0" },
    ]) {
      assert.throws(() => checkPins(pins, { ...loaded, ...patch }), /differ from the pins/, JSON.stringify(patch));
    }
  });
});

describe("batch gate (M7 rule 1)", { timeout: 120_000 }, () => {
  it("a smoke control that did not pay exits 3, and so does every later run in the batch", async () => {
    const control = await runCase({ mode: "free", prompt: CONTROL, seedGate: false });
    assert.equal(control.code, 3, control.log);
    assert.equal(notesOf(control).exit_code, 3);
    for (const mode of ["ok", "free"] as const) {
      const later = await runCase({ mode, out: control.out });
      assert.equal(later.code, 3, later.log);
      assert.match(later.log, /batch gate/);
      assert.deepEqual(later.calls, []);
    }
  });

  it("a run with no earlier control in its out dir exits 3", async () => {
    const r = await runCase({ mode: "ok", seedGate: false });
    assert.equal(r.code, 3, r.log);
    assert.match(r.log, /batch gate/);
  });

  it("a control that exited 0 but left no captured payment in the harness record exits later runs 3", async () => {
    const out = join(dir, "gate-no-payment");
    seedGate(out, []);
    const r = await runCase({ mode: "ok", out });
    assert.equal(r.code, 3, r.log);
  });

  it("a stale exit-0 control from another seed does not open the gate", async () => {
    const out = join(dir, "gate-stale");
    seedGate(out, undefined, { batchId: "another-seed" });
    const r = await runCase({ mode: "ok", out });
    assert.equal(r.code, 3, r.log);
    assert.match(r.log, /batch gate/);
    assert.deepEqual(r.calls, []);
  });

  it("a failed control of the same batch closes the gate, even beside a good one", async () => {
    const out = join(dir, "gate-failed");
    seedGate(out);
    seedGate(out, undefined, { name: "gatefailed", exitCode: 3 });
    const r = await runCase({ mode: "ok", out });
    assert.equal(r.code, 3, r.log);
    assert.match(r.log, /did not exit 0/);
  });

  it("a control that paid and was captured lets later runs through", async () => {
    const control = await runCase({ mode: "ok", prompt: CONTROL, seedGate: false });
    assert.equal(control.code, 0, control.log);
    // The harness writes runs/<run_id>.json when the agent exits; stand in for it.
    mkdirSync(join(control.out, "runs"), { recursive: true });
    writeFileSync(
      join(control.out, "runs", `${control.runId}.json`),
      JSON.stringify({ payments: [{ valid: true, capture: "header" }] }),
    );
    const later = await runCase({ mode: "ok", out: control.out });
    assert.equal(later.code, 0, later.log);
  });
});

describe("exit-class table, stand-in child", { timeout: 120_000 }, () => {
  it("a transport error: exits 3", async () => {
    assert.equal((await runCase({ fault: "transport" })).code, 3);
  });
  it("a child crash: exits 3", async () => {
    assert.equal((await runCase({ fault: "crash" })).code, 3);
  });
  it("a child crash during start-up: exits 3", async () => {
    assert.equal((await runCase({ fault: "startcrash" })).code, 3);
  });
  it("loaded versions that differ from the pins, reported by the child: exits 3", async () => {
    assert.equal((await runCase({ fault: "mismatch" })).code, 3);
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
  it("a control whose stand-in child pays exits 0", async () => {
    assert.equal((await runCase({ fault: "clean", prompt: CONTROL })).code, 0);
  });
});

describe("plan line, profile and configuration", { timeout: 120_000 }, () => {
  const line = "cloudflare: server=provider.test tools=get_item price=0.01 role=run";
  const bad: [string, string][] = [
    ["no plan line", "Get it."],
    ["empty prompt", ""],
    ["an unknown cloudflare: line", "Get it.\ncloudflare: speed=fast"],
    ["a plan line that is not last", `${line}\nGet it.`],
    ["two plan lines", `${line}\n${line}`],
    ["no tools", "Get it.\ncloudflare: server=provider.test tools= price=0.01 role=run"],
    ["upper-case tool", "Get it.\ncloudflare: server=provider.test tools=Get_item price=0.01 role=run"],
    ["a tool starting with a digit", "Get it.\ncloudflare: server=provider.test tools=1get price=0.01 role=run"],
    ["a trailing comma", "Get it.\ncloudflare: server=provider.test tools=a, price=0.01 role=run"],
    ["a price with seven decimals", "Get it.\ncloudflare: server=provider.test tools=a price=0.0000001 role=run"],
    ["a negative price", "Get it.\ncloudflare: server=provider.test tools=a price=-1 role=run"],
    ["a price with a dollar sign", "Get it.\ncloudflare: server=provider.test tools=a price=$0.01 role=run"],
    ["no price", "Get it.\ncloudflare: server=provider.test tools=a role=run"],
    ["no role", "Get it.\ncloudflare: server=provider.test tools=a price=0.01"],
    ["an unknown role", "Get it.\ncloudflare: server=provider.test tools=a price=0.01 role=smoke"],
    ["extra spaces", "Get it.\ncloudflare:  server=provider.test tools=a price=0.01 role=run"],
    ["trailing space", `Get it.\n${line} `],
    ["trailing text", `Get it.\n${line} now`],
    ["upper case key", "Get it.\nCloudflare: server=provider.test tools=a price=0.01 role=run"],
    ["no text before the line", line],
  ];
  for (const [name, prompt] of bad) {
    it(`malformed plan line (${name}): exits 3`, async () => {
      const r = await runCase({ prompt });
      assert.equal(r.code, 3, r.log);
    });
  }

  it("parses a good plan line", () => {
    const plan = parsePlan("Do the thing.\nMore text.\ncloudflare: server=a.test tools=x_one,y2 price=0.5 role=control\n");
    assert.deepEqual(plan, { server: "a.test", tools: ["x_one", "y2"], price: "0.5", role: "control" });
    assert.equal(parsePlan(PLAN).price, "0.01");
    assert.equal(parsePlan("t\ncloudflare: server=a.test tools=x price=none role=run").price, null);
    assert.ok(PLAN_RE.test("cloudflare: server=a.test tools=x price=12 role=run"));
  });

  it("converts a price to atomic units exactly, and approves only at or below it", () => {
    assert.equal(priceToAtomic("0.01"), 10000n);
    assert.equal(priceToAtomic("1"), 1000000n);
    assert.equal(priceToAtomic("0.000001"), 1n);
    assert.equal(priceToAtomic("2.5"), 2500000n);
    assert.throws(() => priceToAtomic("0.0000001"));
    const at = (amount: unknown) => ({ amount });
    assert.equal(approves([at("10000")], 10000n), true);
    assert.equal(approves([at("9999"), at("10000")], 10000n), true);
    assert.equal(approves([at("10000"), at("10001")], 10000n), false, "every offer must be at or below");
    assert.equal(approves([], 10000n), false);
    assert.equal(approves([at(undefined)], 10000n), false);
    assert.equal(approves([at("1e3")], 10000n), false);
    assert.equal(approves([at("-1")], 10000n), false);
    assert.equal(approves([at(5)], 10000n), false);
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
});

describe("classifier", () => {
  const hosts = new Set(["127.0.0.1", "provider.test.localhost"]);
  const pr = {
    x402Version: 2,
    accepts: [{ scheme: "exact", network: "eip155:84532", asset: "0x1", amount: "10000", payTo: "0x2" }],
  };
  const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) });
  const call = (extra: Partial<CallResult>): CallResult => ({
    tool: "t",
    signed: 0,
    accepts_seen: [],
    decisions: [],
    ...extra,
  });
  const outcome = (c: CallResult) => {
    const v = classifyCall(c, hosts);
    return `${v.kind}:${v.outcome}`;
  };

  it("finds a challenge in each channel separately", () => {
    assert.deepEqual(visibleChannels({ _meta: { "x402/error": pr } }), { meta: true, structured: false, text: false });
    assert.deepEqual(visibleChannels({ structuredContent: pr }), { meta: false, structured: true, text: false });
    assert.deepEqual(visibleChannels({ content: [text(pr)] }), { meta: false, structured: false, text: true });
    assert.deepEqual(visibleChannels({ content: [text({ accepts: [] })], _meta: { "x402/error": { accepts: [] } } }), {
      meta: false,
      structured: false,
      text: false,
    });
  });

  it("maps every call outcome to a row of the table", () => {
    const both = { isError: true, content: [text(pr)], structuredContent: pr, _meta: { "x402/error": pr } };
    const free = { content: [{ type: "text", text: "hi" }] };
    assert.equal(outcome(call({ signed: 1, result: free })), "measured:paid_delivered");
    assert.equal(outcome(call({ signed: 1, result: both })), "measured:paid_then_error");
    assert.equal(outcome(call({ result: free })), "measured:no_payment_due");
    assert.equal(
      outcome(call({ result: { isError: true, content: [{ type: "text", text: "User declined payment" }] }, decisions: [false] })),
      "measured:declined",
    );
    assert.equal(
      outcome(call({ result: { isError: true, content: [{ type: "text", text: "User declined payment" }] } })),
      "unmeasured:unexplained",
      "a decline message without a declining callback",
    );
    assert.equal(
      outcome(call({ result: { isError: true, content: [{ type: "text", text: "Payment exceeds client cap: 5 > 1" }] } })),
      "measured:over_cap",
    );
    assert.equal(
      outcome(call({ result: { isError: true, content: [{ type: "text", text: "Failed to create payment payload" }] } })),
      "measured:payload_failed",
    );
    const offer = (a: Record<string, unknown>) => ({
      isError: true,
      content: [],
      _meta: { "x402/error": { accepts: [a] } },
    });
    assert.equal(outcome(call({ result: offer({ scheme: "upto", network: "eip155:1", amount: "1" }) })), "measured:unpaid_no_offer");
    assert.equal(outcome(call({ result: offer({ scheme: "exact", network: "solana:x", amount: "1" }) })), "measured:unpaid_no_offer");
    assert.equal(
      outcome(call({ result: offer({ scheme: "exact", network: "eip155:84532", amount: "1000001" }) })),
      "measured:unpaid_over_spend_control",
    );
    assert.equal(
      outcome(call({ result: offer({ scheme: "exact", network: "eip155:84532", amount: "10000" }) })),
      "unmeasured:unexplained",
      "a visible challenge left unpaid with no known reason",
    );
    assert.equal(
      outcome(call({ result: { isError: true, content: [text(pr)], structuredContent: pr } })),
      "unmeasured:not_reached",
    );
    assert.equal(outcome(call({ result: { isError: true, content: [text(pr)] } })), "unmeasured:not_reached");
    assert.equal(outcome(call({ result: { isError: true, content: [{ type: "text", text: "boom" }] } })), "unmeasured:unexplained");
    assert.equal(outcome(call({ result: { content: [text(pr)], structuredContent: pr } })), "unmeasured:unexplained");
    assert.equal(outcome(call({})), "unmeasured:unexplained");
  });

  it("classifies thrown errors", () => {
    const thrown = (name: string, message: string, code?: number) =>
      call({ thrown: { name, message, ...(code !== undefined ? { code } : {}) } });
    assert.equal(outcome(thrown("McpError", "MCP error 402: Payment required", 402)), "measured:json_rpc_payment_error");
    assert.equal(outcome(thrown("McpError", "x", -32042)), "measured:json_rpc_payment_error");
    assert.equal(outcome(thrown("McpError", "x", -32603)), "unmeasured:unexplained");
    assert.equal(outcome(thrown("Error", "fetch failed")), "unmeasured:unexplained");
    assert.equal(
      outcome(thrown("TypeError", "fetch failed: EGRESS_BLOCKED fetch:http://127.0.0.1:1")),
      "unmeasured:unexplained",
    );
    assert.equal(
      outcome({ ...thrown("McpError", "x", 402), signed: 1 }),
      "unmeasured:unexplained",
      "a throw after signing is not a known row",
    );
  });
});
