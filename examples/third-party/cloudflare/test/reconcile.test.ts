/**
 * Unit tests for the intent/capture matching and the issuance cross-check (U33 §3.3 rules
 * 2 and 4; U28 C4). Local only, like canary.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunNotes } from "../src/notes.js";
import type { Intent } from "../src/protocol.js";
import { type CapturedPayment, crossCheckIssuance, reconcile, reconcileOutDir } from "../src/reconcile.js";

const PAYEE = "0x9cA8A44a428a91F609eBC9FB0CA4cC3647c89012";
const ROUTE = "provider.test/mcp#get_item";
const intent = (over: Partial<Intent> = {}): Intent => ({
  route: ROUTE,
  pay_to: PAYEE,
  network: "eip155:84532",
  asset: "0x2",
  value_atomic: "10000",
  ...over,
});
const payment = (id: string, over: Partial<CapturedPayment> = {}): CapturedPayment => ({
  payment_id: id,
  capture: "header",
  network: "eip155:84532",
  to: PAYEE,
  route_key: ROUTE,
  ...over,
});
const call = (tool: string, outcome: string) =>
  ({
    k: 1,
    tool,
    signed: 0,
    verdict: "measured",
    outcome,
    reason: "",
    channels: { meta: false, structured: false, text: false },
    decisions: [],
    accepts_seen: [],
  }) as unknown as RunNotes["calls"][number];
const notes = (calls: RunNotes["calls"], intents: Intent[] = []): RunNotes => ({
  run_id: "r1",
  batch_id: "b",
  profile: "default",
  plan: { server: "provider.test", tools: calls.map((c) => c.tool), price: "0.01", role: "run" },
  price_atomic: "10000",
  loaded: null,
  calls,
  intents,
  egress: [],
  exit_code: 0,
  exit_reason: "measured",
});
const withCopy = { channels: { structured: {}, text: {}, meta: {} } };

describe("reconcile (C4)", () => {
  it("matches on route, payTo and network, whatever the amount", () => {
    const rec = reconcile(notes([call("get_item", "paid_delivered")], [intent({ value_atomic: "123456" })]), [payment("p1")], [
      { route_key: ROUTE, ...withCopy },
    ]);
    assert.equal(rec.unmeasured, false);
    assert.deepEqual(rec.intents_without_capture, []);
    assert.deepEqual(rec.captured_without_intent, []);
  });

  it("compares payTo case-insensitively", () => {
    const rec = reconcile(
      notes([call("get_item", "paid_delivered")], [intent({ pay_to: PAYEE.toLowerCase() })]),
      [payment("p1", { to: PAYEE.toUpperCase().replace("0X", "0x") })],
      [{ route_key: ROUTE, ...withCopy }],
    );
    assert.equal(rec.unmeasured, false);
  });

  it("leaves an intent unmatched on a network mismatch and makes the run unmeasured", () => {
    const rec = reconcile(notes([call("get_item", "paid_delivered")], [intent()]), [payment("p1", { network: "eip155:8453" })], [
      { route_key: ROUTE, ...withCopy },
    ]);
    assert.equal(rec.unmeasured, true);
    assert.equal(rec.intents_without_capture.length, 1);
    assert.deepEqual(rec.captured_without_intent, ["p1"]);
  });

  it("an intent with no capture at all makes the run unmeasured", () => {
    const rec = reconcile(notes([call("get_item", "paid_delivered")], [intent()]), [], [{ route_key: ROUTE, ...withCopy }]);
    assert.equal(rec.unmeasured, true);
  });

  it("flags an extra capture for review without making the run unmeasured", () => {
    const rec = reconcile(notes([call("get_item", "paid_delivered")], [intent()]), [payment("p1"), payment("p2")], [
      { route_key: ROUTE, ...withCopy },
    ]);
    assert.equal(rec.unmeasured, false);
    assert.deepEqual(rec.captured_without_intent, ["p2"]);
  });

  it("matches two intents in order", () => {
    const other = "0x1111111111111111111111111111111111111111";
    const rec = reconcile(
      notes([call("get_item", "paid_delivered")], [intent(), intent({ pay_to: other })]),
      [payment("p1", { to: other }), payment("p2")],
      [{ route_key: ROUTE, ...withCopy }],
    );
    assert.equal(rec.unmeasured, false);
    assert.equal(rec.intents, 2);
  });

  it("ignores non-header captures", () => {
    const rec = reconcile(notes([call("get_item", "paid_delivered")], [intent()]), [payment("p1", { capture: "rpc" })], [
      { route_key: ROUTE, ...withCopy },
    ]);
    assert.equal(rec.unmeasured, true);
  });
});

describe("issuance cross-check (M7 rule 2)", () => {
  it("agrees when the client saw what the adversary issued, with the _meta copy", () => {
    assert.deepEqual(
      crossCheckIssuance(notes([call("get_item", "paid_delivered")]), [{ route_key: ROUTE, ...withCopy }]),
      [],
    );
  });

  it("flags a payment request the adversary did not issue", () => {
    const out = crossCheckIssuance(notes([call("get_item", "declined")]), []);
    assert.equal(out.length, 1);
    assert.match(out[0] as string, /issued none/);
  });

  it("flags a challenge the client never saw", () => {
    const out = crossCheckIssuance(notes([call("get_item", "no_payment_due")]), [{ route_key: ROUTE, ...withCopy }]);
    assert.equal(out.length, 1);
    assert.match(out[0] as string, /client saw none/);
  });

  it("flags a challenge issued without the result _meta copy as not-reached", () => {
    const plain = { route_key: ROUTE };
    for (const outcome of ["paid_delivered", "no_payment_due", "not_reached"]) {
      const out = crossCheckIssuance(notes([call("get_item", outcome)]), [plain]);
      assert.ok(out.some((m) => /not-reached/.test(m)), outcome);
    }
  });

  it("accepts a JSON-RPC error issuance, which carries no result _meta", () => {
    const out = crossCheckIssuance(notes([call("get_item", "json_rpc_payment_error")]), [
      { route_key: ROUTE, channels: { error: {} } },
    ]);
    assert.deepEqual(out, []);
  });

  it("a free tool the adversary also served free agrees", () => {
    assert.deepEqual(crossCheckIssuance(notes([call("get_item", "no_payment_due")]), []), []);
  });

  it("makes the run unmeasured", () => {
    const rec = reconcile(notes([call("get_item", "no_payment_due")]), [], [{ route_key: ROUTE }]);
    assert.equal(rec.unmeasured, true);
    assert.equal(rec.issuance_mismatches.length >= 1, true);
  });
});

describe("reconcileOutDir", () => {
  it("writes the reconciliation into the notes", () => {
    const out = mkdtempSync(join(tmpdir(), "x402rt-cloudflare-rec-"));
    try {
      mkdirSync(join(out, "notes"));
      mkdirSync(join(out, "runs"));
      writeFileSync(join(out, "notes", "r1.json"), JSON.stringify(notes([call("get_item", "paid_delivered")], [intent()])));
      writeFileSync(
        join(out, "runs", "r1.json"),
        JSON.stringify({ payments: [payment("p1")], challenges: [{ route_key: ROUTE, ...withCopy }] }),
      );
      const result = reconcileOutDir(out);
      assert.equal(result.get("r1")?.unmeasured, false);
      const written = JSON.parse(readFileSync(join(out, "notes", "r1.json"), "utf8"));
      assert.equal(written.reconciliation.captured, 1);
      assert.deepEqual(written.reconciliation.issuance_mismatches, []);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
