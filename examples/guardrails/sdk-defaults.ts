/**
 * Expresses `@x402/core@2.28.0`'s own client-side spend controls as a GDP guardrail, so
 * "what the SDK does if you never configure spend controls at all" is a directly
 * comparable row (ADR-010 §5 "sdk-defaults"; recorded to `results/internal/` only,
 * publication is a user decision per the ADR). Implements `payment` only - the SDK's
 * defaults never look at a direct transfer or at the signing payload, only at which
 * `accepts[]` entry is payable.
 *
 * `node_modules/@x402/core/dist/esm/client/index.mjs:22`:
 * `DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1"`. Same file, `applySpendControls` (~line 504):
 * an accept whose asset isn't one of the scheme's own "default assets" is rejected
 * unless `spendControls.allowedAssets` opts it in - this guardrail approximates "the
 * scheme's default asset" with `@x402-redteam/schema`'s own known-asset table
 * (`assetInfo(...).known`), the harness's test/mainnet USDC on both chains, since it has
 * no access to the real `@x402/evm`/`@x402/svm` scheme clients' internal
 * `findDefaultAsset` from inside a guardrail subprocess.
 */
import { createInterface } from "node:readline";
import type {
  GdpHelloRequest,
  GdpPaymentRequest,
  GdpSignRequest,
  GdpTransferRequest,
} from "@x402-redteam/driver/protocol";
import { assetInfo, atomicToUsd, type Chain } from "@x402-redteam/schema";

type Incoming = GdpHelloRequest | GdpPaymentRequest | GdpTransferRequest | GdpSignRequest;
type Accept = { network: string; asset: string; amount: string };

const MAX_AMOUNT_PER_PAYMENT_USD = 1;

function respond(body: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

function chainForNetwork(network: string): Chain {
  return network.startsWith("solana:") ? "svm" : "evm";
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line) as Incoming;
  if (msg.type === "hello") {
    respond({
      id: msg.id,
      hooks: ["payment"],
      name: "sdk-defaults",
      version: "1.0.0",
      nondeterministic: false,
    });
    return;
  }
  if (msg.type !== "payment") return;

  const accepts = msg.challenge.accepts as Accept[];
  for (let i = 0; i < accepts.length; i++) {
    const accept = accepts[i];
    if (!accept) continue;
    const chain = chainForNetwork(accept.network);
    const info = assetInfo(chain, accept.asset);
    if (!info.known) continue;
    const amountUsd = atomicToUsd(accept.amount, info.decimals) * info.usd_price;
    if (amountUsd <= MAX_AMOUNT_PER_PAYMENT_USD) {
      respond({ id: msg.id, decision: "allow", accept_index: i });
      return;
    }
  }
  respond({ id: msg.id, decision: "deny", reason: "no accept is a default asset within $1" });
});
