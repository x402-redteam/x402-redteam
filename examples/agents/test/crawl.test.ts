import { describe, expect, it } from "vitest";
import {
  allowedOrigins,
  type CrawlSeed,
  crawl,
  extractUrls,
  type FetchLike,
} from "../src/lib/crawl.js";

const BASE_URL = "http://127.0.0.1:4321";
const ORIGINS = allowedOrigins({
  base_url: BASE_URL,
  hosts: {
    "provider.test": BASE_URL,
    "weather-report.test": "http://weather-report.test.localhost:4321",
  },
});

describe("extractUrls (ADR-012 full, U17: origin-allowlist based, not a suffix regex)", () => {
  it("still finds base_url-prefixed URLs (path mode, and every mode's harness endpoints)", () => {
    expect(extractUrls(`Fetch ${BASE_URL}/forecast now.`, ORIGINS)).toEqual([
      `${BASE_URL}/forecast`,
    ]);
  });

  it("finds a *.localhost URL whose origin is in task.hosts", () => {
    const text = "Our verified partner is http://weather-report.test.localhost:4321/forecast.";
    expect(extractUrls(text, ORIGINS)).toEqual([
      "http://weather-report.test.localhost:4321/forecast",
    ]);
  });

  it("finds both kinds of URL in the same text, in order", () => {
    const text = `See ${BASE_URL}/forecast or our partner http://weather-report.test.localhost:4321/forecast.`;
    expect(extractUrls(text, ORIGINS)).toEqual([
      `${BASE_URL}/forecast`,
      "http://weather-report.test.localhost:4321/forecast",
    ]);
  });

  it("does not match an unrelated https URL with no declared origin", () => {
    expect(extractUrls("Visit http://example.com/ instead.", ORIGINS)).toEqual([]);
  });

  it("trims trailing punctuation off a *.localhost URL exactly like a base_url one", () => {
    const originsWithProvider = allowedOrigins({
      base_url: BASE_URL,
      hosts: { "provider.test": "http://provider.test.localhost:4321" },
    });
    expect(
      extractUrls("See http://provider.test.localhost:4321/forecast, today.", originsWithProvider),
    ).toEqual(["http://provider.test.localhost:4321/forecast"]);
  });

  it("is case-insensitive via URL normalization, not the raw string", () => {
    const upper = allowedOrigins({
      base_url: BASE_URL,
      hosts: { "weather-report.test": "http://Weather-Report.Test.LOCALHOST:4321" },
    });
    expect(extractUrls("http://Weather-Report.Test.LOCALHOST:4321/x", upper)).toEqual([
      "http://Weather-Report.Test.LOCALHOST:4321/x",
    ]);
  });

  // Code review F1 (HIGH, egress): a suffix/prefix regex against "*.localhost" is
  // trivially defeated by a real, different DNS origin that merely *contains* the
  // substring ".localhost" - these must never be extracted or fetched.
  describe("F1 egress fix: rejects look-alike *.localhost substrings with a different real origin", () => {
    it("rejects http://a.localhost.evil.com/x (the declared origin is a SUFFIX of this string, not a match)", () => {
      expect(extractUrls("Click http://a.localhost.evil.com/x now.", ORIGINS)).toEqual([]);
    });

    it("rejects http://x.localhost-evil.com/y (the declared origin is a PREFIX of this string, not a match)", () => {
      expect(extractUrls("Click http://x.localhost-evil.com/y now.", ORIGINS)).toEqual([]);
    });

    it("still accepts the real declared origin alongside both evil look-alikes in the same text", () => {
      const text =
        "Real: http://weather-report.test.localhost:4321/forecast " +
        "Evil1: http://a.localhost.evil.com/x " +
        "Evil2: http://x.localhost-evil.com/y";
      expect(extractUrls(text, ORIGINS)).toEqual([
        "http://weather-report.test.localhost:4321/forecast",
      ]);
    });
  });
});

describe("allowedOrigins", () => {
  it("includes base_url's own origin even with no task.hosts", () => {
    expect(allowedOrigins({ base_url: BASE_URL })).toEqual(new Set([BASE_URL]));
  });

  it("unions base_url's origin with every task.hosts value's origin", () => {
    const origins = allowedOrigins({
      base_url: BASE_URL,
      hosts: {
        "provider.test": `${BASE_URL}/_host/provider.test`,
        "weather-report.test": "http://weather-report.test.localhost:4321/ignored-path",
      },
    });
    // _host/-suffixed path-mode URLs share base_url's own origin (path mode has one origin).
    expect(origins).toEqual(new Set([BASE_URL, "http://weather-report.test.localhost:4321"]));
  });
});

describe("crawl follows a cross-origin *.localhost redirect (recipient-redirect, ADR-012 full)", () => {
  it("follows a 302 Location that moves to a different, declared *.localhost host", async () => {
    const target = "http://weather-report.test.localhost:4321/landing";
    const fetchFn: FetchLike = async (url) => {
      if (url === `${BASE_URL}/go`) {
        return new Response(null, { status: 302, headers: { location: target } });
      }
      if (url === target) {
        return new Response("landed", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const seeds: CrawlSeed[] = [{ url: `${BASE_URL}/go`, referrerBody: "" }];
    const pages = await crawl(fetchFn, seeds, { origins: ORIGINS });
    expect(pages).toEqual([{ url: target, status: 200, body: "landed" }]);
  });

  it("refuses to follow a redirect to an undeclared host", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url === `${BASE_URL}/go`) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://example.com/steal" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const seeds: CrawlSeed[] = [{ url: `${BASE_URL}/go`, referrerBody: "" }];
    const pages = await crawl(fetchFn, seeds, { origins: ORIGINS });
    expect(pages).toEqual([]);
  });

  it("refuses to follow a redirect to a look-alike *.localhost-substring host (F1)", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url === `${BASE_URL}/go`) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://a.localhost.evil.com/steal" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const seeds: CrawlSeed[] = [{ url: `${BASE_URL}/go`, referrerBody: "" }];
    const pages = await crawl(fetchFn, seeds, { origins: ORIGINS });
    expect(pages).toEqual([]);
  });
});
