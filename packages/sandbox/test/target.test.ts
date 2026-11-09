import { describe, expect, it } from "vitest";
import { makeTargetPolicy, normalizeHost, stubMatches } from "../src/target.js";

const policy = makeTargetPolicy(new Set(["provider.test"]), new Set([7000]));

describe("target policy", () => {
  it("allows 127.0.0.1, localhost names and declared hosts only", () => {
    expect(policy.isAllowedHost("127.0.0.1")).toBe(true);
    expect(policy.isAllowedHost("localhost")).toBe(true);
    expect(policy.isAllowedHost("a.b.localhost")).toBe(true);
    expect(policy.isAllowedHost("provider.test")).toBe(true);
    expect(policy.isAllowedHost(undefined)).toBe(true);
    expect(policy.isAllowedHost("example.com")).toBe(false);
  });
  it("refuses ::1 and any other IP literal (D9)", () => {
    expect(policy.isAllowedHost("::1")).toBe(false);
    expect(policy.isAllowedHost("[::1]")).toBe(false);
    expect(policy.isAllowedHost("93.184.215.14")).toBe(false);
  });
  it("pins ports: a missing or other port is refused (D1, D8)", () => {
    expect(policy.isAllowedTarget("127.0.0.1", 7000)).toBe(true);
    expect(policy.isAllowedTarget("127.0.0.1", "7000")).toBe(true);
    expect(policy.isAllowedTarget("127.0.0.1", 7001)).toBe(false);
    expect(policy.isAllowedTarget("127.0.0.1", undefined)).toBe(false);
    expect(policy.isAllowedTarget("example.com", 7000)).toBe(false);
    expect(policy.ports()).toEqual([7000]);
  });
  it("normalises brackets, case and a trailing dot", () => {
    expect(normalizeHost("[A.Test.]")).toBe("a.test");
  });
});

describe("stubs", () => {
  const stubs = [
    { url: "https://registry.test/pkg/latest", match: "path" as const },
    { url: "https://analytics.test", match: "origin" as const },
  ];
  it("matches an exact origin and path only for `path` stubs", () => {
    expect(stubMatches(stubs, new URL("https://registry.test/pkg/latest"))).toBe(true);
    expect(stubMatches(stubs, new URL("https://registry.test/other"))).toBe(false);
    expect(stubMatches(stubs, new URL("https://registry.test/pkg/latest?x=1"))).toBe(true);
  });
  it("matches any path on the origin for `origin` stubs", () => {
    expect(stubMatches(stubs, new URL("https://analytics.test/a/b"))).toBe(true);
    expect(stubMatches(stubs, new URL("http://analytics.test/a"))).toBe(false);
  });
  it("answers nothing without a stub, and a stub target is not an allowed host", () => {
    expect(stubMatches([], new URL("https://analytics.test/"))).toBe(false);
    // The guard checks stubs first; the target policy alone would refuse these hosts.
    expect(policy.isAllowedHost("registry.test")).toBe(false);
  });
});
