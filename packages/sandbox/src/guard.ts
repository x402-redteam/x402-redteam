/**
 * Socket-level egress guard (ADR-029 layer 2, U35). One implementation for every third-party
 * adapter: the adapter's own `src/guard.ts` is a few lines of configuration, preloaded with
 * `node --import <tsx> --import <that file>`, before any third-party code, and calls
 * `installGuard`.
 *
 * Only loopback, `*.localhost` and the hosts the task declares pass, and only on the allowed
 * ports: the harness's (from the task's base_url) plus the adapter's extra port (read from
 * `portEnv`), minus the refused ports. Every other loopback port is refused, on 127.0.0.1,
 * ::1 and `*.localhost` alike. The guard resolves allowed names to 127.0.0.1 itself, because
 * the OS sandbox also denies DNS. Configured stubs get a local 204 at the fetch layer.
 * Everything else is refused and logged to stderr as `EGRESS_BLOCKED <target>`.
 *
 * The guard is defence in depth: the OS sandbox (profile.ts) is the layer that denies the
 * syscall. The conformance canary proves each layer refuses on its own.
 */
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { allowedPorts, parsePort, portOfUrl } from "./ports.js";
import { makeTargetPolicy, type Stub, stubMatches } from "./target.js";
import { readTaskFrom, taskHostnames } from "./task.js";

export interface GuardConfig {
  /** Names the adapter in the rejection log line, for example "clawrouter". */
  label: string;
  /** Environment variable that carries the child's one extra port, if the adapter has one. */
  portEnv?: string;
  /** Ports the child may never reach. */
  refusedPorts?: number[];
  /** Requests answered locally with a 204. Checked before the allowed-target check. */
  stubs?: Stub[];
  /** An unhandled rejection this predicate accepts is ignored; any other exits 70. */
  ignoreRejection?: (reason: unknown) => boolean;
}

/** What the guard reports about the code it and its loader came from (C9). */
export interface GuardModules {
  /** Real path of this file. */
  guard: string;
  /** Real paths of every `--import` the child was started with, in order. */
  imports: string[];
}

export interface GuardHandle {
  /** The allowed ports, for the canary. */
  allowedPorts(): number[];
  isAllowedTarget(host: string | undefined | null, port: unknown): boolean;
  isAllowedHost(host: string | undefined | null): boolean;
  modules(): GuardModules;
}

const HANDLE_KEY = Symbol.for("x402-redteam.sandbox.guard");

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function computeModules(): GuardModules {
  const imports: string[] = [];
  const args = process.execArgv;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value =
      arg === "--import" ? args[++i] : arg?.startsWith("--import=") ? arg.slice(9) : undefined;
    if (value === undefined) continue;
    imports.push(realOrSelf(value.startsWith("file:") ? fileURLToPath(value) : value));
  }
  return { guard: realOrSelf(fileURLToPath(import.meta.url)), imports };
}

/** The child's answer to the `__modules` action; undefined when no guard is installed. */
export function guardModules(): GuardModules | undefined {
  const handle = (globalThis as Record<symbol, GuardHandle | undefined>)[HANDLE_KEY];
  return handle?.modules();
}

/** The installed guard, if any. */
export function installedGuard(): GuardHandle | undefined {
  return (globalThis as Record<symbol, GuardHandle | undefined>)[HANDLE_KEY];
}

const LOOPBACK_V4 = "127.0.0.1";

export function installGuard(config: GuardConfig): GuardHandle {
  const existing = installedGuard();
  if (existing) return existing;

  const stubs = config.stubs ?? [];
  const extraPort = config.portEnv ? parsePort(process.env[config.portEnv]) : undefined;
  const portOptions = {
    extra: extraPort === undefined ? [] : [extraPort],
    refused: config.refusedPorts ?? [],
  };
  const { declaredHosts, allowedPortSet } = loadTask();

  function loadTask(): { declaredHosts: Set<string>; allowedPortSet: Set<number> } {
    const path = process.env.X402_REDTEAM_TASK;
    const none = {
      declaredHosts: new Set<string>(),
      allowedPortSet: new Set(allowedPorts(undefined, portOptions)),
    };
    if (!path) return none;
    try {
      const task = readTaskFrom(path);
      return {
        declaredHosts: taskHostnames(task),
        allowedPortSet: new Set(allowedPorts(task.base_url, portOptions)),
      };
    } catch {
      return none;
    }
  }

  const policy = makeTargetPolicy(declaredHosts, allowedPortSet);
  const { isAllowedHost, isAllowedTarget } = policy;

  /** The loopback address an allowed host maps to (an IP literal is kept as it is). */
  function loopbackFor(rawHost: string): { address: string; family: 4 | 6 } {
    const host = rawHost
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
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
    if (!isAllowedTarget(options.host, options.port)) {
      const err = block(`tcp:${options.host ?? "localhost"}:${options.port}`);
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
    const port =
      typeof first === "object" && first !== null ? (first as ConnectOptions).port : first;
    if (!isAllowedTarget(host, port)) throw block(`tls:${host ?? "localhost"}:${port}`);
    return (originalTlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args);
  } as typeof tls.connect;

  // --- dgram ---------------------------------------------------------------------------

  const originalDgramSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function guardedSend(this: dgram.Socket, ...args: unknown[]) {
    const at = args.findIndex((a, i) => i > 0 && typeof a === "string");
    const address = at > 0 ? (args[at] as string) : undefined;
    const port = at > 0 ? args[at - 1] : undefined;
    if (address !== undefined && !isAllowedTarget(address, port))
      throw block(`udp:${address}:${port}`);
    return (originalDgramSend as (...a: unknown[]) => void).apply(this, args);
  } as typeof dgram.Socket.prototype.send;

  const originalDgramConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function guardedUdpConnect(
    this: dgram.Socket,
    ...args: unknown[]
  ) {
    const address = typeof args[1] === "string" ? args[1] : undefined;
    if (address !== undefined && !isAllowedTarget(address, args[0])) {
      throw block(`udp:${address}:${args[0]}`);
    }
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
    process.nextTick(() =>
      opts.all ? cb(null, [{ address, family }]) : cb(null, address, family),
    );
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
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
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
    if (stubMatches(stubs, url)) return new Response(null, { status: 204 });
    if (!isAllowedTarget(url.hostname, portOfUrl(url))) {
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
        if (!isAllowedTarget(url.hostname, portOfUrl(url))) throw block(`websocket:${url.origin}`);
        return Reflect.construct(target, args, newTarget);
      },
    });
  }

  syncBuiltinESMExports();

  // --- rejections ----------------------------------------------------------------------

  process.on("unhandledRejection", (reason) => {
    if (config.ignoreRejection?.(reason)) return;
    process.stderr.write(`${config.label} child: unhandled rejection: ${String(reason)}\n`);
    if (reason instanceof Error && reason.stack) process.stderr.write(`${reason.stack}\n`);
    process.exit(70);
  });

  const handle: GuardHandle = {
    allowedPorts: () => policy.ports(),
    isAllowedTarget,
    isAllowedHost,
    modules: computeModules,
  };
  (globalThis as Record<symbol, GuardHandle>)[HANDLE_KEY] = handle;
  return handle;
}
