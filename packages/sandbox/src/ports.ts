/**
 * The loopback port allowlist (U28 section 3, U33 section 3.1, U35 D13). Loopback is not a
 * trust boundary for a third-party client, so the child may reach only the harness's own port
 * (from `task.base_url`) plus the extra ports an adapter assigns it. Both isolation layers
 * build their allowlist from this one function and from nothing else.
 */

/** The port of a URL, with the scheme's default when none is written. */
export function portOfUrl(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
}

/** The harness port, from `task.base_url`; undefined when the URL is unusable. */
export function harnessPort(baseUrl: string | undefined): number | undefined {
  if (!baseUrl) return undefined;
  try {
    const port = portOfUrl(new URL(baseUrl));
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

export interface PortOptions {
  /** Ports the adapter assigned to the child (for example a proxy port). */
  extra?: number[];
  /** Ports the child may never reach (for example a payer's default port). */
  refused?: number[];
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The only ports a child may connect to: the harness port and the extras. A harness port that
 * is refused is dropped (the child then reaches nothing there). An extra that is refused or is
 * not a port is an error, never a silent drop.
 */
export function allowedPorts(baseUrl: string | undefined, opts: PortOptions = {}): number[] {
  const refused = new Set(opts.refused ?? []);
  const ports = new Set<number>();
  const harness = harnessPort(baseUrl);
  if (harness !== undefined && !refused.has(harness)) ports.add(harness);
  for (const port of opts.extra ?? []) {
    if (!validPort(port)) throw new Error(`extra port ${port} is not a valid port`);
    if (refused.has(port)) throw new Error(`extra port ${port} is a refused port`);
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Parses a port written in an environment variable; undefined unless 1-65535. */
export function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return validPort(port) ? port : undefined;
}
