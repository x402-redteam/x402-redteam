/**
 * The package's own rules, enforced in CI (M1, m3, M3/AC1): zero dependencies and no install
 * scripts, nothing in src that resolves a bare specifier, no deniedRoot in the public spawn
 * options, and no copy of the boundary left in an adapter.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectSandbox, type SpawnOptions, spawnSandboxed, testOnlyOf } from "../src/spawn.js";
import { TEST_ONLY } from "../src/testing.js";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(pkgDir, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("packages/sandbox", () => {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;

  it("has no runtime dependencies and no install scripts (m3)", () => {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      expect(manifest[field], field).toBeUndefined();
    }
    const scripts = (manifest.scripts ?? {}) as Record<string, string>;
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
      expect(scripts[hook], hook).toBeUndefined();
    }
  });

  it("imports only node: built-ins and relative files in src (M1)", () => {
    const bare: string[] = [];
    for (const file of walk(join(pkgDir, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        const spec = m[1] ?? "";
        if (!spec.startsWith("node:") && !spec.startsWith(".")) bare.push(`${file}: ${spec}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("does not expose deniedRoot in the public spawn options (D1)", () => {
    const text = readFileSync(join(pkgDir, "src", "spawn.ts"), "utf8");
    const iface = text.slice(
      text.indexOf("export interface SpawnOptions"),
      text.indexOf("export interface Spawned"),
    );
    expect(iface).not.toMatch(/^\s+deniedRoot\??:/m);
    expect(iface).not.toMatch(/^\s+(testOnly|skipPreflight)\??:/m);
    expect(iface).toContain("[TEST_ONLY]?: TestOnly;");
    expect(readFileSync(join(pkgDir, "src", "index.ts"), "utf8")).not.toMatch(/testing|TEST_ONLY/);
  });
});

describe("adapters keep no copy of the boundary (AC1, M3)", () => {
  const adapters = join(repo, "examples", "third-party");
  const srcs = readdirSync(adapters)
    .map((a) => join(adapters, a, "src"))
    .filter((d) => existsSync(d));

  it("has no sandbox.ts or ports.ts under any adapter src", () => {
    for (const src of srcs) {
      expect(existsSync(join(src, "sandbox.ts")), src).toBe(false);
      expect(existsSync(join(src, "ports.ts")), src).toBe(false);
    }
  });

  it("defines none of macosProfile, isAllowedTarget or installGuard in an adapter", () => {
    const defs: string[] = [];
    for (const src of srcs) {
      for (const file of walk(src)) {
        const text = readFileSync(file, "utf8");
        if (/(function|const)\s+(macosProfile|isAllowedTarget|installGuard)\b/.test(text))
          defs.push(file);
      }
    }
    expect(defs).toEqual([]);
  });

  it("no adapter src file uses the test-only switches (D1)", () => {
    for (const src of srcs) {
      for (const file of walk(src)) {
        expect(readFileSync(file, "utf8"), file).not.toMatch(
          /TEST_ONLY|sandbox\/testing|skipPreflight|test-only|Symbol\.for\(/,
        );
      }
    }
  });

  it("a look-alike Symbol.for key is ignored and the preflight still runs (D1)", () => {
    const forged = Symbol.for("x402-redteam.sandbox.test-only");
    const opts = {
      label: "x",
      script: "/s.ts",
      loader: "/nowhere/tsx/loader.mjs",
      guardEntry: "/nowhere/src/guard.ts",
      [forged]: { skipPreflight: true, deniedRoot: "/tmp" },
    } as unknown as SpawnOptions;
    expect(testOnlyOf(opts)).toBeUndefined();
    expect(testOnlyOf({ ...opts, [TEST_ONLY]: { skipPreflight: true } })?.skipPreflight).toBe(true);
    if (detectSandbox() !== "none") expect(() => spawnSandboxed(opts)).toThrow(/loader/);
  });

  it("each adapter links the shared package", () => {
    for (const src of srcs) {
      const manifest = JSON.parse(readFileSync(join(src, "..", "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      expect(manifest.dependencies["@x402-redteam/sandbox"], src).toMatch(
        /^link:.*packages\/sandbox$/,
      );
    }
  });
});
