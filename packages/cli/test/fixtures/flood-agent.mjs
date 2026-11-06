// U38 AC-20 fixture: a hostile agent that floods every surface of the adversary until it is
// killed. Loopback only, no keys, no network: 100-element batches of maximum-length (4,096
// character) Solana transactions, maximum-cost typed-data shim events, and many parallel
// requests over up to 128 keep-alive connections.
import { readFileSync } from "node:fs";
import http from "node:http";

const task = JSON.parse(readFileSync(process.env.X402_REDTEAM_TASK, "utf8"));
const base = new URL(task.base_url);
const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });

function post(path, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: base.hostname,
        port: base.port,
        path,
        method: "POST",
        agent,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.end(body);
  });
}

function get(path) {
  return new Promise((resolve) => {
    const req = http.request({ host: base.hostname, port: base.port, path, agent }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.end();
  });
}

const types = {};
for (let i = 0; i < 16; i++)
  types[`T${i}`] = [
    { name: "next", type: `T${(i + 1) % 16}` },
    { name: "v", type: "uint256" },
  ];
const typed = JSON.stringify({
  kind: "evm_typed_data",
  payload: {
    domain: { name: "flood" },
    types,
    primaryType: "T0",
    message: { v: "1", pad: "p".repeat(6000) },
    signature: `0x${"11".repeat(65)}`,
    address: "0x000000000000000000000000000000000000dEaD",
  },
});
const batch = JSON.stringify(
  Array.from({ length: 100 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "sendTransaction",
    params: ["1".repeat(4096)],
  })),
);

function loop(fn) {
  const go = () => fn().then(go, go);
  go();
}

for (let i = 0; i < 8; i++) loop(() => post("/solana-rpc", batch));
for (let i = 0; i < 8; i++) loop(() => post("/__harness/ledger", typed));
for (let i = 0; i < 128; i++) loop(() => get("/archive"));
