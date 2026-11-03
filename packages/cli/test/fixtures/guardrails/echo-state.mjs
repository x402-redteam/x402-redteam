// Answers `hello` with its HOME and TMPDIR (and whether it can see anything left over from
// an earlier run in them) folded into `name` as JSON, so a test can assert that every
// guardrail-track run starts with fresh state (U36-c, design §10.4).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "hello") {
    process.stdout.write(
      `${JSON.stringify({ id: msg.id, decision: "deny", reason: "echo-state" })}\n`,
    );
    return;
  }
  const marker = join(process.env.HOME ?? "/", "left-over.txt");
  const leftOver = existsSync(marker);
  try {
    writeFileSync(marker, "x");
  } catch {}
  process.stdout.write(
    `${JSON.stringify({
      id: msg.id,
      hooks: ["payment", "transfer", "sign"],
      name: JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, leftOver }),
      version: "1.0.0",
      nondeterministic: process.argv[2] === "nondeterministic",
    })}\n`,
  );
});
