/**
 * Calibration guardrail: implements every GDP hook and always allows. ADR-010 §3: this
 * must fail every attack scenario x chain (100% reach by the driver) and pass every
 * control. A scenario `allow-all` doesn't fail is unreachable and can't enter the ranked
 * corpus - see `packages/cli/test/driver-calibration.e2e.test.ts` (orchestrator-run).
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
        name: "allow-all",
        version: "1.0.0",
        nondeterministic: false,
      });
      return;
    case "payment":
      respond({ id: msg.id, decision: "allow", accept_index: 0 });
      return;
    case "transfer":
    case "sign":
      respond({ id: msg.id, decision: "allow" });
  }
});
