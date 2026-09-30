import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentWallet,
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  type RenderContext,
  render,
  type Scenario,
} from "@x402-redteam/schema";

/** The harness's task.json (version 1), per application-design.md §6. */
export interface TaskFile {
  version: 1;
  run_id: string;
  prompt: string;
  base_url: string;
  chain: Chain;
  network: string;
  budget_usd: number;
  allowed_hosts: string[];
  wallet: { address: string; private_key: string } | { address: string; secret_key_base58: string };
  facilitator_url: string;
  solana_rpc_url: string;
  ledger_url: string;
  notice: string;
}

/**
 * Builds the same render context the adversary uses for this
 * (seed, scenario, chain, baseUrl) so the rendered prompt is byte-identical
 * to what the routes/challenges the agent will actually see were rendered
 * with - see adversary/src/render.ts `buildRenderContext`.
 */
function taskRenderContext(
  seed: string,
  scenario: Scenario,
  chain: Chain,
  baseUrl: string,
): RenderContext {
  const defaults = CHAIN_DEFAULTS[chain];
  const scenarioCanaries = canaries(seed, scenario.id, chain);
  return {
    base_url: baseUrl,
    chain,
    network: defaults.network,
    usdc: defaults.asset,
    host: (name: string) => `${baseUrl}/_host/${name}`,
    canary: (name: string) => scenarioCanaries.get(name).address,
  };
}

export interface BuildTaskOptions {
  scenario: Scenario;
  chain: Chain;
  baseUrl: string;
  seed: string;
  run_id: string;
}

/**
 * `buildTask(scenario, chain, baseUrl, seed, run_id) -> TaskFile`, per
 * functional-design.md §4. The wallet comes from `agentWallet(seed, chain)`;
 * `budget_usd`/`allowed_hosts` are taken from the scenario task (defaulting
 * to "no budget"/"no hosts" - i.e. never pay - when the scenario leaves
 * either unspecified, which is the safe default for a hostile scenario).
 */
export function buildTask(opts: BuildTaskOptions): TaskFile {
  const { scenario, chain, baseUrl, seed, run_id } = opts;
  const ctx = taskRenderContext(seed, scenario, chain, baseUrl);
  const prompt = render(scenario.task.prompt, ctx);
  const wallet = agentWallet(seed, chain);

  return {
    version: 1,
    run_id,
    prompt,
    base_url: baseUrl,
    chain,
    network: CHAIN_DEFAULTS[chain].network,
    budget_usd: scenario.task.budget_usd ?? 0,
    allowed_hosts: scenario.task.allowed_hosts ?? [],
    wallet:
      chain === "evm"
        ? { address: wallet.address, private_key: wallet.secret }
        : { address: wallet.address, secret_key_base58: wallet.secret },
    facilitator_url: `${baseUrl}/facilitator`,
    solana_rpc_url: `${baseUrl}/solana-rpc`,
    ledger_url: `${baseUrl}/__harness/ledger`,
    notice: "TEST KEYS ONLY — no funds",
  };
}

/** Writes `<outDir>/tasks/<run_id>.json` and returns its absolute path. */
export function writeTaskFile(outDir: string, task: TaskFile): string {
  const dir = resolve(outDir, "tasks");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${task.run_id}.json`);
  writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`);
  return file;
}
