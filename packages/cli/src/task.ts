import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentWallet,
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  DEFAULT_HOST,
  type HostMode,
  hostName,
  hostUrl,
  type RenderContext,
  render,
  type Scenario,
  walletBalanceUsd,
} from "@x402-redteam/schema";

/**
 * The harness's task.json, version 3 (ADR-012, application-design.md "Contracts (v3,
 * Bolt 6)"): additive over version 2 except `allowed_hosts`, whose *values* are now
 * rendered through the active `host_mode` (ADR-012 calls this out as breaking for a
 * guardrail that compared against the bare `provider.test` - the reference agents are
 * updated in U17). In `host_mode: "path"` (U15's Phase A default), `hostName` is the
 * identity function, so `allowed_hosts` keeps today's exact values.
 */
export interface TaskFile {
  version: 3;
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
  /** v2 (ADR-015): the modelled wallet balance, defaulted via `walletBalanceUsd()`. */
  wallet_balance_usd: number;
  /** v2 (ADR-013): the mock EVM JSON-RPC this run's adversary serves. */
  evm_rpc_url: string;
  /** v3 (ADR-012): which host mode rendered this task's URLs/`allowed_hosts`. */
  host_mode: HostMode;
  /** v3 (ADR-012): every virtual host this scenario declares, mapped to its rendered
   * origin under `host_mode` - so an agent/guardrail never has to reimplement
   * `hostUrl()` itself to know where a named host actually lives. */
  hosts: Record<string, string>;
}

/**
 * Builds the same render context the adversary uses for this
 * (seed, scenario, chain, baseUrl) so the rendered prompt is byte-identical
 * to what the routes/challenges the agent will actually see were rendered
 * with - see adversary/src/render.ts `buildRenderContext`.
 */
/**
 * Code review item 2 (orchestrator decision): `{{base_url}}` in a scenario template
 * means the provider host's own URL, not the harness's bare origin - mirrors
 * `adversary/src/render.ts`'s identically-named helper exactly (byte-identical in `path`
 * mode; renders `http://provider.test.localhost:<port>` etc. in every other mode). The
 * TaskFile's own `base_url` field (below) is a separate, unaffected value - the harness
 * origin `facilitator_url`/`solana_rpc_url`/etc. are built from.
 */
function providerBaseUrl(hostMode: HostMode, baseUrl: string): string {
  return hostMode === "path" ? baseUrl : hostUrl(hostMode, baseUrl, DEFAULT_HOST);
}

function taskRenderContext(
  seed: string,
  scenario: Scenario,
  chain: Chain,
  baseUrl: string,
  hostMode: HostMode,
): RenderContext {
  const defaults = CHAIN_DEFAULTS[chain];
  const scenarioCanaries = canaries(seed, scenario.id, chain);
  return {
    base_url: providerBaseUrl(hostMode, baseUrl),
    chain,
    network: defaults.network,
    usdc: defaults.asset,
    host: (name: string) => hostUrl(hostMode, baseUrl, name),
    canary: (name: string) => scenarioCanaries.get(name).address,
  };
}

export interface BuildTaskOptions {
  scenario: Scenario;
  chain: Chain;
  baseUrl: string;
  seed: string;
  run_id: string;
  /** v3 (ADR-012): defaults to "path" (U15's Phase A default; U17 flips the CLI default). */
  hostMode?: HostMode;
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
  const hostMode = opts.hostMode ?? "path";
  const ctx = taskRenderContext(seed, scenario, chain, baseUrl, hostMode);
  const prompt = render(scenario.task.prompt, ctx);
  const wallet = agentWallet(seed, chain);

  // v3 (ADR-012; code review item 7d): every distinct virtual host this scenario
  // declares - every route's host *and* every `task.allowed_hosts` entry, since a
  // scenario can legitimately allow a host that has no route of its own in this
  // particular variant - rendered to its origin under `hostMode`. Includes the default
  // host ("provider.test" today), so `hosts` is a complete lookup table.
  const hostNames = new Set<string>([
    ...scenario.routes.map((r) => r.host),
    ...(scenario.task.allowed_hosts ?? []),
  ]);
  const hosts: Record<string, string> = {};
  for (const name of hostNames) {
    hosts[name] = hostUrl(hostMode, baseUrl, name);
  }

  return {
    version: 3,
    run_id,
    prompt,
    base_url: baseUrl,
    chain,
    network: CHAIN_DEFAULTS[chain].network,
    budget_usd: scenario.task.budget_usd ?? 0,
    allowed_hosts: (scenario.task.allowed_hosts ?? []).map((h) => hostName(hostMode, h)),
    wallet:
      chain === "evm"
        ? { address: wallet.address, private_key: wallet.secret }
        : { address: wallet.address, secret_key_base58: wallet.secret },
    facilitator_url: `${baseUrl}/facilitator`,
    solana_rpc_url: `${baseUrl}/solana-rpc`,
    ledger_url: `${baseUrl}/__harness/ledger`,
    notice: "TEST KEYS ONLY — no funds",
    wallet_balance_usd: walletBalanceUsd(scenario.task),
    evm_rpc_url: `${baseUrl}/evm-rpc`,
    host_mode: hostMode,
    hosts,
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
