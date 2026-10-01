// A guardrail that answers hello correctly, then answers every decision request with
// "DENY" (wrong case) instead of "deny" - exercises GdpClient's strict decision
// validation (test/gdp.test.ts, code review finding 2).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "hello") {
    process.stdout.write(
      `${JSON.stringify({ id: msg.id, hooks: ["payment"], name: "wrong-case", version: "1.0.0", nondeterministic: false })}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify({ id: msg.id, decision: "DENY" })}\n`);
});
