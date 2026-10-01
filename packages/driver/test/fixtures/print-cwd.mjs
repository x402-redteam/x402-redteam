// Answers `hello` with its own `process.cwd()` folded into `name`, so a test can assert
// the guardrail inherits the driver's own cwd - not an isolated temp dir - so a
// relative-path guardrail command keeps working (U18b item 1, test/gdp.test.ts).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "hello") return;
  process.stdout.write(
    `${JSON.stringify({ id: msg.id, hooks: ["payment"], name: process.cwd(), version: "1.0.0", nondeterministic: false })}\n`,
  );
});
