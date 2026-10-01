import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostEnv, preflightHostMode } from "../src/host-env.js";

describe("preflightHostMode (ADR-012 full §3, U17)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("path and proxy pass through unchanged - no preflight check", async () => {
    await expect(preflightHostMode("path")).resolves.toBe("path");
    await expect(preflightHostMode("proxy")).resolves.toBe("proxy");
  });

  it("localhost mode resolves to localhost when *.localhost actually works (verified on this macOS/Node 20 host)", async () => {
    await expect(preflightHostMode("localhost")).resolves.toBe("localhost");
  });

  it("falls back to path and warns when the loopback GET fails", async () => {
    // Code review F7: the probe now uses node:http.get (not global fetch), specifically
    // so it can't be diverted by the user's own ambient HTTP_PROXY - so this stubs
    // node:http's own `get` (keeping its real `createServer`, which the probe still uses
    // to bind a genuine throwaway server) to simulate a connection failure, rather than
    // stubbing global `fetch` (which the probe no longer calls at all).
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("node:http", async () => {
      const actual = await vi.importActual<typeof import("node:http")>("node:http");
      return {
        ...actual,
        get: () => {
          const req = new EventEmitter();
          queueMicrotask(() => req.emit("error", new Error("connection refused (stubbed)")));
          return req;
        },
      };
    });
    vi.resetModules();
    const { preflightHostMode: reloaded } = await import("../src/host-env.js");
    await expect(reloaded("localhost")).resolves.toBe("path");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to --host-mode path"));
    vi.doUnmock("node:http");
    vi.resetModules();
  });

  it("F7: a broken/diverted global fetch never affects the probe (it never calls fetch)", async () => {
    // Simulates the user's own ambient HTTP_PROXY silently breaking or redirecting
    // fetch() - if the probe used global fetch, this would make a working *.localhost
    // setup look broken. It must not: the real preflight still passes.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("diverted by an unrelated ambient HTTP_PROXY"))),
    );
    await expect(preflightHostMode("localhost")).resolves.toBe("localhost");
  });

  it("falls back to path when dns.lookup can't resolve the probe hostname", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("node:dns/promises", () => ({
      lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
    }));
    vi.resetModules();
    const { preflightHostMode: reloaded } = await import("../src/host-env.js");
    await expect(reloaded("localhost")).resolves.toBe("path");
    expect(warn).toHaveBeenCalled();
    vi.doUnmock("node:dns/promises");
    vi.resetModules();
  });
});

describe("hostEnv (ADR-012 full §4, U17)", () => {
  it("is empty in path and localhost mode regardless of proxyUrl", () => {
    expect(hostEnv("path", "http://127.0.0.1:43021")).toEqual({});
    expect(hostEnv("localhost", "http://127.0.0.1:43021")).toEqual({});
    expect(hostEnv("localhost")).toEqual({});
  });

  it("is empty in proxy mode when there is no proxyUrl", () => {
    expect(hostEnv("proxy")).toEqual({});
  });

  it("sets HTTP_PROXY/http_proxy, empties NO_PROXY/no_proxy, and sets NODE_USE_ENV_PROXY in proxy mode", () => {
    expect(hostEnv("proxy", "http://127.0.0.1:43021")).toEqual({
      HTTP_PROXY: "http://127.0.0.1:43021",
      http_proxy: "http://127.0.0.1:43021",
      NO_PROXY: "",
      no_proxy: "",
      NODE_USE_ENV_PROXY: "1",
    });
  });
});

describe("probeLoopbackGet sanity (no stubbing) - a real throwaway loopback server answers", () => {
  it("a plain loopback HTTP round trip works on this host (baseline for the preflight itself)", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
