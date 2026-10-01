import type { HostMode } from "@x402-redteam/schema";

/**
 * v3 stub (ADR-012 realistic hostnames; owner U17). Until U17 lands the `*.localhost`
 * preflight probe (`x402rt-probe.localhost` resolve + loopback GET) and the forward
 * proxy, this always returns `mode` unchanged - no fallback-to-`path` detection yet.
 *
 * Code review item 4 (U17 seam): async/`Promise`-returning from the start, so U17's real
 * DNS-resolve-plus-loopback-GET probe is a drop-in replacement with no call-site change
 * beyond the `await` `run.ts` already has. Main.ts currently rejects every `--host-mode`
 * other than `path` before this is ever called with one (code review item 6), so in
 * practice this only ever runs with `mode: "path"` today.
 */
export async function preflightHostMode(mode: HostMode): Promise<HostMode> {
  return mode;
}

/**
 * v3 stub (ADR-012; owner U17): the `proxy`-mode env vars (`HTTP_PROXY`, `http_proxy`,
 * `NO_PROXY=""`, `NODE_USE_ENV_PROXY=1`) land with the real forward-proxy server in U17.
 * Until then this never adds anything, for any mode - `run.ts` already resolves and
 * passes `proxyUrl` (code review item 4: `adversary.proxyUrl` once U17 adds a forward
 * proxy, else `task.base_url`), so U17 only needs to fill in this function's body.
 */
export function hostEnv(_mode: HostMode, _proxyUrl?: string): NodeJS.ProcessEnv {
  return {};
}
