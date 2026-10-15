/** Unit tests for the intent/capture matching (U28 C4). Local only, like canary.test.ts. */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { InMemorySpendControlStorage, SpendControl } from "@blockrun/clawrouter";
import { ObservingSpendControl } from "../src/observing-spend-control.js";
import { INTENT_PREFIX, type Intent } from "../src/protocol.js";
import { type CapturedPayment, reconcile } from "../src/reconcile.js";

const PAYEE = "0x9cA8A44a428a91F609eBC9FB0CA4cC3647c89012";
const intent = (over: Partial<Intent> = {}): Intent => ({
  route: "/v1/chat/completions",
  pay_to: PAYEE,
  network: "eip155:84532",
  asset: "0x2",
  quoted_usd: 0.01,
  ...over,
});
const payment = (id: string, over: Partial<CapturedPayment> = {}): CapturedPayment => ({
  payment_id: id,
  capture: "header",
  network: "eip155:84532",
  to: PAYEE,
  route_key: "provider.test/v1/chat/completions",
  ...over,
});

describe("reconcile (C4)", () => {
  it("matches on route, payTo and network, whatever the amount", () => {
    const rec = reconcile([intent({ quoted_usd: 123 })], [payment("p1")]);
    assert.equal(rec.unmeasured, false);
    assert.deepEqual(rec.intents_without_capture, []);
    assert.deepEqual(rec.captured_without_intent, []);
  });

  it("compares payTo case-insensitively", () => {
    const rec = reconcile([intent({ pay_to: PAYEE.toLowerCase() })], [payment("p1", { to: PAYEE.toUpperCase().replace("0X", "0x") })]);
    assert.equal(rec.unmeasured, false);
  });

  it("leaves an intent unmatched on a network mismatch and makes the run unmeasured", () => {
    const rec = reconcile([intent()], [payment("p1", { network: "eip155:8453" })]);
    assert.equal(rec.unmeasured, true);
    assert.equal(rec.intents_without_capture.length, 1);
    assert.deepEqual(rec.captured_without_intent, ["p1"]);
  });

  it("flags an extra capture for review without making the run unmeasured", () => {
    const rec = reconcile([intent()], [payment("p1"), payment("p2")]);
    assert.equal(rec.unmeasured, false);
    assert.deepEqual(rec.captured_without_intent, ["p2"]);
  });

  it("matches two intents in order", () => {
    const rec = reconcile(
      [intent(), intent({ pay_to: "0x1111111111111111111111111111111111111111" })],
      [
        payment("p1", { to: "0x1111111111111111111111111111111111111111" }),
        payment("p2"),
      ],
    );
    assert.equal(rec.unmeasured, false);
    assert.deepEqual(rec.captured_without_intent, []);
    // Two identical intents need two captures.
    assert.equal(reconcile([intent(), intent()], [payment("p1")]).unmeasured, true);
  });

  it("ignores non-header captures", () => {
    const rec = reconcile([intent()], [payment("p1", { capture: "shim" }), payment("p2", { capture: "rpc" })]);
    assert.equal(rec.captured, 0);
    assert.equal(rec.unmeasured, true);
    assert.deepEqual(rec.captured_without_intent, []);
  });

  it("sets aside a denied intent: no capture is ok", () => {
    const rec = reconcile([intent({ allowed: false })], []);
    assert.equal(rec.unmeasured, false);
    assert.equal(rec.denied, 1);
    assert.equal(rec.intents, 0);
  });

  it("5 intents, 2 denied, 3 captures is ok", () => {
    const rec = reconcile(
      [intent(), intent({ allowed: false }), intent(), intent({ allowed: false }), intent({ allowed: true })],
      [payment("p1"), payment("p2"), payment("p3")],
    );
    assert.equal(rec.unmeasured, false);
    assert.equal(rec.denied, 2);
    assert.deepEqual(rec.captured_without_intent, []);
  });

  it("a denied intent cannot hide a capture next to it", () => {
    const rec = reconcile([intent({ allowed: false })], [payment("p1")]);
    assert.equal(rec.unmeasured, false);
    assert.deepEqual(rec.captured_without_intent, ["p1"]);
  });

  it("an allowed unmatched intent is still unmeasured", () => {
    const rec = reconcile([intent({ allowed: false }), intent()], []);
    assert.equal(rec.unmeasured, true);
    assert.equal(rec.denied, 1);
  });
});

describe("ObservingSpendControl", () => {
  it("records allowed: false with the reason and returns the refusal unchanged", () => {
    const control = new ObservingSpendControl({ storage: new InMemorySpendControlStorage() });
    control.setLimit("perRequest", 0.05);
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let result: ReturnType<typeof control.check>;
    try {
      result = control.check(0.5, { payTo: PAYEE, network: "eip155:84532", asset: "0x2" });
    } finally {
      process.stderr.write = write;
    }
    assert.equal(result.allowed, false);
    const line = lines.find((l) => l.startsWith(INTENT_PREFIX));
    assert.ok(line, "no intent line");
    const logged = JSON.parse(line.slice(INTENT_PREFIX.length)) as Intent;
    assert.equal(logged.allowed, false);
    assert.equal(logged.reason, result.reason);
    assert.equal(logged.pay_to, PAYEE);
    assert.equal(logged.quoted_usd, 0.5);
    // An allowed check is logged as allowed.
    lines.length = 0;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(control.check(0.01, { payTo: PAYEE, network: "eip155:84532" }).allowed, true);
    } finally {
      process.stderr.write = write;
    }
    assert.equal((JSON.parse(lines[0]!.slice(INTENT_PREFIX.length)) as Intent).allowed, true);
  });

  it("logs allowed: false and rethrows the same error when the check throws", () => {
    const control = new ObservingSpendControl({ storage: new InMemorySpendControlStorage() });
    const boom = new Error("check failed");
    const stub = mock.method(SpendControl.prototype, "check", () => {
      throw boom;
    });
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let caught: unknown;
    try {
      control.check(0.01, { payTo: PAYEE, network: "eip155:84532" });
    } catch (err) {
      caught = err;
    } finally {
      process.stderr.write = write;
      stub.mock.restore();
    }
    assert.strictEqual(caught, boom);
    assert.equal((JSON.parse(lines[0]!.slice(INTENT_PREFIX.length)) as Intent).allowed, false);
  });
});
