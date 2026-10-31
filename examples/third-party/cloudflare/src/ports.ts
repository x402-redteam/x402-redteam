/**
 * The loopback port allowlist (U33 §3.1, ADR-029 3a; m1). Loopback is not a trust boundary
 * for a third-party client, so the child may reach exactly one port: the harness's own,
 * taken from `task.base_url`. The adapter starts no listener of its own and is assigned no
 * port. Both isolation layers build their allowlist from this one function and nothing else.
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

/** The only ports a child may connect to: the harness port, or none. */
export function allowedPorts(baseUrl: string | undefined): number[] {
  const harness = harnessPort(baseUrl);
  return harness === undefined ? [] : [harness];
}
