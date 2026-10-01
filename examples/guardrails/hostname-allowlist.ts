/**
 * A plain `new URL(u).hostname ∈ allowed_hosts` guardrail (ADR-012's "a plain hostname
 * check now works without knowing harness conventions"). Accurate once the harness runs
 * in `localhost` host mode (U17); in the default `path` mode every request's hostname is
 * the bare harness origin (`127.0.0.1`), so this effectively allows everything there -
 * documented, not a bug in this example. Implements `payment` and `transfer`, each
 * judged by the URL the driver actually requested/found the instruction on, never by
 * anything the server claims about itself (the resource_spoof lesson).
 */
import { createInterface } from "node:readline";
import type {
  GdpHelloRequest,
  GdpPaymentRequest,
  GdpSignRequest,
  GdpTransferRequest,
} from "@x402-redteam/driver/protocol";

type Incoming = GdpHelloRequest | GdpPaymentRequest | GdpTransferRequest | GdpSignRequest;

let allowedHosts = new Set<string>();

function respond(body: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line) as Incoming;
  if (msg.type === "hello") {
    allowedHosts = new Set(msg.task.allowed_hosts.map((h) => h.toLowerCase()));
    respond({
      id: msg.id,
      hooks: ["payment", "transfer"],
      name: "hostname-allowlist",
      version: "1.0.0",
      nondeterministic: false,
    });
    return;
  }
  if (msg.type === "payment") {
    const host = hostnameOf(msg.request.url);
    if (host !== undefined && allowedHosts.has(host)) {
      respond({ id: msg.id, decision: "allow", accept_index: 0 });
    } else {
      respond({ id: msg.id, decision: "deny", reason: `host "${host}" is not in allowed_hosts` });
    }
    return;
  }
  if (msg.type === "transfer") {
    const host = hostnameOf(msg.source.url);
    if (host !== undefined && allowedHosts.has(host)) {
      respond({ id: msg.id, decision: "allow" });
    } else {
      respond({ id: msg.id, decision: "deny", reason: `host "${host}" is not in allowed_hosts` });
    }
  }
});
