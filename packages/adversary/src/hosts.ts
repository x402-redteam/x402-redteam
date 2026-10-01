import { DEFAULT_HOST, type HostMode } from "@x402-redteam/schema";
import type { Context } from "hono";

const HOST_PREFIX = "/_host/";

/** Host headers that mean "no virtual host named" - the harness's own loopback address,
 * under any of its usual spellings, with or without brackets (IPv6). Falls back to
 * `/_host/` path parsing, then to the default host (ADR-012 §2: "A bare 127.0.0.1 or
 * localhost Host falls back to /_host/ parsing, then to the default host"). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Strips a trailing `:<port>` from a `Host` header value, IPv6-literal-aware (an IPv6
 * literal's own colons must not be mistaken for a port separator - `[::1]:1234` -> `[::1]`). */
function stripPort(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const idx = hostHeader.lastIndexOf(":");
  return idx === -1 ? hostHeader : hostHeader.slice(0, idx);
}

function resolvePathFallback(c: Context): { host: string; path: string } {
  const pathname = new URL(c.req.url).pathname;
  if (pathname.startsWith(HOST_PREFIX)) {
    const rest = pathname.slice(HOST_PREFIX.length);
    const slash = rest.indexOf("/");
    return slash === -1
      ? { host: rest, path: "" }
      : { host: rest.slice(0, slash), path: rest.slice(slash) };
  }
  return { host: DEFAULT_HOST, path: pathname };
}

/**
 * Resolves an incoming request's (host, path), per functional-design.md §3 and
 * ADR-012 (full) §2/§4.
 *
 * - `path` mode: unchanged from U15/Bolt 6 Phase A - the URL's own path
 *   (`/_host/<host>/<rest>`, falling back to the default host) decides the virtual host;
 *   the `Host` header is never consulted.
 * - `localhost`/`proxy` mode: the `Host` header decides. Its port is stripped, then:
 *   - a bare loopback host (`127.0.0.1`, `localhost`, `::1`/`[::1]`, with or without a
 *     port) falls back to `/_host/` path parsing (so a client that dials the adversary
 *     directly rather than through its rendered `*.localhost`/proxy hostname still gets
 *     routed, e.g. the harness's own facilitator/RPC calls reaching this same `app` via
 *     the forward proxy in `proxy` mode);
 *   - otherwise, in `localhost` mode the trailing `.localhost` suffix is stripped to
 *     recover the scenario's own host name; in `proxy` mode the bare header value *is*
 *     the scenario's own host name (`hostUrl`'s proxy case never adds a suffix).
 *   Every non-fallback result is lowercased (DNS hostnames are case-insensitive, and
 *   corpus/rendered host names are already lowercase - mirrors `hostName()`'s own
 *   lowercasing in `@x402-redteam/schema`).
 */
export function resolveHost(c: Context, hostMode: HostMode): { host: string; path: string } {
  if (hostMode === "path") {
    return resolvePathFallback(c);
  }

  const headerHost = c.req.header("host") ?? "";
  const withoutPort = stripPort(headerHost).toLowerCase();

  if (withoutPort === "" || LOOPBACK_HOSTS.has(withoutPort)) {
    return resolvePathFallback(c);
  }

  const name =
    hostMode === "localhost" && withoutPort.endsWith(".localhost")
      ? withoutPort.slice(0, -".localhost".length)
      : withoutPort;

  return { host: name, path: new URL(c.req.url).pathname };
}
