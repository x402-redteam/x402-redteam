/**
 * Self-contained BFS crawler for the standard driver, per functional-design.md §2
 * ("BFS over every link on harness origins ... depth <= 4, <= 200 fetches"). Copied and
 * adapted from `examples/agents/src/lib/crawl.ts` rather than imported - "do not import
 * from examples/" (functional-design.md §5) - with the depth/fetch caps and discovery
 * origins widened for a *maximally attempting* driver instead of the reference agents'
 * depth-3/30-fetch budget, and `onDiscover` reporting the discovering page's full URL
 * (not just its body) so `main.ts` can build GDP's `referrer: {url, text}`.
 *
 * Code review round 1:
 * - finding 7: ADR-010 says the driver "fetches each URL twice" - this used to be true
 *   only of the seeds (`main.ts` manually duplicated them); every discovered link is now
 *   queued twice here too, so the rule is uniform and `main.ts` no longer needs to know
 *   about it.
 * - finding 8: a redirect target never used to get an `onDiscover` call at all (it isn't
 *   "found in a page body", it's an automatic hop), so a guardrail's `payment`/`transfer`
 *   `referrer` for a redirected URL was always `null` - it now cites the URL that
 *   redirected to it, with empty text (a redirect carries no page prose).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CrawledPage {
  url: string;
  status: number;
  body: string;
}

/** A URL to fetch at depth 0, plus the page that referred an agent to it (used for the
 * GDP `payment`/`transfer` hooks' `referrer`). `crawl()` fetches every seed twice
 * (ADR-010; code review finding 7), so callers pass each seed URL once. */
export interface CrawlSeed {
  url: string;
  referrerUrl: string;
  referrerBody: string;
}

export interface CrawlOptions {
  /** Every origin a discovered link is followed on - any `*.localhost` harness host,
   * `base_url`, or an `/_host/` path-mode URL all resolve to one of these origins so the
   * driver crawls every harness host, not just the one named in the prompt. */
  originPrefixes: string[];
  /** Default 4, per functional-design.md §2. */
  maxDepth?: number;
  /** Default 200, per functional-design.md §2. */
  maxFetches?: number;
  /** Fired once per URL the crawl becomes aware of (every seed, every link found in a
   * fetched page's body, and every redirect target - code review finding 8), before
   * that URL is necessarily fetched. Never fired twice for the same URL, even though the
   * URL itself is queued (and so possibly fetched) twice. */
  onDiscover?: (url: string, referrerUrl: string, referrerBody: string) => void;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_FETCHES = 200;
const MAX_REDIRECT_HOPS = 10;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isOnAnyOrigin(url: string, originPrefixes: string[]): boolean {
  return originPrefixes.some((prefix) => url.startsWith(prefix));
}

/** Every URL in `text` that starts with one of `originPrefixes`, trailing punctuation
 * trimmed, in order of first appearance (lexical within the page, per the driver's
 * determinism rule, functional-design.md §3 step 6). */
export function extractUrls(text: string, originPrefixes: string[]): string[] {
  const found: string[] = [];
  for (const prefix of originPrefixes) {
    const re = new RegExp(`${escapeRegExp(prefix)}[^\\s"'<>)\\]]*`, "g");
    for (const match of text.match(re) ?? []) {
      found.push(match.replace(/[.,;:!?]+$/, ""));
    }
  }
  return found;
}

/**
 * Fetches one seed to completion, following same-origin-set redirects manually. Each
 * redirect hop is reported to `onDiscover` (finding 8), citing the URL that redirected
 * to it as the referrer, so a guardrail judging the final (redirected-to) URL isn't left
 * with a `null` referrer just because nothing "linked" to it in page text.
 */
async function fetchOne(
  fetchFn: FetchLike,
  startUrl: string,
  originPrefixes: string[],
  consumeFetch: () => boolean,
  onDiscover: ((url: string, referrerUrl: string, referrerBody: string) => void) | undefined,
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
      if (!isOnAnyOrigin(next, originPrefixes)) return undefined;
      onDiscover?.(next, url, "");
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
 * successfully-fetched page's body, capped at `maxFetches` total HTTP attempts. Every
 * seed and every discovered link (including a redirect target) is queued *twice*
 * (ADR-010, "fetches each URL twice"; code review finding 7) - redirect hops and the
 * second-visit's own hops both count against `maxFetches`.
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

  const enqueueTwice = (url: string, depth: number): void => {
    queue.push({ url, depth });
    queue.push({ url, depth });
  };

  for (const seed of seeds) {
    opts.onDiscover?.(seed.url, seed.referrerUrl, seed.referrerBody);
    enqueueTwice(seed.url, 0);
  }

  while (queue.length > 0 && fetches < maxFetches) {
    const item = queue.shift();
    if (!item) break;

    const page = await fetchOne(
      fetchFn,
      item.url,
      opts.originPrefixes,
      consumeFetch,
      opts.onDiscover,
    );
    if (!page) continue;

    pages.push(page);
    if (item.depth >= maxDepth) continue;

    for (const next of extractUrls(page.body, opts.originPrefixes)) {
      if (seenLinks.has(next)) continue;
      seenLinks.add(next);
      opts.onDiscover?.(next, page.url, page.body);
      enqueueTwice(next, item.depth + 1);
    }
  }

  return pages;
}
