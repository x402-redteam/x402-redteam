/**
 * A stand-in child that speaks the fd 3 protocol and misbehaves on purpose, for the
 * exit-code tests. It imports no package code. The test names the fault through the task's
 * run_id (the part before the first dash).
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
  loaded: { agents: "0.30.1", core: "2.28.0", evm: "2.28.0" },
  tools: ["get_item", "get_other"],
};
const paid = {
  signed: 1,
  accepts_seen: [],
  decisions: [],
  result: { content: [{ type: "text", text: "delivered" }] },
};

createInterface({ input: channel }).on("line", (line) => {
  const req = JSON.parse(line) as { id: number; action: string; args?: { tool?: string } };
  if (req.action === "start") {
    if (fault === "mismatch") {
      send({ id: req.id, ok: false, error: "loaded versions differ from the pins: @x402/core 2.27.0 != 2.28.0" });
    } else if (fault === "startcrash") process.exit(9);
    else send({ id: req.id, ok: true, result: ready });
    return;
  }
  if (req.action === "call") {
    const tool = req.args?.tool ?? "";
    if (fault === "crash") process.exit(9);
    if (fault === "transport") {
      send({
        id: req.id,
        ok: true,
        result: { tool, signed: 0, accepts_seen: [], decisions: [], thrown: { name: "Error", message: "fetch failed: ECONNREFUSED" } },
      });
      return;
    }
    if (fault === "taskhost") {
      send({
        id: req.id,
        ok: true,
        result: {
          tool,
          signed: 0,
          accepts_seen: [],
          decisions: [],
          thrown: { name: "TypeError", message: "fetch failed: EGRESS_BLOCKED fetch:http://127.0.0.1:1" },
        },
      });
      return;
    }
    if (fault === "egressafter") {
      process.stderr.write('X402_INTENT {"route":"provider.test/mcp#get_item","pay_to":"0x1","network":"eip155:84532","asset":"0x2","value_atomic":"1"}\n');
      process.stderr.write("EGRESS_BLOCKED fetch:https://elsewhere.example\n");
    }
    if (fault === "egressfree") process.stderr.write("EGRESS_BLOCKED fetch:https://elsewhere.example\n");
    send({ id: req.id, ok: true, result: { tool, ...paid } });
    return;
  }
  send({ id: req.id, ok: false, error: `unknown action ${req.action}` });
});
