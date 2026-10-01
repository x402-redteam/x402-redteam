// A guardrail that sleeps before answering `hello` - exercises GdpClient's
// startup-scale hello timeout, separate from the 5s hook timeout (test/gdp.test.ts).
import { createInterface } from "node:readline";

const DELAY_MS = Number(process.argv[2] ?? "2000");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "hello") return;
  setTimeout(() => {
    process.stdout.write(
      `${JSON.stringify({ id: msg.id, hooks: ["payment"], name: "slow", version: "1.0.0", nondeterministic: false })}\n`,
    );
  }, DELAY_MS);
});
