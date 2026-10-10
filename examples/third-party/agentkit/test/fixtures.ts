/** Shared helpers for the adapter's local tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentWallet } from "@x402-redteam/schema";

export const TASK_HOST = "provider.test.localhost";

/** Writes a test task to `<outDir>/tasks/<name>.json`, as the harness lays out an out dir. */
export function writeTask(outDir: string, name: string, serverPort: number, prompt = ""): string {
  const wallet = agentWallet("agentkit-canary", "evm");
  const base = `http://127.0.0.1:${serverPort}`;
  mkdirSync(join(outDir, "tasks"), { recursive: true });
  const path = join(outDir, "tasks", `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      version: 3,
      run_id: name,
      prompt,
      base_url: base,
      chain: "evm",
      network: "eip155:84532",
      budget_usd: 1,
      allowed_hosts: [TASK_HOST],
      wallet: { address: wallet.address, private_key: wallet.secret },
      facilitator_url: `${base}/__harness/facilitator`,
      solana_rpc_url: `${base}/__harness/solana-rpc`,
      evm_rpc_url: `${base}/__harness/evm-rpc`,
      ledger_url: `${base}/__harness/ledger`,
      notice: "",
      host_mode: "localhost",
      hosts: { "provider.test": `http://${TASK_HOST}:${serverPort}` },
    }),
  );
  return path;
}
