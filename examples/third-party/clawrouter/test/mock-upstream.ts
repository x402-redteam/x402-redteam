/**
 * A small stand-in for the harness's adversary, for the exit-code tests: it answers
 * `POST /v1/chat/completions` in the ways the classifier has to tell apart. It speaks just
 * enough x402 v2 for the package to sign (a PAYMENT-REQUIRED header and body) and accepts
 * any PAYMENT-SIGNATURE. Local only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Mode =
  | "ok"
  | "free"
  | "forever"
  | "expensive"
  | "parse"
  | "invalid"
  | "notfound"
  | "norun"
  | "boom";

const PAY_TO = "0x9cA8A44a428a91F609eBC9FB0CA4cC3647c89012";

function challenge(url: string, amountAtomic: string): Record<string, unknown> {
  return {
    x402Version: 2,
    error: "payment_required",
    resource: { url, description: "", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: amountAtomic,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

const COMPLETION = JSON.stringify({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "openai/gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

export interface MockUpstream {
  server: Server;
  port: number;
  /** "METHOD path paid?" for every request, in arrival order. */
  log: string[];
  close(): Promise<void>;
}

export async function startMock(mode: Mode): Promise<MockUpstream> {
  const log: string[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const paid = req.headers["payment-signature"] !== undefined;
    const path = (req.url ?? "").split("?")[0];
    log.push(`${req.method} ${path}${paid ? " paid" : ""}`);
    req.resume();
    req.on("end", () => {
      if (path !== "/v1/chat/completions") {
        // The package's start-up catalog read: a 404 leaves it on its bundled catalog.
        res.writeHead(404).end("not found");
        return;
      }
      const url = `http://127.0.0.1:${(res.socket?.localPort ?? 0).toString()}${path}`;
      const send402 = (amount: string): void => {
        const body = JSON.stringify(challenge(url, amount));
        res
          .writeHead(402, {
            "content-type": "application/json",
            "payment-required": Buffer.from(body).toString("base64"),
          })
          .end(body);
      };
      switch (mode) {
        case "free":
          res.writeHead(200, { "content-type": "application/json" }).end(COMPLETION);
          return;
        case "ok":
          if (!paid) return send402("10000");
          res.writeHead(200, { "content-type": "application/json" }).end(COMPLETION);
          return;
        case "expensive":
          if (!paid) return send402("500000");
          res.writeHead(200, { "content-type": "application/json" }).end(COMPLETION);
          return;
        case "forever":
          return send402("10000");
        case "parse":
          res.writeHead(402, { "content-type": "text/plain" }).end("pay me, please");
          return;
        case "invalid":
          if (!paid) return send402("10000");
          res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_payment"}');
          return;
        case "notfound":
          res.writeHead(404).end("not found");
          return;
        case "norun":
          res.writeHead(409, { "content-type": "application/json" }).end('{"error":"no_run_loaded"}');
          return;
        case "boom":
          res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
          return;
      }
    });
  };
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    log,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
