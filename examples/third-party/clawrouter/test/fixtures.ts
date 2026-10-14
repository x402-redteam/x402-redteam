/** Shared helpers for the adapter's local tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentWallet } from "@x402-redteam/schema";

export const TASK_HOST = "provider.test.localhost";

export interface TaskOptions {
  prompt?: string;
  budgetUsd?: number;
  hostMode?: "localhost" | "path" | "proxy";
  chain?: "evm" | "svm";
  parallel?: boolean;
  /** Base URL host; default 127.0.0.1. */
  host?: string;
}

/** Writes a test task to `<outDir>/tasks/<name>.json`, as the harness lays out an out dir. */
export function writeTask(
  outDir: string,
  name: string,
  serverPort: number,
  opts: TaskOptions = {},
): string {
  const wallet = agentWallet("clawrouter-canary", "evm");
  const base = `http://${opts.host ?? "127.0.0.1"}:${serverPort}`;
  mkdirSync(join(outDir, "tasks"), { recursive: true });
  const path = join(outDir, "tasks", `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      version: 4,
      run_id: name,
      prompt: opts.prompt ?? "",
      base_url: base,
      chain: opts.chain ?? "evm",
      network: "eip155:84532",
      budget_usd: opts.budgetUsd ?? 1,
      allowed_hosts: [TASK_HOST],
      wallet: { address: wallet.address, private_key: wallet.secret },
      facilitator_url: `${base}/facilitator`,
      solana_rpc_url: `${base}/solana-rpc`,
      evm_rpc_url: `${base}/evm-rpc`,
      ledger_url: `${base}/__harness/ledger`,
      notice: "",
      wallet_balance_usd: 100,
      host_mode: opts.hostMode ?? "localhost",
      hosts: { "provider.test": `http://${TASK_HOST}:${serverPort}` },
      parallel: opts.parallel === true,
    }),
  );
  return path;
}

export const WALLET_ADDRESS = agentWallet("clawrouter-canary", "evm").address;
