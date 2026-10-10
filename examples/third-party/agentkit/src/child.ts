/**
 * The AgentKit tool server (U25 §3.1, §3.5.1). Runs sandboxed, with the guard preloaded,
 * and with no API key in its environment. It speaks JSON lines over fd 3:
 *   in:  {"id", "action", "args"}
 *   out: {"id", "ok": true, "result"} | {"id", "ok": false, "error"}
 * stdout is not the channel: AgentKit's own console.log output goes to stderr.
 *
 * Actions are AgentKit's own names (e.g. `X402ActionProvider_make_http_request`), plus
 * `__list_actions` (name, description and JSON schema of each action) and `__provenance`
 * (the versions the child actually loaded, see loaded-versions.ts).
 */
// First import: evaluated before AgentKit loads, so its console output never reaches stdout.
import "./stdout-to-stderr.js";
import net from "node:net";
import { createInterface } from "node:readline";
import {
  type Action,
  AgentKit,
  erc20ActionProvider,
  ViemWalletProvider,
  walletActionProvider,
  x402ActionProvider,
} from "@coinbase/agentkit";
import { wrapEvmAccount } from "@x402-redteam/capture";
import { createWalletClient, http, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { zodToJsonSchema } from "zod-to-json-schema";

// Untyped on purpose: its generic types recurse too deeply over AgentKit's zod schemas.
const toJsonSchema = zodToJsonSchema as unknown as (schema: unknown) => unknown;
import { agentkitEntry, loadedVersions } from "./loaded-versions.js";
import { readTask } from "./task.js";

interface Request {
  id: unknown;
  action: unknown;
  args?: unknown;
}

async function buildActions(): Promise<Map<string, Action>> {
  const task = readTask();
  if (task.chain !== "evm" || !("private_key" in task.wallet)) {
    throw new Error("the AgentKit adapter supports EVM tasks only (U25 §3)");
  }
  if (!task.evm_rpc_url) throw new Error("task.evm_rpc_url is not set");

  // Built with the viem AgentKit resolves (2.38.3). The shim is typed against the
  // harness's viem; it only spreads the account and wraps two methods, so cast across.
  const local: LocalAccount = privateKeyToAccount(task.wallet.private_key as `0x${string}`);
  const account = wrapEvmAccount(local as never, {
    ledgerUrl: task.ledger_url,
  }) as unknown as LocalAccount;
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(task.evm_rpc_url),
  });
  // Both the wallet client and the provider's read client use the harness RPC.
  const walletProvider = new ViemWalletProvider(walletClient, { rpcUrl: task.evm_rpc_url });
  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [x402ActionProvider(), walletActionProvider(), erc20ActionProvider()],
  });
  return new Map(agentkit.getActions().map((a) => [a.name, a]));
}

async function handle(actions: Map<string, Action>, req: Request): Promise<unknown> {
  if (req.action === "__list_actions") {
    return [...actions.values()].map((a) => ({
      name: a.name,
      description: a.description,
      input_schema: toJsonSchema(a.schema),
    }));
  }
  if (req.action === "__provenance") return loadedVersions(agentkitEntry());
  const action = typeof req.action === "string" ? actions.get(req.action) : undefined;
  if (!action) throw new Error(`unknown action ${String(req.action)}`);
  // Parse like AgentKit's framework extensions do, so schema defaults apply.
  return action.invoke(action.schema.parse(req.args ?? {}));
}

async function main(): Promise<void> {
  const channel = new net.Socket({ fd: 3, readable: true, writable: true });
  channel.on("error", (err) => {
    console.error(`agentkit child: fd 3 channel to the parent failed: ${err.message}`);
    process.exit(1);
  });
  const send = (msg: object): void => {
    channel.write(`${JSON.stringify(msg)}\n`);
  };

  const actions = await buildActions();
  const lines = createInterface({ input: channel });
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    // One request at a time, in arrival order, so runs stay deterministic.
    queue = queue.then(async () => {
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        send({ id: null, ok: false, error: "malformed request" });
        return;
      }
      try {
        send({ id: req.id, ok: true, result: await handle(actions, req) });
      } catch (err) {
        send({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
  lines.on("close", () => {
    void queue.then(() => channel.end(() => process.exit(0)));
  });
}

main().catch((err) => {
  console.error("agentkit child:", err);
  process.exit(1);
});
