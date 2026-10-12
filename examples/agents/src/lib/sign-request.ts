/**
 * v4 (U26-2, M2): answers sign requests (application-design.md v4 sign-request shape):
 * a JSON page or 402 body asking the wallet to sign an EIP-7702 authorization, a raw
 * digest, a message or typed data, and to POST the signature to `submit_url`. Only the
 * gullible reference payers use this (naive, and the promptonly readiness probe for 402
 * bodies): it signs whatever it is asked to, the way naive sends whatever transfer page
 * prose asks for. The wallet is shim-wrapped unless `noShim` is set, so the signature is
 * also reported by the shim and merges with its `submitted` capture.
 */
import { parseSignRequest, type SignRequestWire, signSignRequest } from "@x402-redteam/schema";
import { allowedOrigins } from "./crawl.js";
import { type TaskFile, walletSigner } from "./wallet.js";

export interface ObservedBody {
  url: string;
  status: number;
  text: string;
}

/** Signs and submits every distinct sign request in `bodies`, in order. Returns how many
 * were submitted. Submit URLs outside the task's own origins are never contacted. */
export async function answerSignRequests(
  task: TaskFile,
  bodies: ObservedBody[],
  opts: { noShim?: boolean } = {},
): Promise<number> {
  if (task.chain !== "evm") return 0; // every sign request kind is an EVM signature.
  const origins = allowedOrigins(task);
  const seen = new Set<string>();
  const requests: SignRequestWire[] = [];
  for (const body of bodies) {
    const request = parseSignRequest(body.text);
    if (!request) continue;
    const key = JSON.stringify(request);
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push(request);
  }
  if (requests.length === 0) return 0;

  const signer = await walletSigner(task, { noShim: opts.noShim });
  if (signer.chain !== "evm") return 0;
  let submitted = 0;
  for (const request of requests) {
    let origin: string;
    try {
      origin = new URL(request.submit_url).origin;
    } catch {
      continue;
    }
    if (!origins.has(origin)) continue;
    try {
      const signature = await signSignRequest(signer.account, request);
      const res = await fetch(request.submit_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature, address: signer.account.address }),
      });
      await res.text().catch(() => "");
      if (res.ok) submitted += 1;
    } catch (err) {
      console.error(`sign request to ${request.submit_url} failed:`, err);
    }
  }
  return submitted;
}

/** Collects response bodies for `BuildClientOptions.observe`; `bodies()` waits for every
 * body to be read. */
export function bodyRecorder(): {
  observe: (url: string, response: Response) => void;
  bodies: () => Promise<ObservedBody[]>;
} {
  const pending: Promise<ObservedBody>[] = [];
  return {
    observe(url, response) {
      pending.push(
        response
          .text()
          .catch(() => "")
          .then((text) => ({ url, status: response.status, text })),
      );
    },
    bodies: () => Promise.all(pending),
  };
}
