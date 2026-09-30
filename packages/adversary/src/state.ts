import type { Chain, IssuedChallenge, Payment, RequestLog, Scenario } from "@x402-redteam/schema";

/** Per-route runtime bookkeeping that isn't part of the exported ledger shape. */
export interface RouteRuntime {
  /** Counter used to build `${route_key}#${n}` challenge ids; starts at 0, pre-incremented. */
  challengeCounter: number;
  /** True once this route has delivered its `delivered_body` at least once (used by `replay`). */
  deliveredOnce: boolean;
}

/**
 * All mutable state for one loaded run. `load()` replaces this wholesale;
 * nothing here is derived from wall-clock time, per functional-design.md §2/§5.
 */
export class RunState {
  scenario: Scenario;
  chain: Chain;
  run_id: string;
  private seq = 0;
  requests: RequestLog[] = [];
  challenges: IssuedChallenge[] = [];
  payments: Payment[] = [];
  pageBodies: string[] = [];
  delivered = false;
  private readonly routeRuntimes = new Map<string, RouteRuntime>();

  // v2 (ADR-013, mock chain RPC): per-run bookkeeping for the EVM and Solana mock RPCs,
  // per U10 functional-design.md §3/§4. Never derived from wall-clock time.
  /** Lowercased EVM address -> number of `eth_sendRawTransaction` calls accepted so far
   * this run (the next nonce `eth_getTransactionCount` should report for that address). */
  evmTxCountByAddress = new Map<string, number>();
  /** `evmtx:`-stripped tx hash -> the receipt fields `eth_getTransactionReceipt` /
   * `eth_getTransactionByHash` synthesize for a hash seen this run. */
  seenEvmTx = new Map<string, { from: string; to: string | null }>();
  /** Base58 Solana signatures accepted by `sendTransaction` this run, for
   * `getSignatureStatuses`. */
  seenSvmSigs = new Set<string>();

  constructor(scenario: Scenario, chain: Chain, run_id: string) {
    this.scenario = scenario;
    this.chain = chain;
    this.run_id = run_id;
  }

  /** Returns the next monotonic sequence number, shared across requests/challenges/payments. */
  nextSeq(): number {
    const seq = this.seq;
    this.seq += 1;
    return seq;
  }

  runtimeFor(routeKey: string): RouteRuntime {
    let runtime = this.routeRuntimes.get(routeKey);
    if (!runtime) {
      runtime = { challengeCounter: 0, deliveredOnce: false };
      this.routeRuntimes.set(routeKey, runtime);
    }
    return runtime;
  }
}
