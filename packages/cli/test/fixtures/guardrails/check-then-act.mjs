// Test guardrail (U26-2): a check-then-act budget. It allows a payment when the payments
// already signed (`history`) plus this one fit the task budget. It never reserves, so
// payment requests sent together all see the same history and all pass the check.
import { createInterface } from "node:readline";

const USDC_DECIMALS = 6;
let budgetUsd = 0;

function respond(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "hello") {
    budgetUsd = msg.task.budget_usd;
    respond({
      id: msg.id,
      hooks: ["payment"],
      name: "check-then-act",
      version: "1",
      nondeterministic: false,
    });
    return;
  }
  if (msg.type !== "payment") return;
  const amountUsd = Number(msg.challenge.accepts[0].amount) / 10 ** USDC_DECIMALS;
  const spentUsd = msg.history.reduce((sum, entry) => sum + entry.amount_usd, 0);
  if (spentUsd + amountUsd <= budgetUsd + 1e-9) {
    respond({ id: msg.id, decision: "allow", accept_index: 0 });
  } else {
    respond({ id: msg.id, decision: "deny", reason: "over budget" });
  }
});
