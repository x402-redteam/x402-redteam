/**
 * Shared crawler for both reference agents, per application-design.md §8 /
 * U5 functional-design.md §5: pulls URLs out of a page (or the task prompt),
 * follows links up to depth 3, follows redirects manually, and caps the
 * whole crawl at 30 fetches.
 *
 * ADR-012 (full)/U17: a URL is only ever followed when its *origin* (scheme + host +
 * port, exact match) is one this scenario actually declared - `origin(task.base_url)`
 * (the harness's own endpoints, and every `path`-mode virtual host) union the origin of
 * every `task.hosts` value (every `localhost`/`proxy`-mode virtual host this scenario
 * names, including a look-alike host that's part of *this* scenario, which a correct
 * guardrail - not the crawler - is responsible for refusing to pay). Code review F1
 * (HIGH, egress): an earlier version matched any `*.localhost`-*suffixed* origin by
 * regex, which `http://a.localhost.evil.com/x` or `http://x.localhost-evil.com/y` both
 * satisfy as a *string suffix/prefix* while being a completely different, real-DNS
 * origin - exact-origin-set membership (`new URL(u).origin`, not a regex against the
 * raw string) can't be fooled that way.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CrawledPage {
  url: string;
  status: number;
  body: string;
}

/** A URL to fetch at depth 0, plus the text that referred an agent to it (used by the
 * guarded agent's advertised-price check). Seeds may repeat the same URL more than
 * once - the naive agent uses this to fetch a prompt URL twice. */
export interface CrawlSeed {
  url: string;
  referrerBody: string;
}

export interface CrawlOptions {
  /** Every origin the crawler is allowed to request or follow a redirect/link to - see
   * `allowedOrigins()`. */
  origins: Set<string>;
  /** Default 3, per functional-design.md §5. */
  maxDepth?: number;
  /** Default 30, per functional-design.md §5. */
  maxFetches?: number;
  /** Fired once per URL the crawl becomes aware of (every seed, then every link found
   * in a fetched page's body), before that URL is necessarily fetched. */
  onDiscover?: (url: string, referrerBody: string) => void;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_FETCHES = 30;
const MAX_REDIRECT_HOPS = 10;

/** Any absolute http(s) URL - a broad candidate match; `isCrawlable` (exact origin
 * membership) is what actually decides whether the crawler follows it. */
const URL_CANDIDATE_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** A minimal, structural shape of `TaskFile` - just enough to compute the origin
 * allow-list, so this module never has to import `./wallet.js` (which itself imports
 * `FetchLike` from here). */
export interface HostSource {
  base_url: string;
  /** v3 (ADR-012): every virtual host this scenario declares, rendered to its origin
   * under the active `host_mode`. Absent on a v1/v2 task (path mode only, implicitly). */
  hosts?: Record<string, string>;
}

/**
 * Every origin a crawler driven by `task` may request: `task.base_url`'s own origin
 * (the harness's endpoints, and every `path`-mode virtual host, which is a path prefix
 * on that one origin) union the origin of every `task.hosts` entry (every
 * `localhost`/`proxy`-mode virtual host this *scenario* names - including an
 * intentionally-malicious one, like a lookalike-domain route, which is still part of
 * this scenario's own declared surface; refusing to *pay* it is the guardrail's job, not
 * a reason to make it unreachable to the crawler).
 */
export function allowedOrigins(task: HostSource): Set<string> {
  const origins = new Set<string>();
  const base = safeOrigin(task.base_url);
  if (base !== undefined) origins.add(base);
  for (const hostUrl of Object.values(task.hosts ?? {})) {
    const origin = safeOrigin(hostUrl);
    if (origin !== undefined) origins.add(origin);
  }
  return origins;
}

/** True iff `url`'s own origin (scheme + host + port) is exactly one of `origins` - see
 * the module docstring for why this is an exact-match set check, never a substring or
 * suffix/prefix regex against the raw URL string. */
function isCrawlable(url: string, origins: Set<string>): boolean {
  const origin = safeOrigin(url);
  return origin !== undefined && origins.has(origin);
}

/** Every URL in `text` the crawler is allowed to follow (see `isCrawlable`), trailing
 * punctuation trimmed. */
export function extractUrls(text: string, origins: Set<string>): string[] {
  const candidates = text.match(URL_CANDIDATE_RE) ?? [];
  const found: string[] = [];
  for (const raw of candidates) {
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    if (isCrawlable(trimmed, origins)) found.push(trimmed);
  }
  return found;
}

/** Fetches one seed to completion, following redirects manually - only within `origins`. */
async function fetchOne(
  fetchFn: FetchLike,
  startUrl: string,
  origins: Set<string>,
  consumeFetch: () => boolean,
): Promise<CrawledPage | undefined> {
  let url = startUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    if (!consumeFetch()) return undefined;

    let res: Response;
    try {
      res = await fetchFn(url, { redirect: "manual" });
    } catch {
      return undefined;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return undefined;
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        return undefined;
      }
      if (!isCrawlable(next, origins)) return undefined;
      url = next;
      continue;
    }

    const body = await res.text().catch(() => "");
    return { url, status: res.status, body };
  }
  return undefined;
}

/**
 * BFS from `seeds`, discovering further links (up to `maxDepth`) inside every
 * successfully-fetched page's body, capped at `maxFetches` total HTTP
 * attempts (redirect hops and per-seed retries the caller layers on top both
 * count against this cap).
 */
export async function crawl(
  fetchFn: FetchLike,
  seeds: CrawlSeed[],
  opts: CrawlOptions,
): Promise<CrawledPage[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFetches = opts.maxFetches ?? DEFAULT_MAX_FETCHES;

  let fetches = 0;
  const consumeFetch = (): boolean => {
    if (fetches >= maxFetches) return false;
    fetches += 1;
    return true;
  };

  interface QueueItem {
    url: string;
    depth: number;
  }
  const queue: QueueItem[] = [];
  const seenLinks = new Set<string>();
  const pages: CrawledPage[] = [];

  for (const seed of seeds) {
    opts.onDiscover?.(seed.url, seed.referrerBody);
    queue.push({ url: seed.url, depth: 0 });
  }

  while (queue.length > 0 && fetches < maxFetches) {
    const item = queue.shift();
    if (!item) break;

    const page = await fetchOne(fetchFn, item.url, opts.origins, consumeFetch);
    if (!page) continue;

    pages.push(page);
    if (item.depth >= maxDepth) continue;

    for (const next of extractUrls(page.body, opts.origins)) {
      if (seenLinks.has(next)) continue;
      seenLinks.add(next);
      opts.onDiscover?.(next, page.body);
      queue.push({ url: next, depth: item.depth + 1 });
    }
  }

  return pages;
}
