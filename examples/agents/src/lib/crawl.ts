/**
 * Shared crawler for both reference agents, per application-design.md §8 /
 * U5 functional-design.md §5: pulls URLs out of a page (or the task prompt)
 * that start with `task.base_url`, follows links up to depth 3, follows
 * redirects manually, and caps the whole crawl at 30 fetches.
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
  baseUrl: string;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every `task.base_url`-prefixed URL found in `text`, trailing punctuation trimmed. */
export function extractUrls(text: string, baseUrl: string): string[] {
  const re = new RegExp(`${escapeRegExp(baseUrl)}[^\\s"'<>)\\]]*`, "g");
  const found = text.match(re) ?? [];
  return found.map((u) => u.replace(/[.,;:!?]+$/, ""));
}

/** Fetches one seed to completion, following same-origin redirects manually. */
async function fetchOne(
  fetchFn: FetchLike,
  startUrl: string,
  baseUrl: string,
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
      if (!next.startsWith(baseUrl)) return undefined;
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

    const page = await fetchOne(fetchFn, item.url, opts.baseUrl, consumeFetch);
    if (!page) continue;

    pages.push(page);
    if (item.depth >= maxDepth) continue;

    for (const next of extractUrls(page.body, opts.baseUrl)) {
      if (seenLinks.has(next)) continue;
      seenLinks.add(next);
      opts.onDiscover?.(next, page.body);
      queue.push({ url: next, depth: item.depth + 1 });
    }
  }

  return pages;
}
