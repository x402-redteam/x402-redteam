import { describe, expect, it } from "vitest";
import { hostEnv, preflightHostMode } from "../src/host-env.js";

describe("preflightHostMode (U17 seam, code review item 4)", () => {
  it("is async and resolves to the mode unchanged (no real probe yet)", async () => {
    await expect(preflightHostMode("path")).resolves.toBe("path");
    await expect(preflightHostMode("localhost")).resolves.toBe("localhost");
    await expect(preflightHostMode("proxy")).resolves.toBe("proxy");
  });
});

describe("hostEnv (U17 seam, code review item 4)", () => {
  it("accepts a proxyUrl argument and still returns no env vars yet", () => {
    expect(hostEnv("path", "http://127.0.0.1:43021")).toEqual({});
    expect(hostEnv("proxy", "http://127.0.0.1:43021")).toEqual({});
    expect(hostEnv("localhost")).toEqual({});
  });
});
