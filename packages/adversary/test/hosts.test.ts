import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { resolveHost } from "../src/hosts.js";

/** `resolveHost` only ever reads `c.req.url` and `c.req.header("host")`. */
function ctx(url: string, host?: string): Context {
  return {
    req: {
      url,
      header: (name: string) => (name.toLowerCase() === "host" ? host : undefined),
    },
  } as unknown as Context;
}

describe("resolveHost in path mode (U15, Bolt 6 Phase A)", () => {
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

  it("ignores the Host header entirely in path mode", () => {
    expect(
      resolveHost(
        ctx("http://127.0.0.1:1234/weather/today", "weather-report.test.localhost"),
        "path",
      ),
    ).toEqual({
      host: "provider.test",
      path: "/weather/today",
    });
  });
});

describe("resolveHost in localhost mode (ADR-012 full, U17)", () => {
  it("strips the port then the .localhost suffix from a Host header", () => {
    expect(
      resolveHost(ctx("http://ignored/x", "weather-rep0rt.test.localhost:1234"), "localhost"),
    ).toEqual({ host: "weather-rep0rt.test", path: "/x" });
  });

  it("lowercases a mixed-case Host header", () => {
    expect(
      resolveHost(ctx("http://ignored/x", "Weather-Report.Test.localhost"), "localhost"),
    ).toEqual({ host: "weather-report.test", path: "/x" });
  });

  it("falls back to /_host/ path parsing for a bare 127.0.0.1 Host (with a port)", () => {
    expect(
      resolveHost(ctx("http://127.0.0.1:1234/_host/x/y", "127.0.0.1:1234"), "localhost"),
    ).toEqual({ host: "x", path: "/y" });
  });

  it("falls back to /_host/ path parsing for a bare localhost Host", () => {
    expect(
      resolveHost(
        ctx("http://localhost:1234/_host/cdn-metrics.test", "localhost:1234"),
        "localhost",
      ),
    ).toEqual({ host: "cdn-metrics.test", path: "" });
  });

  it("falls back to the default host for an IPv6 loopback Host ([::1]) with no /_host/ path", () => {
    expect(resolveHost(ctx("http://[::1]:1234/weather/today", "[::1]:1234"), "localhost")).toEqual({
      host: "provider.test",
      path: "/weather/today",
    });
  });

  it("falls back to the default host when there is no Host header at all", () => {
    expect(resolveHost(ctx("http://127.0.0.1:1234/weather/today"), "localhost")).toEqual({
      host: "provider.test",
      path: "/weather/today",
    });
  });
});

describe("resolveHost in proxy mode (ADR-012 full, U17)", () => {
  it("uses the bare Host header as the scenario host - no .localhost suffix to strip", () => {
    expect(resolveHost(ctx("http://ignored/x", "weather-report.test"), "proxy")).toEqual({
      host: "weather-report.test",
      path: "/x",
    });
  });

  it("falls back to /_host/ path parsing for the harness's own loopback Host", () => {
    expect(resolveHost(ctx("http://127.0.0.1:1234/_host/x/y", "127.0.0.1:1234"), "proxy")).toEqual({
      host: "x",
      path: "/y",
    });
  });
});
