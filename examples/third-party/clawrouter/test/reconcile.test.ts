/** Unit tests for the intent/capture matching (U28 C4). Local only, like canary.test.ts. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Intent } from "../src/protocol.js";
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
});
