/**
 * The Cloudflare Agents SDK child (U33 §3.1). Runs sandboxed, with the guard preloaded, and
 * with no API key in its environment. It builds the package's client wrapper over an MCP SDK
 * client, with the task's seed-derived test key, and makes the planned calls. It speaks JSON
 * lines over fd 3:
 *   in:  {"id", "action", "args"}
 *   out: {"id", "ok": true, "result"} | {"id", "ok": false, "error"}
 * Actions: `start` (check the loaded versions, connect, read `tools/list`), `call` (one
 * planned tool through the wrapper), `__env_names`.
 * stdout is not the channel: console output goes to stderr.
 */
// First import: evaluated before the package loads, so its console output never reaches stdout.
import "./stdout-to-stderr.js";
import net from "node:net";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withX402Client } from "agents/x402";
import { privateKeyToAccount } from "viem/accounts";
import { approves } from "./profiles.js";
import {
  type CallArgs,
  type CallResult,
  INTENT_PREFIX,
  type Intent,
  PROFILES,
  RAISED_CAP_ATOMIC,
  type ReadyReport,
  routeKey,
  type SeenAccept,
  type StartArgs,
} from "./protocol.js";
import { readTask, type TaskFile } from "./task.js";
import { checkPins, loadedVersions } from "./versions.js";

type Wrapped = ReturnType<typeof withX402Client<Client>>;
type X402Config = Parameters<typeof withX402Client<Client>>[1];

interface Session {
  client: Wrapped;
  server: string;
  /** State of the call in flight (calls run one at a time). */
  current: { tool: string; signed: number; accepts_seen: SeenAccept[][]; decisions: boolean[] };
}

let session: Session | undefined;

function evmKey(task: TaskFile): `0x${string}` {
  if (task.chain !== "evm" || !("private_key" in task.wallet)) {
    throw new Error("the Cloudflare adapter supports EVM tasks only");
  }
  return task.wallet.private_key as `0x${string}`;
}

function seen(accepts: readonly Record<string, unknown>[]): SeenAccept[] {
  return accepts.map((a) => ({
    scheme: a.scheme,
    network: a.network,
    asset: a.asset,
    amount: a.amount,
    pay_to: a.payTo,
  }));
}

/** The package's config for a profile (U33 §3.2). `state` is the call in flight. */
function configFor(
  args: StartArgs,
  task: TaskFile,
  state: () => Session["current"],
): X402Config {
  const base = privateKeyToAccount(evmKey(task));
  // Wrapping `signTypedData` only logs the request (route, payTo, network) before delegating.
  const account = {
    address: base.address,
    signTypedData: async (message: Parameters<typeof base.signTypedData>[0]) => {
      const current = state();
      current.signed += 1;
      const typed = message as unknown as {
        domain?: { chainId?: number | bigint; verifyingContract?: string };
        message?: { to?: string; value?: bigint | string | number };
      };
      const chainId = typed.domain?.chainId;
      const intent: Intent = {
        route: routeKey(args.server, current.tool),
        pay_to: typed.message?.to,
        network: chainId === undefined ? undefined : `eip155:${chainId}`,
        asset: typed.domain?.verifyingContract,
        value_atomic: typed.message?.value === undefined ? undefined : String(typed.message.value),
      };
      process.stderr.write(`${INTENT_PREFIX}${JSON.stringify(intent)}\n`);
      return base.signTypedData(message);
    },
  };
  const config: X402Config = { account: account as unknown as X402Config["account"], network: task.network };
  if (args.profile === "raised-cap") config.maxPaymentValue = RAISED_CAP_ATOMIC;
  if (args.profile === "approve") {
    const price = args.price_atomic === null ? undefined : BigInt(args.price_atomic);
    config.confirmationCallback = async (payment) => {
      const current = state();
      const list = seen(payment as unknown as Record<string, unknown>[]);
      current.accepts_seen.push(list);
      const ok = price !== undefined && approves(list, price);
      current.decisions.push(ok);
      return ok;
    };
  }
  return config;
}

async function start(args: StartArgs): Promise<ReadyReport> {
  if (!PROFILES.includes(args?.profile)) throw new Error(`unknown profile ${String(args?.profile)}`);
  const task = readTask();
  const loaded = loadedVersions();
  checkPins(args.pins, loaded);

  const client = new Client({ name: "x402-redteam-cloudflare-adapter", version: "0.0.0" });
  const current: Session["current"] = { tool: "", signed: 0, accepts_seen: [], decisions: [] };
  const wrapped = withX402Client(client, configFor(args, task, () => current));
  await client.connect(new StreamableHTTPClientTransport(new URL(args.url)));
  const listed = await wrapped.listTools();
  session = { client: wrapped, server: args.server, current };
  return { loaded: { agents: loaded.agents, core: loaded.core, evm: loaded.evm }, tools: listed.tools.map((t) => t.name) };
}

async function callPlanned(args: CallArgs): Promise<CallResult> {
  if (!session) throw new Error("call before start");
  const { current } = session;
  current.tool = args.tool;
  current.signed = 0;
  current.accepts_seen = [];
  current.decisions = [];
  const out = (extra: Partial<CallResult>): CallResult => ({
    tool: args.tool,
    signed: current.signed,
    accepts_seen: current.accepts_seen,
    decisions: current.decisions,
    ...extra,
  });
  try {
    const result = await session.client.callTool(null, { name: args.tool, arguments: {} });
    return out({ result: JSON.parse(JSON.stringify(result)) });
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    return out({
      thrown: {
        name: typeof e?.name === "string" ? e.name : "Error",
        message: err instanceof Error ? err.message : String(err),
        ...(typeof e?.code === "number" ? { code: e.code } : {}),
      },
    });
  }
}

interface ChannelRequest {
  id: unknown;
  action: unknown;
  args?: unknown;
}

async function dispatch(req: ChannelRequest): Promise<unknown> {
  if (req.action === "start") return start(req.args as StartArgs);
  if (req.action === "call") return callPlanned(req.args as CallArgs);
  if (req.action === "__env_names") return Object.keys(process.env).sort();
  throw new Error(`unknown action ${String(req.action)}`);
}

export async function main(): Promise<void> {
  const channel = new net.Socket({ fd: 3, readable: true, writable: true });
  channel.on("error", (err) => {
    console.error(`cloudflare child: fd 3 channel to the parent failed: ${err.message}`);
    process.exit(1);
  });
  const send = (msg: object): void => {
    channel.write(`${JSON.stringify(msg)}\n`);
  };
  const lines = createInterface({ input: channel });
  // Actions run one at a time, in arrival order: calls are made in the planned order.
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let req: ChannelRequest;
    try {
      req = JSON.parse(line) as ChannelRequest;
    } catch {
      send({ id: null, ok: false, error: "malformed request" });
      return;
    }
    queue = queue.then(async () => {
      try {
        send({ id: req.id, ok: true, result: await dispatch(req) });
      } catch (err) {
        send({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
  lines.on("close", () => {
    void queue.then(async () => {
      await session?.client.close().catch(() => {});
      channel.end(() => process.exit(0));
    });
  });
}

if (process.argv[1]?.endsWith("child.ts")) {
  main().catch((err) => {
    console.error("cloudflare child:", err);
    process.exit(1);
  });
}
