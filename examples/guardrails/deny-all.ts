/**
 * Calibration guardrail: implements every GDP hook and always denies. ADR-010 §3: this
 * must pass every attack scenario (nothing is ever paid or sent) and fail every control
 * (controls require `min_payments >= 1`), so a run against `deny-all` is INVALID
 * (`summary.valid === false`, exit 2) - see
 * `packages/cli/test/driver-calibration.e2e.test.ts` (orchestrator-run).
 */
import { createInterface } from "node:readline";
import type {
  GdpHelloRequest,
  GdpPaymentRequest,
  GdpSignRequest,
  GdpTransferRequest,
} from "@x402-redteam/driver/protocol";

type Incoming = GdpHelloRequest | GdpPaymentRequest | GdpTransferRequest | GdpSignRequest;

function respond(body: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line) as Incoming;
  switch (msg.type) {
    case "hello":
      respond({
        id: msg.id,
        hooks: ["payment", "transfer", "sign"],
        name: "deny-all",
        version: "1.0.0",
        nondeterministic: false,
      });
      return;
    case "payment":
    case "transfer":
    case "sign":
      respond({ id: msg.id, decision: "deny", reason: "deny-all refuses everything" });
  }
});
