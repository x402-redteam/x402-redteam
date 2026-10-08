import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertReleaseVersion,
  checkVersions,
  packageFiles,
  REPO_ROOT,
  setVersionInText,
  syncVersions,
} from "../release/version.mjs";

function pkg(name: string, version: string): string {
  return `${JSON.stringify({ name, version, private: true, type: "module" }, null, 2)}\n`;
}

describe("assertReleaseVersion", () => {
  it.each(["0.1.0", "1.0.0", "10.20.30"])("accepts %s", (v) => {
    expect(() => assertReleaseVersion(v)).not.toThrow();
  });

  it.each(["v1.0.0", "1.0", "1.0.0-rc.1", "1.0.0+build", "", " 1.0.0"])("rejects %j", (v) => {
    expect(() => assertReleaseVersion(v)).toThrow(/MAJOR\.MINOR\.PATCH/);
  });
});

describe("setVersionInText", () => {
  it("replaces only the top-level version value", () => {
    const text = `{\n  "name": "a",\n  "version": "0.0.1",\n  "dependencies": {\n    "b": "0.0.1"\n  }\n}\n`;
    expect(setVersionInText(text, "0.2.0")).toBe(
      text.replace('"version": "0.0.1"', '"version": "0.2.0"'),
    );
  });

  it("adds version after name when it is missing", () => {
    const text = `{\n  "name": "a",\n  "private": true\n}\n`;
    expect(setVersionInText(text, "0.2.0")).toBe(
      `{\n  "name": "a",\n  "version": "0.2.0",\n  "private": true\n}\n`,
    );
  });
});

describe("syncVersions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "x402-release-version-"));
    writeFileSync(join(root, "package.json"), pkg("root", "0.1.0-dev"));
    for (const dir of ["packages/a", "packages/b", "examples/c"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), pkg(dir, "0.0.1"));
    }
    mkdirSync(join(root, "packages/not-a-package"), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists the root package.json first, then each workspace package", () => {
    expect(packageFiles(root)).toEqual([
      "package.json",
      "packages/a/package.json",
      "packages/b/package.json",
      "examples/c/package.json",
    ]);
  });

  it("writes the same version into every package.json and keeps private: true", () => {
    const written = syncVersions(root, "0.1.0");
    expect(written).toHaveLength(4);
    for (const file of written) {
      const parsed = JSON.parse(readFileSync(join(root, file), "utf8"));
      expect(parsed.version, file).toBe("0.1.0");
      expect(parsed.private, file).toBe(true);
    }
    expect(checkVersions(root)).toEqual({ version: "0.1.0", mismatched: [] });
  });

  it.each(["v1.0.0", "1.0", "1.0.0-rc.1"])("rejects %s and writes nothing", (v) => {
    expect(() => syncVersions(root, v)).toThrow();
    expect(JSON.parse(readFileSync(join(root, "packages/a/package.json"), "utf8")).version).toBe(
      "0.0.1",
    );
  });

  it("checkVersions reports every package that differs from the root", () => {
    expect(checkVersions(root).mismatched.map((m) => m.file)).toEqual([
      "packages/a/package.json",
      "packages/b/package.json",
      "examples/c/package.json",
    ]);
  });
});

describe("repository versions", () => {
  it("every package.json carries the root version", () => {
    const { version, mismatched } = checkVersions(REPO_ROOT);
    expect(version).toMatch(/^\d+\.\d+\.\d+(-dev)?$/);
    expect(mismatched).toEqual([]);
  });
});
