/**
 * The guard's pure decisions (U35 D8-D11): which hosts and ports may be dialled, and which
 * stub requests are answered locally. No side effects, so CI covers it on any platform.
 */
import net from "node:net";

export function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/** Only 127.0.0.1 may be dialled. The sandbox's "localhost" cannot tell it from ::1, so the
 * guard is the layer that refuses ::1 (U35 D9). */
export const LOOPBACK_IPS: ReadonlySet<string> = new Set(["127.0.0.1"]);

export interface TargetPolicy {
  isAllowedHost(rawHost: string | undefined | null): boolean;
  isAllowedPort(port: unknown): boolean;
  isAllowedTarget(host: string | undefined | null, port: unknown): boolean;
  /** The allowed ports, sorted. */
  ports(): number[];
}

/**
 * An empty host means localhost. An IP literal passes only when it is 127.0.0.1, even if the
 * task declares another. A missing port is refused.
 */
export function makeTargetPolicy(
  declaredHosts: ReadonlySet<string>,
  allowedPortSet: ReadonlySet<number>,
): TargetPolicy {
  const isAllowedHost = (rawHost: string | undefined | null): boolean => {
    if (rawHost === undefined || rawHost === null || rawHost === "") return true;
    const host = normalizeHost(rawHost);
    if (net.isIP(host) !== 0) return LOOPBACK_IPS.has(host);
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    return declaredHosts.has(host);
  };
  const isAllowedPort = (port: unknown): boolean => {
    if (port === undefined || port === null || port === "") return false;
    const n = Number(port);
    return Number.isInteger(n) && allowedPortSet.has(n);
  };
  return {
    isAllowedHost,
    isAllowedPort,
    isAllowedTarget: (host, port) => isAllowedHost(host) && isAllowedPort(port),
    ports: () => [...allowedPortSet].sort((a, b) => a - b),
  };
}

/** A request answered locally with a 204, never sent. */
export interface Stub {
  url: string;
  /** `origin`: any path on that origin; `path`: that exact origin and path. */
  match: "origin" | "path";
}

/** True when `url` is answered by a stub. Checked before the allowed-target check. */
export function stubMatches(stubs: readonly Stub[], url: URL): boolean {
  for (const stub of stubs) {
    let target: URL;
    try {
      target = new URL(stub.url);
    } catch {
      continue;
    }
    if (
      stub.match === "origin"
        ? url.origin === target.origin
        : url.origin + url.pathname === target.origin + target.pathname
    ) {
      return true;
    }
  }
  return false;
}
