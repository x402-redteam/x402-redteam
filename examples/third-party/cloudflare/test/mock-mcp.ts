/**
 * A small stand-in for the harness's MCP seller, for the exit-code tests: a hand-rolled
 * Streamable HTTP endpoint (JSON replies only) that answers `initialize`, `tools/list` and
 * `tools/call` in the ways the classifier has to tell apart. It accepts any payment token.
 * Local only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Mode =
  | "ok" // challenge in structured, text and _meta; paid retry delivers
  | "no_meta" // challenge in structured and text only (the run option off)
  | "free" // no challenge
  | "over_cap" // 150000 atomic: over the default cap, under the raised one
  | "huge" // 2000000 atomic: over the default spend control
  | "non_exact" // only a non-exact scheme offered
  | "rpc_402" // JSON-RPC error 402
  | "rpc_other" // JSON-RPC error -32603
  | "boom" // an error result with no challenge
  | "not_error" // a challenge in a result without isError
  | "paid_error"; // after payment, an error result

const PAY_TO = "0x9cA8A44a428a91F609eBC9FB0CA4cC3647c89012";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export const TOOLS = ["get_item", "get_other"];

function challenge(tool: string, scheme: string, amount: string): Record<string, unknown> {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: `mcp://tool/${tool}`, description: "", mimeType: "application/json" },
    accepts: [
      {
        scheme,
        network: "eip155:84532",
        asset: USDC,
        amount,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

export interface MockMcp {
  server: Server;
  port: number;
  /** "tool paid?" for every tools/call, in arrival order. */
  calls: string[];
  close(): Promise<void>;
}

function result(mode: Mode, tool: string, paid: boolean): Record<string, unknown> | { rpcError: number } {
  const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) });
  const delivered = {
    content: [{ type: "text", text: `${tool} delivered` }],
    _meta: { "x402/payment-response": { success: true, transaction: "0xabc", network: "eip155:84532" } },
  };
  const amount = mode === "over_cap" ? "150000" : mode === "huge" ? "2000000" : "10000";
  const scheme = mode === "non_exact" ? "upto" : "exact";
  const pr = challenge(tool, scheme, amount);
  const withMeta = {
    content: [text(pr)],
    structuredContent: pr,
    isError: true,
    _meta: { "x402/error": pr },
  };
  switch (mode) {
    case "free":
      return { content: [{ type: "text", text: `${tool} free` }] };
    case "no_meta":
      return paid ? delivered : { content: [text(pr)], structuredContent: pr, isError: true };
    case "rpc_402":
      return { rpcError: 402 };
    case "rpc_other":
      return { rpcError: -32603 };
    case "boom":
      return { content: [{ type: "text", text: "boom" }], isError: true };
    case "not_error":
      return { content: [text(pr)], structuredContent: pr };
    case "paid_error":
      return paid
        ? { content: [{ type: "text", text: "Settlement failed" }], isError: true }
        : withMeta;
    default:
      return paid ? delivered : withMeta;
  }
}

export async function startMockMcp(mode: Mode): Promise<MockMcp> {
  const calls: string[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      const msg = JSON.parse(body || "{}") as {
        id?: number | string;
        method?: string;
        params?: { name?: string; _meta?: Record<string, unknown> };
      };
      const reply = (payload: unknown): void => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...(payload as object) }));
      };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "initialize") {
        reply({
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "mock", version: "0.0.0" },
          },
        });
      } else if (msg.method === "tools/list") {
        reply({
          result: {
            tools: TOOLS.map((name) => ({
              name,
              description: `${name}. $0.01 a call.`,
              inputSchema: { type: "object", properties: {} },
            })),
          },
        });
      } else if (msg.method === "tools/call") {
        const tool = msg.params?.name ?? "";
        const paid = msg.params?._meta?.["x402/payment"] !== undefined;
        calls.push(`${tool}${paid ? " paid" : ""}`);
        const r = result(mode, tool, paid);
        if ("rpcError" in r) reply({ error: { code: r.rpcError, message: "Payment required" } });
        else reply({ result: r });
      } else {
        reply({ error: { code: -32601, message: "Method not found" } });
      }
    });
  };
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
