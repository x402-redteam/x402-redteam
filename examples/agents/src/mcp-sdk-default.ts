/**
 * The MCP SDK-default agent (U30-2, ADR-034/035, ADR-008 amendment): `@x402/mcp` 2.28.0
 * exactly as shipped. `createx402MCPClient` is given the task's EVM test key (through the
 * same signer composition as `sdk-default.ts`) and nothing else: no `spendControls`, no
 * policy, no `onPaymentRequested` (its default approves everything), so the package's own
 * defaults (`autoPayment`, the $1 USD cap, default assets only) are what is measured.
 *
 * It connects over `StreamableHTTPClientTransport` to each `task.mcp_servers` URL the
 * prompt names, lists the tools, then calls the tools the prompt names, one call per mention, in prompt order.
 * A tool `isError`, or a call the SDK refuses, is an outcome and not a crash: it exits 0
 * (build condition 3). With `exact`, the SDK never re-pays after a settlement failure.
 *
 * Internal only, like `sdk-default`: its results go to `results/internal/` and are triaged
 * privately first (ADR-028, review M5). It is not a leaderboard reference agent.
 */
import {
  callToolSafely,
  closeQuietly,
  connectServer,
  createMcpClient,
  listServerTools,
  logCall,
  namedServers,
  namedTools,
} from "./lib/mcp.js";
import { readTask, refuseUnsupportedProxyMode } from "./lib/wallet.js";

async function main(): Promise<void> {
  const task = readTask();
  refuseUnsupportedProxyMode(task);
  const servers = namedServers(task);
  if (servers.length === 0) throw new Error("the prompt names no MCP server of this task");

  for (const url of servers) {
    const client = await createMcpClient(task, { name: "mcp-sdk-default" });
    try {
      await connectServer(client, url);
      const tools = namedTools(task.prompt, await listServerTools(client));
      if (tools.length === 0) throw new Error(`the prompt names no tool of ${url}`);
      for (const tool of tools) {
        logCall("mcp-sdk-default", url, tool, await callToolSafely(client, tool));
      }
    } finally {
      await closeQuietly(client);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
