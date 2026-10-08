import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, isReleaseCommit, looksLikeRelease } from "../release/detect.mjs";
import { REPO_ROOT } from "../release/version.mjs";

describe("isReleaseCommit", () => {
  it.each([
    ["chore(release): v0.1.0", "0.1.0", true],
    ["chore(release): v0.1.0 (#12)", "0.1.0", true],
    ["chore(release): v0.1.0", "0.1.1", false],
    ["chore(release): v0.1.01", "0.1.0", false],
    ["chore(release): v0x1x0", "0.1.0", false],
    ["chore(release): v0.1.0 and more", "0.1.0", false],
    ["chore: release", "0.1.0", false],
    ["chore: release v0.1.0", "0.1.0", false],
    ["chore(release): v0.1.0-dev", "0.1.0-dev", false],
    ["chore(release): v1.0.0-rc.1", "1.0.0-rc.1", false],
    ["chore(release): v1.0", "1.0", false],
  ])("%j for %s -> %s", (subject, version, expected) => {
    expect(isReleaseCommit(subject, version)).toBe(expected);
  });

  it("looksLikeRelease flags any release-prefixed subject", () => {
    expect(looksLikeRelease("chore(release): v9.9.9")).toBe(true);
    expect(looksLikeRelease("feat: x")).toBe(false);
  });
});

describe("decide", () => {
  it("releases only for a MAJOR.MINOR.PATCH version that matches the subject", () => {
    expect(decide("chore(release): v0.1.0 (#3)", "0.1.0")).toEqual({ release: true, error: null });
    expect(decide("feat: x", "0.1.0-dev")).toEqual({ release: false, error: null });
  });

  it.each([
    ["chore(release): v0.1.0-dev", "0.1.0-dev"],
    ["chore(release): v1.0.0-rc.1", "1.0.0-rc.1"],
    ["chore(release): v0.2.0", "0.1.0"],
  ])("errors on %j with package.json %s", (subject, version) => {
    const result = decide(subject, version);
    expect(result.release).toBe(false);
    expect(result.error).toMatch(/MAJOR\.MINOR\.PATCH/);
  });
});

describe("detect.mjs CLI", () => {
  const script = join(REPO_ROOT, "scripts/release/detect.mjs");
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
  const run = (subject: string) =>
    execFileSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? "", COMMIT_SUBJECT: subject },
      encoding: "utf8",
    });

  it("reports a non-release commit", () => {
    expect(run("feat: x")).toBe(`release=false\nversion=${version}\n`);
  });

  it("treats the package.json version as a release only when it is MAJOR.MINOR.PATCH", () => {
    const subject = `chore(release): v${version} (#3)`;
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      expect(run(subject)).toBe(`release=true\nversion=${version}\n`);
    } else {
      expect(() => run(subject)).toThrow();
    }
  });

  it("fails on a release subject whose version differs from package.json", () => {
    expect(() => run("chore(release): v99.0.0")).toThrow();
  });
});
