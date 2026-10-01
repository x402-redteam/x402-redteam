import { lookup } from "node:dns/promises";
import { createServer, get as httpGet } from "node:http";
import type { HostMode } from "@x402-redteam/schema";

const PROBE_HOST = "x402rt-probe.localhost";
const DNS_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * A throwaway loopback HTTP server plus one GET of `x402rt-probe.localhost`, per ADR-012
 * (full) §3: proves not just that the name resolves (the `dns.lookup` above already did
 * that) but that a real HTTP round trip through it actually reaches a 127.0.0.1-bound
 * server - exactly what the real adversary needs once this preflight passes.
 *
 * Code review F7: this uses `node:http.get` rather than global `fetch` *specifically* so
 * the probe is never diverted by an `HTTP_PROXY`/`http_proxy` the *user's own shell*
 * happens to have set (the CLI process's own ambient environment, unrelated to this
 * harness's own `--host-mode proxy`, which only ever sets that env for the spawned
 * *agent* subprocess - see `hostEnv` below) - `node:http` never consults proxy env vars
 * on its own, unlike a `fetch` built on a dispatcher that might.
 */
function probeLoopbackGet(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => res.end("ok"));
    const done = (err?: Error): void => {
      server.close();
      if (err) reject(err);
      else resolve();
    };
    server.on("error", (err) => done(err));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      if (port === undefined) {
        done(new Error("probe server has no port"));
        return;
      }
      const req = httpGet({ host: PROBE_HOST, port, path: "/" }, (res) => {
        res.resume();
        res.on("end", () => {
          done(
            res.statusCode !== undefined && res.statusCode < 400
              ? undefined
              : new Error(`probe GET returned ${res.statusCode}`),
          );
        });
        res.on("error", (err) => done(err));
      });
      req.on("error", (err) => done(err));
    });
  });
}

/**
 * Resolves the effective `host_mode` for this run, per ADR-012 (full) §3: in `localhost`
 * mode, the CLI first resolves `x402rt-probe.localhost` (a 2s-timeout `dns.lookup`) and
 * does a real loopback GET through it; if either fails (e.g. the platform doesn't wire up
 * `*.localhost`, or IPv6-vs-IPv4 resolution ordering breaks the round trip), it falls
 * back to `path` and warns loudly - the caller (`run.ts`) records whichever mode this
 * resolves to in `config.host_mode`, so a silent fallback is never hidden from the
 * report. `path` and `proxy` are returned unchanged - neither has a preflight check.
 */
export async function preflightHostMode(mode: HostMode): Promise<HostMode> {
  if (mode !== "localhost") return mode;

  try {
    await withTimeout(lookup(PROBE_HOST), DNS_TIMEOUT_MS, `dns.lookup("${PROBE_HOST}")`);
    await probeLoopbackGet();
    return mode;
  } catch (err) {
    console.error(
      `x402-redteam: --host-mode localhost preflight failed (${
        err instanceof Error ? err.message : String(err)
      }) - falling back to --host-mode path. This run's report.json will record "path".`,
    );
    return "path";
  }
}

/**
 * The agent subprocess's proxy-mode env, per ADR-012 (full) §4: `HTTP_PROXY`/`http_proxy`
 * point at the adversary's own forward-proxy origin, `NO_PROXY`/`no_proxy` are forced
 * empty (no exclusion - even the harness's own loopback endpoints go through the proxy,
 * so `proxy.ts`'s allow-list covers them), and `NODE_USE_ENV_PROXY=1` is set for Node
 * agents on a new-enough Node line (the harness's own fetch calls never read this -
 * see README "check your Node version"). Every other mode gets no extra env at all -
 * `path` and `localhost` mode agents reach every virtual host directly.
 */
export function hostEnv(mode: HostMode, proxyUrl?: string): NodeJS.ProcessEnv {
  if (mode !== "proxy" || proxyUrl === undefined) return {};
  return {
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
  };
}
