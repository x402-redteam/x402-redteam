/**
 * Socket-level egress guard for the AgentKit child (U25 §3.1 layer 2, §3.5.2, ADR-029).
 * Preloaded with `node --import <tsx> --import ./guard.ts`, before any third-party code.
 *
 * Only loopback, `*.localhost` and the hosts the task declares pass. The guard resolves
 * those names to 127.0.0.1 itself, because the OS sandbox also denies DNS. AgentKit's
 * analytics endpoint gets a local 204 at the fetch layer. Everything else is refused and
 * logged to stderr as `EGRESS_BLOCKED <target>`.
 *
 * The guard is defence in depth: the OS sandbox (sandbox.ts) is the layer that denies the
 * syscall. The canary test (test/canary.test.ts) proves each layer refuses on its own.
 */
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { readTaskFrom, taskHostnames } from "./task.js";

export const ANALYTICS_ORIGIN = "https://cca-lite.coinbase.com";
const LOOPBACK_V4 = "127.0.0.1";

const declaredHosts = loadDeclaredHosts();

function loadDeclaredHosts(): Set<string> {
  const path = process.env.X402_REDTEAM_TASK;
  if (!path) return new Set();
  try {
    return taskHostnames(readTaskFrom(path));
  } catch {
    return new Set();
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** The same two addresses the sandbox profile's "localhost" allows. */
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

/** True when a connection to `host` may proceed. An empty host means localhost. An IP
 * literal passes only when it is loopback, even if the task declares another. */
export function isAllowedHost(rawHost: string | undefined | null): boolean {
  if (rawHost === undefined || rawHost === null || rawHost === "") return true;
  const host = normalizeHost(rawHost);
  if (net.isIP(host) !== 0) return LOOPBACK_IPS.has(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return declaredHosts.has(host);
}

/** The loopback address an allowed host maps to (an IP literal is kept as it is). */
function loopbackFor(rawHost: string): { address: string; family: 4 | 6 } {
  const host = normalizeHost(rawHost);
  const version = net.isIP(host);
  if (version === 6) return { address: host, family: 6 };
  if (version === 4) return { address: host, family: 4 };
  return { address: LOOPBACK_V4, family: 4 };
}

function block(target: string): Error & { code: string } {
  process.stderr.write(`EGRESS_BLOCKED ${target}\n`);
  return Object.assign(new Error(`EGRESS_BLOCKED ${target}`), { code: "EGRESS_BLOCKED" });
}

// --- net / tls -----------------------------------------------------------------------

type ConnectOptions = { host?: string; port?: number | string; path?: string | null };

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(
  this: net.Socket,
  ...args: unknown[]
): net.Socket {
  // net.connect() hands Socket#connect an already-normalized [options, cb] array.
  const normalized = Array.isArray(args[0]) ? (args[0] as unknown[]) : undefined;
  let options: ConnectOptions;
  if (normalized) options = (normalized[0] ?? {}) as ConnectOptions;
  else if (typeof args[0] === "object" && args[0] !== null) options = args[0] as ConnectOptions;
  else if (typeof args[0] === "string" && Number.isNaN(Number(args[0])))
    options = { path: args[0] };
  else
    options = {
      port: args[0] as number,
      host: typeof args[1] === "string" ? args[1] : undefined,
    };

  // Same test as net itself: a truthy path means a unix socket or pipe (http sets null).
  if (options.path) {
    const err = block(`unix:${options.path}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  if (!isAllowedHost(options.host)) {
    const err = block(`tcp:${options.host}:${options.port}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  if (options.host) {
    const rewritten = { ...options, host: loopbackFor(options.host).address };
    if (normalized) normalized[0] = rewritten;
    else if (typeof args[0] === "object") args[0] = rewritten;
    else args[1] = rewritten.host;
  }
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const originalTlsConnect = tls.connect;
tls.connect = function guardedTlsConnect(...args: unknown[]): tls.TLSSocket {
  const first = args[0];
  const host =
    typeof first === "object" && first !== null
      ? (first as ConnectOptions).host
      : typeof args[1] === "string"
        ? args[1]
        : undefined;
  if (!isAllowedHost(host)) throw block(`tls:${host}`);
  return (originalTlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args);
} as typeof tls.connect;

// --- dgram ---------------------------------------------------------------------------

const originalDgramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function guardedSend(this: dgram.Socket, ...args: unknown[]) {
  const address = args.find((a, i) => i > 0 && typeof a === "string") as string | undefined;
  if (address !== undefined && !isAllowedHost(address)) throw block(`udp:${address}`);
  return (originalDgramSend as (...a: unknown[]) => void).apply(this, args);
} as typeof dgram.Socket.prototype.send;

const originalDgramConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function guardedUdpConnect(
  this: dgram.Socket,
  ...args: unknown[]
) {
  const address = typeof args[1] === "string" ? args[1] : undefined;
  if (address !== undefined && !isAllowedHost(address)) throw block(`udp:${address}`);
  return (originalDgramConnect as (...a: unknown[]) => void).apply(this, args);
} as typeof dgram.Socket.prototype.connect;

// --- dns -----------------------------------------------------------------------------

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void;

function dnsError(hostname: string): Error {
  const err = block(`dns:${hostname}`);
  return Object.assign(err, { code: "ENOTFOUND", hostname, syscall: "getaddrinfo" });
}

function guardedLookup(hostname: string, options: unknown, callback?: unknown): void {
  const cb = (typeof options === "function" ? options : callback) as LookupCallback;
  const opts = (typeof options === "object" && options !== null ? options : {}) as {
    all?: boolean;
  };
  if (!isAllowedHost(hostname)) {
    const err = dnsError(hostname);
    process.nextTick(() => cb(err));
    return;
  }
  const { address, family } = loopbackFor(hostname || "localhost");
  process.nextTick(() => (opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)));
}

async function guardedLookupPromise(hostname: string, options?: unknown): Promise<unknown> {
  const opts = (typeof options === "object" && options !== null ? options : {}) as {
    all?: boolean;
  };
  if (!isAllowedHost(hostname)) throw dnsError(hostname);
  const result = loopbackFor(hostname || "localhost");
  return opts.all ? [result] : result;
}

/** resolve*() and reverse() go straight to c-ares (UDP); no task needs them. */
function refuseResolver(name: string) {
  return (hostname: unknown, ...rest: unknown[]): void => {
    const cb = rest.find((a) => typeof a === "function") as LookupCallback | undefined;
    const err = dnsError(`${name}:${String(hostname)}`);
    if (cb) process.nextTick(() => cb(err));
    else throw err;
  };
}

function refuseResolverPromise(name: string) {
  return async (hostname: unknown): Promise<never> => {
    throw dnsError(`${name}:${String(hostname)}`);
  };
}

const RESOLVER_METHODS = Object.keys(dns).filter(
  (k) => (k.startsWith("resolve") || k === "reverse") && typeof (dns as never)[k] === "function",
);

const dnsMutable = dns as unknown as Record<string, unknown>;
dnsMutable.lookup = guardedLookup;
for (const m of RESOLVER_METHODS) dnsMutable[m] = refuseResolver(m);
const dnsPromises = dns.promises as unknown as Record<string, unknown>;
dnsPromises.lookup = guardedLookupPromise;
for (const m of RESOLVER_METHODS) {
  if (typeof dnsPromises[m] === "function") dnsPromises[m] = refuseResolverPromise(m);
}
for (const proto of [
  dns.Resolver.prototype,
  (dns.promises.Resolver as unknown as { prototype: object }).prototype,
]) {
  const p = proto as Record<string, unknown>;
  for (const m of RESOLVER_METHODS) {
    if (typeof p[m] === "function") p[m] = refuseResolver(m);
  }
}

// --- child_process -------------------------------------------------------------------

const cpMutable = childProcess as unknown as Record<string, unknown>;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  cpMutable[name] = (file: unknown) => {
    throw block(`child_process:${name}:${String(file)}`);
  };
}

// --- fetch / WebSocket ---------------------------------------------------------------

function urlOf(input: unknown): URL {
  if (input instanceof URL) return input;
  if (typeof input === "object" && input !== null && "url" in input) {
    return new URL(String((input as { url: string }).url));
  }
  return new URL(String(input));
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = urlOf(input);
  if (url.origin === ANALYTICS_ORIGIN) return new Response(null, { status: 204 });
  if (!isAllowedHost(url.hostname)) {
    throw new TypeError(`fetch failed: ${block(`fetch:${url.origin}`).message}`);
  }
  try {
    return await originalFetch(input, init);
  } catch (err) {
    // A redirect to a non-task host is refused at the socket layer, inside undici; put
    // the refusal into the message, since callers often keep only the message.
    const cause = err instanceof Error ? (err.cause as { code?: string; message?: string }) : {};
    if (cause?.code === "EGRESS_BLOCKED") {
      throw new TypeError(`fetch failed: ${cause.message}`, { cause });
    }
    throw err;
  }
} as typeof fetch;

const OriginalWebSocket = globalThis.WebSocket;
if (OriginalWebSocket) {
  globalThis.WebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args, newTarget) {
      const url = urlOf(args[0]);
      if (!isAllowedHost(url.hostname)) throw block(`websocket:${url.origin}`);
      return Reflect.construct(target, args, newTarget);
    },
  });
}

syncBuiltinESMExports();

// --- rejections (M7) -----------------------------------------------------------------

/** Only AgentKit's fire-and-forget analytics call may reject unobserved. */
export function isAnalyticsRejection(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const text = `${reason.message}\n${reason.stack ?? ""}`;
  return text.includes("sendAnalyticsEvent") || text.includes(new URL(ANALYTICS_ORIGIN).host);
}

process.on("unhandledRejection", (reason) => {
  if (isAnalyticsRejection(reason)) return;
  process.stderr.write(`agentkit child: unhandled rejection: ${String(reason)}\n`);
  if (reason instanceof Error && reason.stack) process.stderr.write(`${reason.stack}\n`);
  process.exit(70);
});
