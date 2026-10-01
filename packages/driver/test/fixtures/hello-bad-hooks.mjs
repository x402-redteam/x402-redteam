// A guardrail that answers `hello` with an empty hooks array - invalid per GDP v1
// (hooks must be a non-empty subset of payment/transfer/sign); exercises GdpClient
// rejecting "no hooks" as a hello failure, not a silent allow-all fallback
// (test/gdp.test.ts).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "hello") return;
  process.stdout.write(
    `${JSON.stringify({ id: msg.id, hooks: [], name: "empty-hooks", version: "1.0.0", nondeterministic: false })}\n`,
  );
});
