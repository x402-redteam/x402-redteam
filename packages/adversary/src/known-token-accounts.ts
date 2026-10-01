import { type AssetSpec, agentWallet, CHAIN_DEFAULTS, type Chain } from "@x402-redteam/schema";
import { buildKnownTokenAccounts } from "./record.js";
import type { RenderedScenario } from "./render.js";

export type KnownTokenAccounts = Record<string, { owner: string; mint: string }>;

/** Chain USDC plus every asset actually named by this scenario's (rendered) challenges
 * and its own `assets:` overrides (asset_swap/rail_switch) - every svm mint
 * `buildKnownTokenAccounts` needs to derive ATAs for. Exported so `solana-rpc.ts` can
 * recognize the same mints (`getAccountInfo`) it derives ATAs for here, instead of
 * keeping its own, independently-drifting copy of this set. */
export function knownSvmMints(
  rendered: RenderedScenario,
  scenarioAssets: AssetSpec[] | undefined,
): string[] {
  const mints = new Set<string>();
  mints.add(CHAIN_DEFAULTS.svm.asset);
  for (const route of rendered.routes) {
    for (const accept of route.challenge?.accepts ?? []) {
      if (accept.asset) mints.add(accept.asset);
    }
  }
  for (const asset of scenarioAssets ?? []) {
    if (asset.chain === "svm") mints.add(asset.address);
  }
  return [...mints];
}

/** Memoized per rendered scenario (one `load()` = one `RenderedScenario` instance), so
 * every capture path (routes.ts, facilitator.ts, ledger-endpoint.ts, solana-rpc.ts)
 * that calls this for the same loaded run gets the exact same, already-settled
 * promise - built once, from the same inputs, every time. */
const cache = new WeakMap<RenderedScenario, Promise<KnownTokenAccounts>>();

/**
 * Builds (once per loaded run) the svm-only `DecodeHints.knownTokenAccounts` map every
 * capture path must pass identically (U21 code review: a hint-less path's unresolved,
 * $0 copy of the same `dedupe_key` can otherwise win `merge()` over a hinted path's
 * correctly-resolved one, depending purely on arrival order). `owners` is the agent's
 * own deterministic wallet (`agentWallet`, so its ATAs resolve a plain SPL `Transfer`'s
 * *source*) plus every `RenderedScenario.knownOwners` address (payTo/canaries, so the
 * *destination* side resolves too) - per `record.ts`'s `buildKnownTokenAccounts` doc.
 * EVM runs never attempt PDA derivation (resolves to `{}` synchronously).
 */
export function knownTokenAccountsFor(
  rendered: RenderedScenario,
  chain: Chain,
  seed: string,
  scenarioAssets: AssetSpec[] | undefined,
): Promise<KnownTokenAccounts> {
  if (chain !== "svm") return Promise.resolve({});
  const cached = cache.get(rendered);
  if (cached) return cached;
  const owners = [...rendered.knownOwners, agentWallet(seed, chain).address];
  const promise = buildKnownTokenAccounts(owners, knownSvmMints(rendered, scenarioAssets));
  cache.set(rendered, promise);
  return promise;
}
