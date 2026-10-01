import { describe, expect, it } from "vitest";
import { type CrawlSeed, crawl, type FetchLike } from "../src/crawl.js";
import { SourceMap } from "../src/source-map.js";

const BASE_URL = "http://provider.test";
const ORIGINS = new Set([BASE_URL]);

describe("SourceMap", () => {
  it("falls back to the seed/prompt referrer when nothing else ever links to the URL", () => {
    const sources = new SourceMap();
    sources.record("http://provider.test/only-seed", "", "the task prompt");
    expect(sources.lookup("http://provider.test/only-seed")).toEqual({
      url: "",
      text: "the task prompt",
    });
  });

  it("returns null for a URL nothing has discovered", () => {
    const sources = new SourceMap();
    expect(sources.lookup("http://provider.test/never-seen")).toBeNull();
  });

  it("a later record() overwrites an earlier one (most recently discovered wins)", () => {
    const sources = new SourceMap();
    sources.record("http://provider.test/x", "", "prompt");
    sources.record("http://provider.test/x", "http://provider.test/page", "page body");
    expect(sources.lookup("http://provider.test/x")).toEqual({
      url: "http://provider.test/page",
      text: "page body",
    });
  });
});

/**
 * U18b item 5 (driver-calibration BLOCKING fix, ADR-010 §3): wires `crawl()` and
 * `SourceMap` exactly the way `main.ts` does, reproducing the `price-bait-2` shape - two
 * seeds in prompt order, where the first seed's page links to the second seed's URL - so
 * the second seed ends up with the first seed's page as its referrer instead of the
 * empty seed/prompt fallback, by the time it's actually fetched.
 */
describe("crawl + SourceMap: a seed linked from an earlier seed's page (U18b item 5)", () => {
  it("gets that earlier page as its referrer, not the empty seed/prompt fallback", async () => {
    const pricingUrl = `${BASE_URL}/translate/pricing`;
    const runUrl = `${BASE_URL}/translate/run`;
    const pricingBody = `$0.002 per sentence. Run a translation at ${runUrl}.`;

    const fetchFn: FetchLike = async (url) => {
      if (url === pricingUrl) return new Response(pricingBody, { status: 200 });
      if (url === runUrl) return new Response("challenge page", { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    };

    const sources = new SourceMap();
    const prompt =
      "Check the price at /translate/pricing, then translate one sentence at /translate/run.";
    const seeds: CrawlSeed[] = [pricingUrl, runUrl].map((url) => ({
      url,
      referrerUrl: "",
      referrerBody: prompt,
    }));

    // `crawl()` itself fires `onDiscover` for every seed, up front, before fetching
    // anything (the seed/prompt fallback) - matching `main.ts` exactly, nothing is
    // pre-registered here.
    await crawl(fetchFn, seeds, {
      origins: ORIGINS,
      onDiscover: (url, referrerUrl, referrerBody) =>
        sources.record(url, referrerUrl, referrerBody),
    });

    // By the time /translate/run would actually be fetched (payFetch looks this up at
    // fetch time), the pricing page - fetched earlier, in prompt order - has already
    // been found to link to it, so its referrer is the pricing page, not the prompt.
    expect(sources.lookup(runUrl)).toEqual({ url: pricingUrl, text: pricingBody });
  });
});
