/**
 * The ClawRouter child (U28 §3). Runs sandboxed, with the guard preloaded, and with no API
 * key in its environment. It imports the published `@blockrun/clawrouter` and calls
 * `startProxy` with the task's seed-derived test key. It speaks JSON lines over fd 3:
 *   in:  {"id", "action", "args"}
 *   out: {"id", "ok": true, "result"} | {"id", "ok": false, "error"}
 * Actions: `start` (bring the proxy up, run the start-up checks, report), `chat` (one
 * request to the child's own proxy), `__env_names`.
 * stdout is not the channel: the package's console output goes to stderr.
 */
// First import: evaluated before ClawRouter loads, so its console output never reaches stdout.
import "./stdout-to-stderr.js";
import net from "node:net";
import { createInterface } from "node:readline";
import {
  InMemorySpendControlStorage,
  type ProxyHandle,
  type ProxyOptions,
  SpendControl,
  startProxy,
} from "@blockrun/clawrouter";
import { ObservingSpendControl } from "./observing-spend-control.js";
import { trackCatalogFetches } from "./catalog.js";
import { verifyHandle } from "./handle-check.js";
import { DEFAULT_PAYER_PORT, parseProxyPort, PORT_ENV } from "./ports.js";
import {
  CHAT_ROUTE,
  type ChatArgs,
  type ChatResult,
  INTENT_PREFIX,
  type Intent,
  PROFILES,
  type ReadyReport,
  type StartArgs,
} from "./protocol.js";
import { readTask, type TaskFile } from "./task.js";

/** How long the start-up catalog fetches get to settle before the run is unmeasured. */
const CATALOG_SETTLE_MS = 10_000;
/** A planned request to the child's own proxy gives up after this long. */
const CHAT_TIMEOUT_MS = 200_000;

/** A stand-in balance monitor, so the package makes no balance read of its own. It reports
 * the task's modelled wallet balance as USDC. */
function stubBalanceMonitor(address: string, balanceUsd: number) {
  const balance = BigInt(Math.round(balanceUsd * 1_000_000));
  const info = {
    balance,
    balanceUSD: `$${balanceUsd.toFixed(2)}`,
    isLow: balance < 1_000_000n,
    isEmpty: balance < 100n,
    walletAddress: address,
  };
  return {
    async checkBalance() {
      return info;
    },
    async checkSufficient(estimatedCostMicros: bigint) {
      return { sufficient: balance >= estimatedCostMicros, info };
    },
    deductEstimated() {},
    invalidate() {},
    async refresh() {
      return info;
    },
    formatUSDC(micros: bigint) {
      return `$${(Number(micros) / 1_000_000).toFixed(2)}`;
    },
    getWalletAddress() {
      return address;
    },
  };
}

function evmKey(task: TaskFile): string {
  if (task.chain !== "evm" || !("private_key" in task.wallet)) {
    throw new Error("the ClawRouter adapter supports EVM tasks only (U28 §9)");
  }
  return task.wallet.private_key;
}

/** The options handed to `startProxy`. The parent records the same list in provenance. */
export function proxyOptions(
  task: TaskFile,
  profile: StartArgs["profile"],
  port: number,
): ProxyOptions {
  const spendControl = new ObservingSpendControl({ storage: new InMemorySpendControlStorage() });
  const options: ProxyOptions = {
    wallet: evmKey(task),
    apiBase: task.base_url,
    paymentChain: "base",
    port,
    allowExistingProxy: false,
    skipBalanceCheck: true,
    spendControl,
  };
  if (profile === "budget") {
    spendControl.setLimit("session", task.budget_usd);
    spendControl.setLimit("perRequest", task.budget_usd);
    options.maxCostPerRunUsd = task.budget_usd;
    options.maxCostPerRunMode = "strict";
  }
  return options;
}

let handle: ProxyHandle | undefined;
let proxyPort = 0;

async function start(args: StartArgs): Promise<ReadyReport> {
  if (!PROFILES.includes(args?.profile)) throw new Error(`unknown profile ${String(args?.profile)}`);
  const task = readTask();
  const port = parseProxyPort(process.env[PORT_ENV]);
  if (port === undefined || port === DEFAULT_PAYER_PORT) {
    throw new Error(`${PORT_ENV} must be a valid port other than ${DEFAULT_PAYER_PORT}`);
  }
  proxyPort = port;
  const tracker = trackCatalogFetches(task.base_url);
  const options = proxyOptions(task, args.profile, port);
  const balanceUsd = task.wallet_balance_usd ?? 100;
  options._balanceMonitorOverride = stubBalanceMonitor(
    task.wallet.address,
    balanceUsd,
  ) as unknown as ProxyOptions["_balanceMonitorOverride"];
  handle = await startProxy(options);
  // Checks before any request leaves (U28 §3; N3): our port, our wallet, wallet mode.
  verifyHandle(handle, { port, walletAddress: task.wallet.address });
  const catalogSettled = await tracker.settled(CATALOG_SETTLE_MS);
  return {
    port: handle.port,
    wallet_address: handle.walletAddress,
    auth_mode: handle.authMode,
    catalog_settled: catalogSettled,
    catalog_requests: tracker.count(),
    balance_stub_usd: balanceUsd,
  };
}

async function chat(args: ChatArgs): Promise<ChatResult> {
  if (!handle) throw new Error("chat before start");
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${CHAT_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: "user", content: args.content }],
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: "", transport_error: err instanceof Error ? err.message : String(err) };
  }
}

interface ChannelRequest {
  id: unknown;
  action: unknown;
  args?: unknown;
}

async function dispatch(req: ChannelRequest): Promise<unknown> {
  if (req.action === "start") return start(req.args as StartArgs);
  if (req.action === "chat") return chat(req.args as ChatArgs);
  if (req.action === "__env_names") return Object.keys(process.env).sort();
  throw new Error(`unknown action ${String(req.action)}`);
}

export async function main(): Promise<void> {
  const channel = new net.Socket({ fd: 3, readable: true, writable: true });
  channel.on("error", (err) => {
    console.error(`clawrouter child: fd 3 channel to the parent failed: ${err.message}`);
    process.exit(1);
  });
  const send = (msg: object): void => {
    channel.write(`${JSON.stringify(msg)}\n`);
  };
  const lines = createInterface({ input: channel });
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    // Control actions run one at a time, in arrival order. A `chat` runs as soon as it
    // arrives, so a parallel scenario's calls are in flight together.
    let req: ChannelRequest;
    try {
      req = JSON.parse(line) as ChannelRequest;
    } catch {
      send({ id: null, ok: false, error: "malformed request" });
      return;
    }
    const run = async (): Promise<void> => {
      try {
        send({ id: req.id, ok: true, result: await dispatch(req) });
      } catch (err) {
        send({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    if (req.action === "chat") void run();
    else queue = queue.then(run);
  });
  lines.on("close", () => {
    void queue.then(async () => {
      await handle?.close().catch(() => {});
      channel.end(() => process.exit(0));
    });
  });
}

if (process.argv[1]?.endsWith("child.ts")) {
  main().catch((err) => {
    console.error("clawrouter child:", err);
    process.exit(1);
  });
}
