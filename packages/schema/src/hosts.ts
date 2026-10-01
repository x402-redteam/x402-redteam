import { z } from "zod";

/**
 * v3 (ADR-012 realistic hostnames, Bolt 6). `path` is today's `/_host/<name>` scheme,
 * kept as the canonical default through U15/Phase A so `report.json` stays byte-compatible
 * (functional-design.md §3's "key rule"); U17 flips the CLI default to `localhost` once
 * Host-header routing lands (`packages/adversary/src/hosts.ts`).
 */
export const HostModeSchema = z.enum(["localhost", "path", "proxy"]);
export type HostMode = z.infer<typeof HostModeSchema>;

/**
 * The harness's own default virtual host (`RouteSchema.host`'s default, code review
 * item 2/7) - shared here so every caller that needs to special-case "the provider
 * host" (the `{{base_url}}` = provider-host-URL mapping in `render.ts`/`task.ts`, and
 * `adversary/src/hosts.ts`'s request-resolution fallback) uses the same literal.
 */
export const DEFAULT_HOST = "provider.test";

/**
 * Renders a virtual host `name` to the URL a client should actually request, for one
 * `(mode, baseUrl)` pair. The *only* place a virtual host's URL is built (ADR-012) - the
 * adversary's own outgoing links (`render.ts`) and the CLI's `task.json` both call this
 * instead of hand-rolling `/_host/` or `.localhost` strings.
 *
 * - `path`: `${baseUrl}/_host/${name}` - identical to the pre-v3 behaviour.
 * - `localhost`: `http://${name}.localhost:<port>` - the full scenario hostname is kept
 *   (dots and all), so names never collide and a one-character lookalike survives.
 *   `baseUrl`'s port is reused; `baseUrl` is otherwise ignored (the adversary always
 *   binds 127.0.0.1, which `*.localhost` resolves to).
 * - `proxy`: `http://${name}` - a bare origin; the agent is expected to have
 *   `HTTP_PROXY` set so an absolute-form request still reaches the adversary.
 */
export function hostUrl(mode: HostMode, baseUrl: string, name: string): string {
  switch (mode) {
    case "path":
      return `${baseUrl}/_host/${name}`;
    case "localhost": {
      const port = new URL(baseUrl).port;
      return `http://${name}.localhost${port ? `:${port}` : ""}`;
    }
    case "proxy":
      return `http://${name}`;
  }
}

/**
 * Renders a virtual host `name` to the bare hostname a guardrail's `allowed_hosts` check
 * should compare against - what `new URL(requestedUrl).hostname` will actually be once a
 * request built from `hostUrl(mode, baseUrl, name)` is sent.
 *
 * - `path`: `name` unchanged (except lowercased) - `allowed_hosts` keeps today's values
 *   exactly for the all-lowercase hostnames this corpus already uses (no path-mode
 *   request's hostname ever includes `/_host/...`, that's in the path, not the host).
 * - `localhost`: `${name}.localhost`, lowercased.
 * - `proxy`: `name` unchanged (except lowercased) - a proxy-mode request's hostname is
 *   the bare scenario name.
 *
 * Code review item 7: lowercased in every mode - DNS hostnames are case-insensitive, so
 * a guardrail's `new URL(requestedUrl).hostname` (always lowercase, per the URL spec)
 * must compare against an already-lowercase `allowed_hosts` entry. `hostUrl` itself is
 * NOT lowercased (it also builds the `path`-mode *request path*, which `routes.ts`
 * matches byte-for-byte against the corpus's own, possibly mixed-case, `route.host` -
 * lowercasing there risks a path-mode routing mismatch that doesn't exist today).
 */
export function hostName(mode: HostMode, name: string): string {
  const lower = name.toLowerCase();
  switch (mode) {
    case "path":
    case "proxy":
      return lower;
    case "localhost":
      return `${lower}.localhost`;
  }
}
