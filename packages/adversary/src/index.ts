import type { Server } from "node:http";
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
import { startForwardProxy } from "./proxy.js";
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
  /** v3 (ADR-012): defaults to "path" - see `render.ts`'s `renderScenario`. "proxy" also
   * starts a forward-proxy listener (`proxy.ts`) and populates `Adversary.proxyUrl`. */
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
  /** v3 (ADR-012): the forward proxy's own origin, set only when `host_mode: "proxy"`
   * actually started one - `undefined` in every other mode, so `run.ts` falls back to
   * `task.base_url` for `hostEnv`'s `proxyUrl` argument. */
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

/** How many ephemeral-port pairs to try before giving up on dual-stack binding - see
 * `bindDualStack`. Each retry is just a fresh `listen(0, ...)`, so this is cheap. */
const MAX_DUAL_STACK_ATTEMPTS = 5;

function listenOnce(
  app: Hono,
  hostname: string,
  port: number,
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => {
      resolve({ server: srv, port: info.port });
    });
    srv.on("error", reject);
  });
}

type Ipv6Attempt = { server: ServerType } | { server?: undefined; retryablePortConflict: boolean };

/** Tries to bind `::1` on `port`. Resolves `{ server }` on success; otherwise
 * `{ retryablePortConflict: true }` specifically for `EADDRINUSE` (a real, unrelated
 * process already owns `::1` at this exact port - the caller must pick a different port
 * rather than silently proceeding IPv4-only *at that same port number*), or `{
 * retryablePortConflict: false }` for anything else (no IPv6 stack at all, disabled,
 * etc. - IPv4-only is the correct, intentional fallback, not a port conflict). */
function tryListenIpv6(app: Hono, port: number): Promise<Ipv6Attempt> {
  return new Promise((resolve) => {
    const srv = serve({ fetch: app.fetch, port, hostname: "::1" }, () => resolve({ server: srv }));
    srv.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ retryablePortConflict: err.code === "EADDRINUSE" });
    });
  });
}

/**
 * Binds `hostname` (an ephemeral port, unless `explicitPort` is given) and, when
 * `hostname` is the default `127.0.0.1`, also `::1` on that same port, per ADR-012
 * (full) §2: Python (and some other runtimes) may resolve a `*.localhost` name to `::1`
 * before `127.0.0.1`, so a client that happens to connect over IPv6 still needs to reach
 * this adversary. Two distinct local addresses can share one port number without
 * `SO_REUSEPORT` - each `(address, port)` pair is its own socket - so this is never
 * "sharing" a port in the sense that matters; what it never does is silently keep a port
 * whose `::1` side is already owned by some *other*, unrelated process (code review F5):
 * - no `explicitPort`: on `EADDRINUSE` for `::1`, the IPv4 side is closed and a fresh
 *   ephemeral port is tried, up to `MAX_DUAL_STACK_ATTEMPTS` times, until a port free on
 *   *both* addresses is found (or every attempt is exhausted, which throws).
 * - `explicitPort` given (tests only - `run.ts` never sets one): retrying would violate
 *   the caller's exact request, so `EADDRINUSE` on `::1` throws immediately instead.
 * - any other `::1` bind failure (no IPv6 stack, disabled, etc.) falls back to IPv4-only
 *   silently, exactly as before - that is not a port conflict, just this platform having
 *   no usable IPv6 loopback.
 */
async function bindDualStack(
  app: Hono,
  hostname: string,
  explicitPort: number | undefined,
): Promise<{ server: ServerType; port: number; ipv6Server?: ServerType }> {
  if (hostname !== "127.0.0.1") {
    const { server, port } = await listenOnce(app, hostname, explicitPort ?? 0);
    return { server, port };
  }

  if (explicitPort !== undefined) {
    const { server, port } = await listenOnce(app, hostname, explicitPort);
    const ipv6 = await tryListenIpv6(app, port);
    if (ipv6.server) return { server, port, ipv6Server: ipv6.server };
    if (ipv6.retryablePortConflict) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error(
        `createAdversary: port ${port} (explicitly requested) is already in use on ::1 by another process`,
      );
    }
    return { server, port };
  }

  for (let attempt = 1; attempt <= MAX_DUAL_STACK_ATTEMPTS; attempt++) {
    const ipv4 = await listenOnce(app, hostname, 0);
    const ipv6 = await tryListenIpv6(app, ipv4.port);
    if (ipv6.server) return { server: ipv4.server, port: ipv4.port, ipv6Server: ipv6.server };
    if (!ipv6.retryablePortConflict) return { server: ipv4.server, port: ipv4.port };
    // EADDRINUSE on ::1 at this exact port - never silently keep it; retry with a fresh pair.
    await new Promise<void>((resolve) => ipv4.server.close(() => resolve()));
  }
  throw new Error(
    `createAdversary: could not find a port free on both 127.0.0.1 and ::1 after ${MAX_DUAL_STACK_ATTEMPTS} attempts`,
  );
}

/**
 * Boots the adversary server, per functional-design.md §1 and application-design.md §5.
 * Binds to 127.0.0.1 (an ephemeral port when none is given) and, when the platform
 * allows it, also to `::1` on the same port (ADR-012 full, §2; see `bindDualStack`).
 * Never touches the network or the wall clock.
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

  const { server, port, ipv6Server } = await bindDualStack(app, hostname, opts.port);

  // ADR-012 (full) §4: the forward proxy is an entirely separate listener (absolute-form
  // request targets, not Host-header routing) sharing this same `app`/`shared`, so
  // scoring is identical regardless of which port a request arrived on.
  let proxyServer: Server | undefined;
  let proxyUrl: string | undefined;
  if (opts.hostMode === "proxy") {
    const proxy = await startForwardProxy(app, shared, hostname);
    proxyServer = proxy.server;
    proxyUrl = `http://${hostname}:${proxy.port}`;
  }

  const baseUrl = `http://${hostname}:${port}`;

  return {
    baseUrl,
    proxyUrl,
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
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
      if (ipv6Server) {
        await new Promise<void>((resolve) => ipv6Server.close(() => resolve()));
      }
      if (proxyServer) {
        await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      }
    },
  };
}

export type { RenderedRoute, RenderedScenario } from "./render.js";
export { RunState } from "./state.js";
