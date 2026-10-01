/**
 * Shared, mode-aware host/path extraction for a payment's requested URL - factored out
 * of `guarded.ts` (U17 code review F3) so `obedient.ts`'s own minimal guardrail uses the
 * exact same logic instead of its own, `localhost`-mode-unaware copy.
 *
 * - `localhost`/`proxy` mode (ADR-012 full, canonical): the generic
 *   `new URL(requested).hostname` check - exactly what a guardrail with no knowledge of
 *   this harness at all would write - compared against `task.allowed_hosts` (already
 *   rendered to match, e.g. `"provider.test.localhost"`).
 * - `path` mode: the pre-ADR-012 `/_host/<name>/<rest>` convention. Kept as a dedicated
 *   branch (not deleted, despite the functional design's literal wording) because other
 *   units' e2e suites call `runSuite` directly with the harness's internal `path`
 *   default (only the CLI's own `--host-mode` flag default flipped), and this unit's own
 *   required path-mode smoke needs `guarded`/`obedient` to still pass their controls -
 *   `new URL(pathModeUrl).hostname` is always `"127.0.0.1"` and can never match a
 *   rendered `allowed_hosts` entry. `examples/agents/src/hostname-allowlist.ts` is the
 *   literal, mode-naive version of this check - its whole purpose is to prove `path`
 *   mode fails it (ADR-012's M1 validity proof).
 */
import type { TaskFile } from "./wallet.js";

export interface HostPath {
  host: string;
  path: string;
}

const HOST_PREFIX = "/_host/";
const DEFAULT_HOST = "provider.test";

/** `path`-mode-only: the pre-ADR-012 `/_host/<name>/<rest>` convention. */
function parsePathModeHostPath(url: string, baseUrl: string): HostPath {
  const rest = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
  const [pathname] = rest.split("?");
  if (pathname?.startsWith(HOST_PREFIX)) {
    const trimmed = pathname.slice(HOST_PREFIX.length);
    const slash = trimmed.indexOf("/");
    return slash === -1
      ? { host: trimmed, path: "" }
      : { host: trimmed.slice(0, slash), path: trimmed.slice(slash) };
  }
  return { host: DEFAULT_HOST, path: pathname ?? rest };
}

export function parseHostPath(
  url: string,
  task: Pick<TaskFile, "host_mode" | "base_url">,
): HostPath {
  if ((task.host_mode ?? "path") === "path") {
    return parsePathModeHostPath(url, task.base_url);
  }
  // ADR-012 (full): localhost/proxy mode - the generic check. `task.allowed_hosts` is
  // already rendered to match (`hostName()` in the harness - lowercase, mode-appropriate).
  const parsed = new URL(url);
  return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
}
