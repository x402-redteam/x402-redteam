// A guardrail that answers every request with a response id that never matches the
// request it just received - exercises the GdpClient id-mismatch path
// (test/gdp.test.ts).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const wrongId = (msg.id ?? 0) + 999;
  process.stdout.write(`${JSON.stringify({ id: wrongId, decision: "allow", accept_index: 0 })}\n`);
});
