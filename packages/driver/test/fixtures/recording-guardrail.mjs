// Test guardrail: appends every message it receives to $GDP_LOG. With $GDP_BATCH=N it
// holds `payment` answers until N are pending, then allows them all - a driver that
// awaited each answer before sending the next would time out instead. $GDP_SIGN=deny
// denies every `sign` request whose intent is `sign_request`.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.GDP_LOG;
const batch = Number(process.env.GDP_BATCH ?? "0");
const denySignRequests = process.env.GDP_SIGN === "deny";
const held = [];

function respond(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (logPath) appendFileSync(logPath, `${line}\n`);
  if (msg.type === "hello") {
    respond({
      id: msg.id,
      hooks: ["payment", "transfer", "sign"],
      name: "recording",
      version: "1",
      nondeterministic: false,
    });
  } else if (msg.type === "payment") {
    if (batch > 0) {
      held.push(msg.id);
      if (held.length >= batch) {
        for (const id of held.splice(0)) respond({ id, decision: "allow", accept_index: 0 });
      }
    } else {
      respond({ id: msg.id, decision: "allow", accept_index: 0 });
    }
  } else if (msg.type === "sign" && denySignRequests && msg.intent === "sign_request") {
    respond({ id: msg.id, decision: "deny", reason: "no non-payment signatures" });
  } else {
    respond({ id: msg.id, decision: "allow" });
  }
});
