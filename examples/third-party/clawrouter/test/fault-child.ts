/**
 * A stand-in child that speaks the fd 3 protocol and misbehaves on purpose, for the
 * exit-code tests. It imports no ClawRouter code. X402_TEST_FAULT is not in the real
 * child's environment; the test names it through the task's run_id instead (the part of
 * the run_id before the first dash).
 */
import net from "node:net";
import { createInterface } from "node:readline";
import { readTask } from "../src/task.js";

const fault = readTask().run_id.split("-")[0];
const channel = new net.Socket({ fd: 3, readable: true, writable: true });
const send = (msg: object): void => {
  channel.write(`${JSON.stringify(msg)}\n`);
};
const ready = {
  port: 1,
  wallet_address: "0x0",
  auth_mode: "wallet",
  catalog_settled: true,
  catalog_requests: 1,
  balance_stub_usd: 100,
};

createInterface({ input: channel }).on("line", (line) => {
  const req = JSON.parse(line) as { id: number; action: string };
  if (req.action === "start") {
    if (fault === "unsettled") send({ id: req.id, ok: true, result: { ...ready, catalog_settled: false } });
    else if (fault === "mismatch") send({ id: req.id, ok: false, error: "proxy is on port 1, expected 2" });
    else if (fault === "startcrash") process.exit(9);
    else send({ id: req.id, ok: true, result: ready });
    return;
  }
  if (req.action === "chat") {
    if (fault === "crash") process.exit(9);
    if (fault === "transport") {
      send({ id: req.id, ok: true, result: { status: 0, body: "", transport_error: "fetch failed: ECONNREFUSED" } });
      return;
    }
    if (fault === "taskhost") {
      send({
        id: req.id,
        ok: true,
        result: { status: 500, body: "fetch failed: EGRESS_BLOCKED fetch:http://127.0.0.1:1" },
      });
      return;
    }
    if (fault === "egressafter") {
      process.stderr.write('X402_INTENT {"route":"/v1/chat/completions","pay_to":"0x1","network":"eip155:84532","asset":"0x2","quoted_usd":0.01}\n');
      process.stderr.write("EGRESS_BLOCKED fetch:https://elsewhere.example\n");
    }
    if (fault === "egressfree") process.stderr.write("EGRESS_BLOCKED fetch:https://elsewhere.example\n");
    send({ id: req.id, ok: true, result: { status: 200, body: "{}" } });
    return;
  }
  send({ id: req.id, ok: false, error: `unknown action ${req.action}` });
});
