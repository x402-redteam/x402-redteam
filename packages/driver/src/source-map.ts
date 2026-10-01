/**
 * Tracks the referrer `main.ts` should cite for each URL it has become aware of, per
 * functional-design.md "U18b" item 5 (ADR-010 §3, "maximally-attempting with realistic
 * context" - the driver-calibration fix for `price-bait-2` overpaying because
 * `/translate/run`, a seed URL, got the empty seed referrer instead of the pricing page
 * that linked to it):
 *
 * "a URL's referrer is the most recently fetched page whose body links to that URL,
 * whether that URL is a seed or was discovered. Only when no fetched page links to it
 * does it get the seed referrer."
 *
 * `record()` always overwrites - never "first write wins". `crawl()` calls it once per
 * seed up front, synchronously, before any fetch happens at all (the seed/prompt
 * fallback), and then again - in fetch order - every time a *fetched* page's body is
 * found to link to a URL, including a seed's own URL. Every page-link discovery
 * therefore necessarily happens after every seed registration, so a real link always
 * wins over the seed/prompt fallback once one is found, with no special-casing of any
 * scenario or URL shape. `lookup()` is read by `pay.ts`'s fetch wrapper at the moment a
 * URL is actually fetched (not at discovery time), so "most recently fetched page" is
 * always the state of the world *right then* - seeds are queued in prompt order
 * (`extractUrls` preserves order of first appearance), so an earlier seed's own page,
 * once fetched, can supply a better referrer for a later seed before that later seed is
 * ever dequeued and fetched.
 */
export interface Source {
  url: string;
  text: string;
}

export class SourceMap {
  private readonly byUrl = new Map<string, Source>();

  /** Records (or overwrites) `url`'s referrer: the page at `referrerUrl` whose body
   * (`referrerBody`) names or links to it - or, for a seed, the empty URL and the task
   * prompt itself. */
  record(url: string, referrerUrl: string, referrerBody: string): void {
    this.byUrl.set(url, { url: referrerUrl, text: referrerBody });
  }

  /** `url`'s current referrer, or `null` if nothing has ever discovered it (shouldn't
   * happen for any URL the driver actually fetches, since `crawl()` always discovers a
   * URL - seed or link - before fetching it). */
  lookup(url: string): Source | null {
    return this.byUrl.get(url) ?? null;
  }
}
