import { DEFAULT_HOST, type HostMode } from "@x402-redteam/schema";
import type { Context } from "hono";

const HOST_PREFIX = "/_host/";

/**
 * Resolves an incoming request's (host, path), per functional-design.md §3. Extracted
 * verbatim from `routes.ts`'s former `resolveHostPath` (U15, Bolt 6 Phase A) into its own
 * file so Host-header routing (ADR-012, U17) has one place to extend: today this only
 * ever looks at the URL's own path (`/_host/<host>/<rest>`, falling back to the default
 * host), taking the Hono `Context` rather than a bare pathname so U17 can read
 * `c.req.header("host")` here without changing this function's call site in `routes.ts`.
 *
 * Code review item 4 (U17 seam): `hostMode` is accepted (the loaded run's
 * `RenderedScenario.host_mode`) but unused today - `routes.ts` always calls this with it,
 * so U17 can switch on `hostMode === "localhost"` here (Host-header routing) without
 * changing `routes.ts` at all.
 */
export function resolveHost(c: Context, _hostMode: HostMode): { host: string; path: string } {
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
