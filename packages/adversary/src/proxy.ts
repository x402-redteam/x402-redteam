import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RequestLog } from "@x402-redteam/schema";
import type { Hono } from "hono";
import type { Shared } from "./shared.js";

/** Host header values that always reach this same `app` regardless of which scenario is
 * loaded - the harness's own endpoints (`/facilitator`, `/solana-rpc`, `/evm-rpc`,
 * `/__harness/ledger`) stay on `task.base_url` (ADR-012 §4/functional-design.md §3) even
 * in `proxy` mode, and `NO_PROXY=""` means the agent's own client sends *every* outgoing
 * request - including those to `task.base_url` itself - in absolute form through this
 * proxy. Without allow-listing the harness's own loopback address, those calls would be
 * misidentified as a leak attempt and rejected with 502. */
const HARNESS_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function logLeak(shared: Shared, method: string, host: string, path: string): void {
  const loaded = shared.holder.current;
  if (!loaded) return;
  const entry: Omit<RequestLog, "seq"> = { method, host, path, status: 502, paid: false };
  loaded.state.requests.push({ ...entry, seq: loaded.state.nextSeq() });
}

/** Every host this proxy will forward to for the currently loaded run - every scenario
 * route's own host (which already defaults to `provider.test`, schema-side), every host
 * the scenario's own `task.allowed_hosts` names (code review F6: a host that's declared
 * allowed but has no route of its own in this variant still reaches `findRoute`'s own
 * 404 in `localhost` mode - `proxy` mode must log the same 404, not a 502 "leak attempt",
 * for the identical input), plus the harness's own loopback address. */
function allowedHosts(shared: Shared): Set<string> {
  const hosts = new Set(HARNESS_HOSTS);
  const loaded = shared.holder.current;
  if (loaded) {
    for (const route of loaded.rendered.routes) hosts.add(route.host.toLowerCase());
    for (const name of loaded.state.scenario.task.allowed_hosts ?? []) {
      hosts.add(name.toLowerCase());
    }
  }
  return hosts;
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

function writeError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(message);
}

/**
 * Handles one forward-proxy request, per ADR-012 (full) §4 / functional-design.md §2:
 * an absolute-form request target (`GET http://provider.test/x HTTP/1.1`, which Node's
 * `http` server surfaces as `req.url === "http://provider.test/x"`) is rewritten into a
 * same-origin request against the *same* Hono `app` instance, with its `Host` header set
 * to the target's own host - so `hosts.ts`'s `resolveHost` routes it exactly as it would
 * a direct `localhost`-mode request. A target host outside the currently loaded
 * scenario (and outside the harness's own loopback address) gets 502 and is logged, per
 * functional-design.md §3 ("not scored").
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  app: Hono,
  shared: Shared,
): Promise<void> {
  const rawUrl = req.url ?? "";
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    writeError(res, 400, "proxy: absolute-form request target required");
    return;
  }

  const hostname = target.hostname.toLowerCase();
  if (!allowedHosts(shared).has(hostname)) {
    logLeak(shared, req.method ?? "GET", hostname, target.pathname);
    writeError(res, 502, `proxy: host "${hostname}" is not reachable from this harness`);
    return;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key.toLowerCase() === "host") continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, value);
    }
  }
  headers.set("host", target.port ? `${hostname}:${target.port}` : hostname);

  const body = await readBody(req);
  const method = req.method ?? "GET";
  const forwarded = new Request(`http://${headers.get("host")}${target.pathname}${target.search}`, {
    method,
    headers,
    body,
    duplex: body !== undefined ? "half" : undefined,
  });

  const response = await app.fetch(forwarded);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  res.writeHead(response.status, responseHeaders);
  if (response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } else {
    res.end();
  }
}

/** Builds (but does not start) the forward-proxy server, per ADR-012 (full) §4: plain
 * HTTP only (no CA, ever - `CONNECT` is the HTTPS tunnel setup method and always gets a
 * flat 405, per functional-design.md §4 "do not implement HTTPS or CONNECT
 * interception"). Serves the *same* `app`/`shared` the main adversary server does, so
 * scoring is unaffected by which port a request arrived on. */
export function createForwardProxy(app: Hono, shared: Shared): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res, app, shared).catch((err: unknown) => {
      if (!res.headersSent) {
        writeError(res, 502, `proxy error: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        res.destroy();
      }
    });
  });
  server.on("connect", (_req, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}

/** Starts the forward proxy on `hostname` (an ephemeral port) and resolves once it's
 * listening. */
export function startForwardProxy(
  app: Hono,
  shared: Shared,
  hostname: string,
): Promise<{ server: Server; port: number }> {
  const server = createForwardProxy(app, shared);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      if (port === undefined) {
        reject(new Error("forward proxy has no port after listen()"));
        return;
      }
      resolve({ server, port });
    });
  });
}
