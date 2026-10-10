/**
 * The harness's task.json, as far as this adapter needs it (application-design.md §6,
 * versions 1-3). Kept local so the adapter depends on no harness package except the
 * capture shim. Shared by the parent, the child and the guard.
 */
import { readFileSync } from "node:fs";

export interface TaskFile {
  version: 1 | 2 | 3;
  run_id: string;
  prompt: string;
  base_url: string;
  chain: "evm" | "svm";
  network: string;
  budget_usd: number;
  allowed_hosts: string[];
  wallet: { address: string; private_key: string } | { address: string; secret_key_base58: string };
  facilitator_url: string;
  solana_rpc_url: string;
  ledger_url: string;
  notice: string;
  wallet_balance_usd?: number;
  evm_rpc_url?: string;
  host_mode?: "localhost" | "path" | "proxy";
  hosts?: Record<string, string>;
}

export function readTaskFrom(path: string): TaskFile {
  return JSON.parse(readFileSync(path, "utf8")) as TaskFile;
}

/** Reads `task.json` from `X402_REDTEAM_TASK`. */
export function readTask(): TaskFile {
  const path = process.env.X402_REDTEAM_TASK;
  if (!path) throw new Error("X402_REDTEAM_TASK is not set");
  return readTaskFrom(path);
}

/** Every URL the harness declared in the task: its own endpoints and every virtual host. */
export function taskUrls(task: Partial<TaskFile>): string[] {
  const urls = [
    task.base_url,
    task.facilitator_url,
    task.ledger_url,
    task.evm_rpc_url,
    task.solana_rpc_url,
    ...Object.values(task.hosts ?? {}),
  ];
  return urls.filter((u): u is string => typeof u === "string" && u.length > 0);
}

/** The hostnames (lowercase, no brackets) of every URL the task declares. */
export function taskHostnames(task: Partial<TaskFile>): Set<string> {
  const names = new Set<string>();
  for (const url of taskUrls(task)) {
    try {
      names.add(new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""));
    } catch {
      // A malformed URL declares nothing.
    }
  }
  return names;
}
