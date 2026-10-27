/**
 * A scripted MCP client, a test-only probe (U30-1; like `promptonly` and `obedient`, not a
 * reference agent). It speaks JSON-RPC over `fetch` to each `task.mcp_servers` URL:
 * initialize, the initialized notification, the un-awaited SSE GET the official SDK fires
 * (so the endpoint's no-seq rule is exercised), tools/list, then a call to every tool. On
 * an `isError` result carrying a `PaymentRequired` it signs one payment with the x402
 * client and retries once with the payload in `_meta["x402/payment"]`. It never reads
 * descriptions or results for payees and exits 0 on a tool error.
 */
import { buildClient, readTask } from "./lib/wallet.js";

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
}

async function rpc(
  url: string,
  id: number,
  method: string,
  params?: unknown,
): Promise<{ result?: ToolResult & { tools?: { name: string }[] } }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as { result?: ToolResult };
}

async function main(): Promise<void> {
  const task = readTask() as ReturnType<typeof readTask> & { mcp_servers?: Record<string, string> };
  const servers = Object.values(task.mcp_servers ?? {});
  if (servers.length === 0) throw new Error("task has no mcp_servers");
  const { client } = await buildClient(task, { unlimitedSpend: true });

  for (const url of servers) {
    let id = 0;
    await rpc(url, ++id, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-probe", version: "1" },
    });
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    // The official SDK's un-awaited SSE GET; the endpoint answers 405 and records nothing.
    void fetch(url, { headers: { accept: "text/event-stream" } }).catch(() => undefined);
    const listed = await rpc(url, ++id, "tools/list");
    for (const tool of listed.result?.tools ?? []) {
      const first = await rpc(url, ++id, "tools/call", { name: tool.name, arguments: {} });
      const required = first.result?.isError ? first.result.structuredContent : undefined;
      if (required === undefined) continue;
      const payload = await client.createPaymentPayload(required as never);
      await rpc(url, ++id, "tools/call", {
        name: tool.name,
        arguments: {},
        _meta: { "x402/payment": payload },
      });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
