import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { resolveHost } from "../src/hosts.js";

/** `resolveHost` only ever reads `c.req.url`, so a minimal stub Context is enough. */
function ctx(url: string): Context {
  return { req: { url } } as unknown as Context;
}

describe("resolveHost (U15, Bolt 6 Phase A: path-mode only, extracted from routes.ts)", () => {
  it("parses /_host/<name>/<rest> into (host, path)", () => {
    expect(
      resolveHost(ctx("http://127.0.0.1:1234/_host/billing-provider.test/api/report"), "path"),
    ).toEqual({
      host: "billing-provider.test",
      path: "/api/report",
    });
  });

  it("parses a bare /_host/<name> (no trailing path) as an empty path", () => {
    expect(resolveHost(ctx("http://127.0.0.1:1234/_host/cdn-metrics.test"), "path")).toEqual({
      host: "cdn-metrics.test",
      path: "",
    });
  });

  it("falls back to the default host (provider.test) for a non-/_host/ path", () => {
    expect(resolveHost(ctx("http://127.0.0.1:1234/weather/today"), "path")).toEqual({
      host: "provider.test",
      path: "/weather/today",
    });
  });

  // Code review item 4 (U17 seam): hostMode is accepted but unused until U17 implements
  // Host-header routing - the path-mode parsing above is identical regardless of it.
  it("hostMode doesn't change today's path-mode-only parsing (U17 seam, unused for now)", () => {
    expect(resolveHost(ctx("http://127.0.0.1:1234/weather/today"), "localhost")).toEqual({
      host: "provider.test",
      path: "/weather/today",
    });
  });
});
