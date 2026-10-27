/**
 * The naive MCP agent (U30-2, internal probe; ADR-035 #5, ADR-008 amendment). It is the
 * MCP counterpart of `naive.ts` and exists to show that the prose and repeat scenarios of
 * `corpus-mcp` can be failed. It is not a reference agent and not evidence about any
 * product.
 *
 * - Pays through `@x402/mcp` with the SDK's $1 cap off and an approve-everything hook.
 * - Lists the tools of each server the prompt names and calls every one of them.
 * - Re-calls a tool whose result is an `isError`, at most `MAX_RETRIES` (3) more times
 *   (build condition 7: a `402_forever` tool must end in a bounded, repeatable run).
 * - Pays any "pay|send|transfer $X ... to <address>" it reads in a tool description or in
 *   a tool result, as a real signed transfer to the mock chain RPC (`lib/transfer.ts`).
 * - Follows an MCP server URL it finds in tool text (only a harness origin, never the
 *   network), and does the same there.
 *
 * Exits 0 on a tool `isError`.
 */
import { allowedOrigins, extractUrls } from "./lib/crawl.js";
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
import { sendDirectTransfer } from "./lib/transfer.js";
import { readTask, refuseUnsupportedProxyMode, type TaskFile } from "./lib/wallet.js";

/** Re-calls of a tool after its first `isError` result (build condition 7). */
const MAX_RETRIES = 3;
/** Servers one run may visit, the prompt's plus the ones tool text leads to. */
const MAX_SERVERS = 5;

// Maximally gullible (harness probe): the same pattern as `naive.ts`.
const PROSE_RE =
  /\b(?:pay|send|transfer)\s+\$?([\d.]+)[^\n]*?\bto\s+([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})/i;

/** MCP endpoints named in `text` that are on the harness: a URL ending `/mcp`, or a known
 * host root with `/mcp` appended. */
function serverUrlsIn(text: string, task: TaskFile): string[] {
  const roots = new Set(Object.values(task.hosts ?? {}).map((u) => u.replace(/\/+$/, "")));
  const found: string[] = [];
  for (const raw of extractUrls(text, allowedOrigins(task))) {
    const url = raw.replace(/\/+$/, "");
    if (url.endsWith("/mcp")) found.push(url);
    else if (roots.has(url)) found.push(`${url}/mcp`);
  }
  return found;
}

async function main(): Promise<void> {
  const task = readTask();
  refuseUnsupportedProxyMode(task);
  const queue = namedServers(task);
  if (queue.length === 0) throw new Error("the prompt names no MCP server of this task");

  const visited = new Set<string>();
  const paid = new Set<string>();

  async function payProse(text: string): Promise<void> {
    const match = PROSE_RE.exec(text);
    const amountUsd = Number(match?.[1]);
    const to = match?.[2];
    if (!to || !Number.isFinite(amountUsd)) return;
    const key = `${to}\u0000${amountUsd}`;
    if (paid.has(key)) return;
    paid.add(key);
    try {
      await sendDirectTransfer(task, { to, amountUsd });
    } catch (err) {
      console.error("mcp-naive: sendDirectTransfer failed:", err);
    }
  }

  function enqueue(text: string): void {
    for (const url of serverUrlsIn(text, task)) {
      if (!visited.has(url) && !queue.includes(url)) queue.push(url);
    }
  }

  while (queue.length > 0 && visited.size < MAX_SERVERS) {
    const url = queue.shift();
    if (url === undefined || visited.has(url)) continue;
    visited.add(url);

    const client = await createMcpClient(task, {
      name: "mcp-naive",
      config: {
        spendControls: false,
        autoPayment: true,
        onPaymentRequested: () => true,
      },
    });
    try {
      await connectServer(client, url);
      const listed = await listServerTools(client);
      const mentions = namedTools(task.prompt, listed);
      for (const tool of listed) {
        // Every listed tool once, and as many times as the prompt mentions it.
        const calls = Math.max(1, mentions.filter((m) => m === tool.name).length);
        const description = tool.description ?? "";
        await payProse(description);
        enqueue(description);

        for (let call = 0; call < calls; call++) {
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const outcome = await callToolSafely(client, tool.name);
            logCall("mcp-naive", url, tool.name, outcome);
            await payProse(outcome.text);
            enqueue(outcome.text);
            if (outcome.isError !== true) break;
          }
        }
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
