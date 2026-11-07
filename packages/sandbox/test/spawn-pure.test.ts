import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLoader, nodeArgv, sandboxArgv } from "../src/spawn.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("nodeArgv", () => {
  it("puts the pre-imports first, then the adapter's loader, then the guard, then the script", () => {
    const argv = nodeArgv({
      script: "/s/child.ts",
      loader: "file:///a/node_modules/tsx/dist/loader.mjs",
      guardEntry: "/a/src/guard.ts",
      guard: true,
      preImports: ["/a/hook.mjs"],
      scriptArgs: ["x"],
    });
    expect(argv.slice(1)).toEqual([
      "--import",
      "/a/hook.mjs",
      "--import",
      "file:///a/node_modules/tsx/dist/loader.mjs",
      "--import",
      "/a/src/guard.ts",
      "/s/child.ts",
      "x",
    ]);
  });
  it("leaves the guard out when asked", () => {
    const argv = nodeArgv({ script: "/s.ts", loader: "L", guardEntry: "/g.ts", guard: false });
    expect(argv).not.toContain("/g.ts");
  });
});

describe("sandboxArgv", () => {
  it("wraps with sandbox-exec and the profile", () => {
    expect(sandboxArgv("sandbox-exec", ["node", "x"], "PROFILE")).toEqual([
      "/usr/bin/sandbox-exec",
      "-p",
      "PROFILE",
      "node",
      "x",
    ]);
  });
  it("wraps with unshare -rn and brings loopback up", () => {
    const argv = sandboxArgv("unshare", ["node"], "ignored");
    expect(argv.slice(0, 2)).toEqual(["unshare", "-rn"]);
    expect(argv.at(-1)).toBe("node");
  });
  it("refuses without a sandbox", () => {
    expect(() => sandboxArgv("none", [], "")).toThrow(/no OS sandbox/);
  });
});

describe("checkLoader (M1)", () => {
  const guardEntry = join(
    here,
    "..",
    "..",
    "..",
    "examples",
    "third-party",
    "cloudflare",
    "src",
    "guard.ts",
  );
  it("refuses a loader that is not under a node_modules", () => {
    expect(checkLoader(join(here, "..", "src", "spawn.ts"), guardEntry)).toMatch(/node_modules/);
  });
  it("refuses a loader outside the adapter's own tree, such as the root's tsx", () => {
    const rootTsx = join(here, "..", "..", "..", "node_modules", "tsx", "dist", "loader.mjs");
    expect(checkLoader(rootTsx, guardEntry)).toMatch(/adapter's own tree/);
  });
  it("accepts a loader inside the adapter's tree", () => {
    const own = join(
      here,
      "..",
      "..",
      "..",
      "examples",
      "third-party",
      "cloudflare",
      "node_modules",
      "tsx",
      "loader.mjs",
    );
    expect(checkLoader(own, guardEntry)).toBeUndefined();
  });
});
