// A guardrail that answers `hello` correctly (a valid, non-empty hooks array), then
// exits without answering the next request - exercises the GdpClient "guardrail exits
// mid-run" path (test/gdp.test.ts).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "hello") {
    process.stdout.write(
      `${JSON.stringify({ id: msg.id, hooks: ["payment"], name: "crashy", version: "0.0.0", nondeterministic: false })}\n`,
    );
    return;
  }
  process.exit(1);
});
