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
