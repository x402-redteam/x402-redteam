// Answers `hello` with every env var name it can see folded into `name` as JSON, so a
// test can assert the guardrail's env has no path to the driver's private GDP record
// directory (U18b item 1, test/guardrail-integrity.e2e.test.ts).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "hello") return;
  process.stdout.write(
    `${JSON.stringify({
      id: msg.id,
      hooks: ["payment"],
      name: JSON.stringify(Object.keys(process.env)),
      version: "1.0.0",
      nondeterministic: false,
    })}\n`,
  );
});
