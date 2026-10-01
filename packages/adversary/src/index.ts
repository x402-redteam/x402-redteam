import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import type {
  CaptureApi,
  Chain,
  HostMode,
  IssuedChallenge,
  Payment,
  RequestLog,
  Scenario,
} from "@x402-redteam/schema";
import { Hono } from "hono";
import { registerEvmRpcRoutes } from "./evm-rpc.js";
import { registerFacilitatorRoutes } from "./facilitator.js";
import { registerLedgerRoutes } from "./ledger-endpoint.js";
import { renderScenario } from "./render.js";
import { registerScenarioRoutes } from "./routes.js";
import { RunHolder, type Shared } from "./shared.js";
import { registerSolanaRpcRoutes } from "./solana-rpc.js";
import { RunState } from "./state.js";

export interface CreateAdversaryOptions {
  seed: string;
  port?: number;
  capture: CaptureApi;
  host?: "127.0.0.1";
  /** v3 (ADR-012): defaults to "path" - see `render.ts`'s `renderScenario`. */
  hostMode?: HostMode;
}

export interface DrainedRun {
  run_id: string;
  scenario_id: string;
  chain: Chain;
  requests: RequestLog[];
  challenges: IssuedChallenge[];
  payments: Payment[];
  delivered: boolean;
}

export interface Adversary {
  baseUrl: string;
  /** v3 (ADR-012, code review item 4: U17 seam). The forward proxy's own origin, once
   * `host_mode: "proxy"` actually serves one (U17) - always `undefined` until then, so
   * `run.ts` falls back to `task.base_url` for `hostEnv`'s `proxyUrl` argument. */
  proxyUrl?: string;
  load(run: { scenario: Scenario; chain: Chain; run_id: string }): void;
  drain(): DrainedRun;
  /** Requests the loaded run has received so far (0 when nothing is loaded). */
  requestCount(): number;
  close(): Promise<void>;
}

function bySeq<T extends { seq: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}

/**
 * Boots the adversary server, per functional-design.md §1 and application-design.md §5.
 * Binds only to 127.0.0.1 (an ephemeral port when none is given) and never touches the
 * network or the wall clock.
 */
export async function createAdversary(opts: CreateAdversaryOptions): Promise<Adversary> {
  const app = new Hono();
  const holder = new RunHolder();
  const shared: Shared = { seed: opts.seed, capture: opts.capture, holder };
  const hostname = opts.host ?? "127.0.0.1";

  registerFacilitatorRoutes(app, shared);
  registerSolanaRpcRoutes(app, shared);
  registerEvmRpcRoutes(app, shared);
  registerLedgerRoutes(app, shared);
  registerScenarioRoutes(app, shared);

  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const srv = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname }, (info: AddressInfo) => {
      resolve({ server: srv, port: info.port });
    });
  });

  const baseUrl = `http://${hostname}:${port}`;

  return {
    baseUrl,
    load(run) {
      const state = new RunState(run.scenario, run.chain, run.run_id);
      const rendered = renderScenario(run.scenario, run.chain, baseUrl, opts.seed, opts.hostMode);
      holder.current = { state, rendered };
    },
    drain() {
      const loaded = holder.current;
      if (!loaded) {
        throw new Error("drain: no run loaded - call load() first");
      }
      const { state } = loaded;
      return {
        run_id: state.run_id,
        scenario_id: state.scenario.id,
        chain: state.chain,
        requests: bySeq(state.requests),
        challenges: bySeq(state.challenges),
        payments: bySeq(state.payments),
        delivered: state.delivered,
      };
    },
    requestCount() {
      return holder.current?.state.requests.length ?? 0;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export type { RenderedRoute, RenderedScenario } from "./render.js";
export { RunState } from "./state.js";
