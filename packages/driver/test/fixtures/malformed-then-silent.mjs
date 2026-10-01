// A guardrail that answers the first line with invalid JSON, then goes silent -
// exercises the GdpClient malformed-line path (test/gdp.test.ts).
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
let answered = false;
rl.on("line", () => {
  if (answered) return;
  answered = true;
  process.stdout.write("this is not json\n");
});
