/**
 * Test-only task builder for a live `@x402-redteam/adversary` instance, mirroring
 * `packages/cli/src/task.ts`'s `buildTask` (owned by U9-A/U10) without adding a
 * dependency on `@x402-redteam/cli` from `examples/agents` - the example agents
 * deliberately don't depend on the CLI package (see `lib/wallet.ts`'s `TaskFile` doc).
 * Chosen scenario: the real corpus's `control-paid-fetch` (a single fair-price paywalled
 * endpoint that pays and delivers), so `http_get`/`pay_and_get`/`send_usdc` and the
 * Python agent smoke test all exercise the real challenge/verify/settle path end to end.
 */
import { fileURLToPath } from "node:url";
import {
  agentWallet,
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  DEFAULT_HOST,
  type HostMode,
  hostName,
  hostUrl,
  isToolRoute,
  loadCorpus,
  MCP_PATH,
  type RenderContext,
  render,
  type Scenario,
  walletBalanceUsd,
} from "@x402-redteam/schema";
import type { TaskFile } from "../../src/lib/wallet.js";

export const SEED = "x402-redteam-v1";
const CORPUS_DIR = fileURLToPath(new URL("../../../../corpus", import.meta.url));

let cachedCorpus: Scenario[] | undefined;

function corpus(): Scenario[] {
  if (!cachedCorpus) cachedCorpus = loadCorpus(CORPUS_DIR);
  return cachedCorpus;
}

/** Loads a real corpus scenario by id - throws (loudly, in a test) if it's ever renamed. */
export function loadScenarioById(id: string): Scenario {
  const scenario = corpus().find((s) => s.id === id);
  if (!scenario) throw new Error(`live-task: scenario "${id}" not found in ${CORPUS_DIR}`);
  return scenario;
}

function renderContext(scenario: Scenario, chain: Chain, baseUrl: string): RenderContext {
  const defaults = CHAIN_DEFAULTS[chain];
  const scenarioCanaries = canaries(SEED, scenario.id, chain);
  return {
    base_url: baseUrl,
    chain,
    network: defaults.network,
    usdc: defaults.asset,
    host: (name: string) => `${baseUrl}/_host/${name}`,
    canary: (name: string) => scenarioCanaries.get(name).address,
    poison: (name: string) => scenarioCanaries.poison(name),
  };
}

/** Builds a `TaskFile` for `scenario` against a live adversary at `baseUrl`, exactly like
 * `cli/src/task.ts`'s `buildTask` (kept independent per the file's own docstring). */
export function buildLiveTask(scenario: Scenario, chain: Chain, baseUrl: string): TaskFile {
  const ctx = renderContext(scenario, chain, baseUrl);
  const prompt = render(scenario.task.prompt, ctx);
  const wallet = agentWallet(SEED, chain);

  return {
    version: 2,
    run_id: `${scenario.id}-${chain}-test`,
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
    wallet_balance_usd: walletBalanceUsd(scenario.task),
    evm_rpc_url: `${baseUrl}/evm-rpc`,
  };
}

const MCP_CORPUS_DIR = fileURLToPath(new URL("../../../../corpus-mcp", import.meta.url));

let cachedMcpCorpus: Scenario[] | undefined;

/** Loads a real `corpus-mcp` scenario by id. */
export function loadMcpScenarioById(id: string): Scenario {
  if (!cachedMcpCorpus) cachedMcpCorpus = loadCorpus(MCP_CORPUS_DIR);
  const scenario = cachedMcpCorpus.find((s) => s.id === id);
  if (!scenario) throw new Error(`live-task: scenario "${id}" not found in ${MCP_CORPUS_DIR}`);
  return scenario;
}

/**
 * Like `buildLiveTask`, for an MCP scenario under a host mode: a v4 task with `hosts` and
 * `mcp_servers`, rendered like `cli/src/task.ts`'s `buildTask`. The adversary must be
 * created with the same `hostMode`.
 */
export function buildLiveMcpTask(
  scenario: Scenario,
  baseUrl: string,
  hostMode: HostMode = "path",
): TaskFile {
  const chain: Chain = "evm";
  const defaults = CHAIN_DEFAULTS[chain];
  const scenarioCanaries = canaries(SEED, scenario.id, chain);
  const ctx: RenderContext = {
    base_url: hostMode === "path" ? baseUrl : hostUrl(hostMode, baseUrl, DEFAULT_HOST),
    chain,
    network: defaults.network,
    usdc: defaults.asset,
    host: (name: string) => hostUrl(hostMode, baseUrl, name),
    canary: (name: string) => scenarioCanaries.get(name).address,
    poison: (name: string) => scenarioCanaries.poison(name),
  };
  const hostNames = new Set<string>([
    ...scenario.routes.map((r) => r.host),
    ...(scenario.task.allowed_hosts ?? []),
  ]);
  const hosts: Record<string, string> = {};
  for (const name of hostNames) hosts[name] = hostUrl(hostMode, baseUrl, name);
  const mcp_servers: Record<string, string> = {};
  for (const route of scenario.routes) {
    if (isToolRoute(route)) mcp_servers[route.host] = `${hosts[route.host]}${MCP_PATH}`;
  }
  return {
    ...buildLiveTask(scenario, chain, baseUrl),
    version: 4,
    prompt: render(scenario.task.prompt, ctx),
    allowed_hosts: (scenario.task.allowed_hosts ?? []).map((h) => hostName(hostMode, h)),
    host_mode: hostMode,
    hosts,
    parallel: false,
    mcp_servers,
  } as unknown as TaskFile;
}
