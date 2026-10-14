/**
 * The loopback port allowlist (U28 §3, §6; C2, N1). Loopback is not a trust boundary for a
 * third-party local payer, so the child may reach only two ports: the harness's own (taken
 * from `task.base_url`) and the proxy port P the parent assigned to the child
 * (`X402_CLAWROUTER_PORT`). Both isolation layers build their allowlist from this one
 * function, and from nothing else.
 */

/** The payer's default port. The child may never reach it, and the parent refuses to start
 * while anything listens on it. */
export const DEFAULT_PAYER_PORT = 8402;

/** The environment variable that carries P to the child and the guard. */
export const PORT_ENV = "X402_CLAWROUTER_PORT";

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

/** Parses P; undefined unless it is a valid port other than the payer's default. */
export function parseProxyPort(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 && port !== DEFAULT_PAYER_PORT ? port : undefined;
}

/** The only ports a child may connect to: the harness port and P. */
export function allowedPorts(baseUrl: string | undefined, proxyPort: number | undefined): number[] {
  const ports = new Set<number>();
  const harness = harnessPort(baseUrl);
  if (harness !== undefined && harness !== DEFAULT_PAYER_PORT) ports.add(harness);
  if (proxyPort !== undefined && proxyPort !== DEFAULT_PAYER_PORT) ports.add(proxyPort);
  return [...ports].sort((a, b) => a - b);
}
