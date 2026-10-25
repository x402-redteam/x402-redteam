/**
 * Shared plumbing for the `mcp-*` agents (U30-2, ADR-034/035): server and tool selection
 * from the task prompt, the `@x402/mcp` client over Streamable HTTP, and one safe tool call.
 *
 * Nothing here decides whether to pay. `mcp-sdk-default` passes no hook, `mcp-naive` pays
 * anything, `mcp-guarded` passes an `onPaymentRequested` policy.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Network } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient, type PaymentRequestedContext, type x402MCPClient } from "@x402/mcp";
import { createPublicClient, http } from "viem";
import { allowedOrigins, extractUrls } from "./crawl.js";
import { type TaskFile, walletSigner } from "./wallet.js";

const DEFAULT_HOST = "provider.test";

/** A tool as `tools/list` reports it (only what the agents read). */
export interface ListedTool {
  name: string;
  description?: string;
}

/** What one `callTool` came back with, reduced to what the agents and their logs need. */
export interface McpCallOutcome {
  /** Absent when the call threw (a payment refused, a transport failure). */
  isError?: boolean;
  paymentMade: boolean;
  /** `_meta["x402/payment-response"].success`, when the server sent one. */
  settled?: boolean;
  transaction?: string;
  /** Text content items, joined with a newline. */
  text: string;
  /** The error message when the call threw. */
  thrown?: string;
}

export type McpClientOptions = Parameters<typeof createx402MCPClient>[0];

/** `task.mcp_servers`, the one field an MCP task adds (task file v4, additive). */
export function mcpServers(task: TaskFile): Record<string, string> {
  return (task as TaskFile & { mcp_servers?: Record<string, string> }).mcp_servers ?? {};
}

/**
 * The MCP endpoints the prompt names. A server is named when the prompt contains its MCP
 * URL, or a URL equal to, or under, its host origin (`task.hosts[host]`). When the prompt
 * names no URL at all and the task has exactly one server, that server is the one named.
 * A prompt that names nothing else yields none: the agent then fails loudly rather than
 * scoring a pass for connecting nowhere.
 */
export function namedServers(task: TaskFile): string[] {
  const servers = mcpServers(task);
  const entries = Object.entries(servers);
  const origins = allowedOrigins(task);
  const promptUrls = extractUrls(task.prompt, origins).map((u) => u.replace(/\/+$/, ""));
  const named: string[] = [];
  for (const [host, url] of entries) {
    // The default host is also reachable at `task.base_url` (what `{{base_url}}` renders to,
    // which in `path` mode differs from `hosts[host]`). That origin is a prefix of every
    // path-mode host URL, so a `/_host/` URL never names the default host through it.
    const roots = [task.hosts?.[host]]
      .filter((r): r is string => r !== undefined && r !== "")
      .map((r) => r.replace(/\/+$/, ""));
    const base = task.base_url.replace(/\/+$/, "");
    const underBase = (u: string) =>
      host === DEFAULT_HOST &&
      (u === base || (u.startsWith(`${base}/`) && !u.startsWith(`${base}/_host/`)));
    const hit = promptUrls.some(
      (u) =>
        u === url || underBase(u) || roots.some((root) => u === root || u.startsWith(`${root}/`)),
    );
    if (hit) named.push(url);
  }
  if (named.length === 0 && entries.length === 1 && promptUrls.length === 0) {
    const only = entries[0];
    if (only) named.push(only[1]);
  }
  return named;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The sentence form `approvedPrices` reads; it is not a call instruction. */
const APPROVED_RE = /the user approved\s+`[a-z][a-z0-9_]{0,63}`\s+at\s+\$\d+(?:\.\d+)?\s+a call/gi;

/**
 * The calls the prompt asks for: one entry per mention of a listed tool, in the order of
 * mention (README, call-count convention). "Call `x_tool`, then call `x_tool` again" is two
 * calls. A name matches as a whole token (`get_forecast` does not match `get_forecast_v2`),
 * and the "the user approved `<tool>` at $X a call" sentence is not a mention.
 */
export function namedTools(prompt: string, listed: ListedTool[]): string[] {
  const text = prompt.replace(APPROVED_RE, " ");
  const found: { name: string; at: number }[] = [];
  for (const tool of listed) {
    const re = new RegExp(`(?<![a-z0-9_])${escapeRegExp(tool.name)}(?![a-z0-9_])`, "g");
    for (const m of text.matchAll(re)) found.push({ name: tool.name, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

/**
 * The prompt convention for a user-approved price (README, "MCP agents"): a sentence of the
 * form "the user approved `<tool>` at $<price> a call". The tool name is in backticks and
 * the price is a decimal number of dollars. Returns tool name to approved USD.
 */
export function approvedPrices(prompt: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /the user approved\s+`([a-z][a-z0-9_]{0,63})`\s+at\s+\$(\d+(?:\.\d+)?)\s+a call/gi;
  for (const m of prompt.matchAll(re)) {
    const tool = m[1];
    const usd = Number(m[2]);
    if (tool && Number.isFinite(usd) && !out.has(tool)) out.set(tool, usd);
  }
  return out;
}

/** The lowest `$<number>` in a tool description, or undefined when it advertises none. */
export function advertisedToolPrice(description: string | undefined): number | undefined {
  const prices = [...(description ?? "").matchAll(/\$\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  return prices.length === 0 ? undefined : Math.min(...prices);
}

/** The text items of an MCP tool result's content, joined. */
export function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      item && typeof item === "object" && "text" in item && typeof item.text === "string"
        ? item.text
        : "",
    )
    .filter((t) => t !== "")
    .join("\n");
}

/** Refuses an SVM task: the MCP reference agents sign EVM payments only (ADR-034). */
export function requireEvm(task: TaskFile): void {
  if (task.chain !== "evm") {
    throw new Error("the mcp-* agents support EVM tasks only");
  }
}

export interface CreateClientOptions {
  name: string;
  /** Anything else `createx402MCPClient` takes (spendControls, policies, the hook). Left
   * out entirely for `mcp-sdk-default`, which measures the package defaults. */
  config?: Partial<McpClientOptions>;
}

/**
 * An `x402MCPClient` whose EVM signer is built like `sdk-default.ts`'s:
 * `toClientEvmSigner(account, publicClient(evm_rpc_url))`, over the shim-wrapped account.
 */
export async function createMcpClient(
  task: TaskFile,
  opts: CreateClientOptions,
): Promise<x402MCPClient> {
  requireEvm(task);
  const signer = await walletSigner(task);
  if (signer.chain !== "evm") throw new Error("the mcp-* agents support EVM tasks only");
  const publicClient = task.evm_rpc_url
    ? createPublicClient({ transport: http(task.evm_rpc_url) })
    : undefined;
  const scheme = new ExactEvmScheme(toClientEvmSigner(signer.account, publicClient));
  return createx402MCPClient({
    name: opts.name,
    version: "1.0.0",
    schemes: [{ network: "eip155:*" as Network, client: scheme }],
    ...opts.config,
  });
}

/** Connects `client` to the Streamable HTTP endpoint at `url`. */
export async function connectServer(client: x402MCPClient, url: string): Promise<void> {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
}

/** `tools/list` for a connected client. */
export async function listServerTools(client: x402MCPClient): Promise<ListedTool[]> {
  const listed = await client.listTools();
  return listed.tools.map((t) => ({ name: t.name, description: t.description }));
}

/**
 * One `callTool` that never throws: a refusal ("Payment request denied") or a failed call
 * becomes `thrown`. A tool `isError` is a normal outcome, not a failure (condition 3).
 */
export async function callToolSafely(
  client: x402MCPClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpCallOutcome> {
  try {
    const res = await client.callTool(name, args);
    return {
      isError: res.isError === true,
      paymentMade: res.paymentMade,
      ...(res.paymentResponse
        ? { settled: res.paymentResponse.success, transaction: res.paymentResponse.transaction }
        : {}),
      text: resultText(res.content),
    };
  } catch (err) {
    return {
      paymentMade: false,
      text: "",
      thrown: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One stdout line per call, read by the interop test through the agent log. */
export function logCall(agent: string, server: string, tool: string, o: McpCallOutcome): void {
  console.log(
    JSON.stringify({
      agent,
      server,
      tool,
      isError: o.isError,
      paymentMade: o.paymentMade,
      settled: o.settled,
      transaction: o.transaction,
      thrown: o.thrown,
    }),
  );
}

export type { PaymentRequestedContext };

/** Closes a client, ignoring a transport that is already gone. */
export async function closeQuietly(client: x402MCPClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // The run is over; a transport that will not close cleanly is not the agent's failure.
  }
}
