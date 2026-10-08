import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGitLog, prepare } from "../release/prepare.mjs";

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

describe("parseGitLog", () => {
  it("splits records and fields", () => {
    const out = `${"a".repeat(40)}\x1ffeat: one\x1f\x1e\n${"b".repeat(40)}\x1ffix: two\x1fline\n\nBREAKING CHANGE: x\n\x1e\n`;
    expect(parseGitLog(out)).toEqual([
      { sha: "a".repeat(40), subject: "feat: one", body: "" },
      { sha: "b".repeat(40), subject: "fix: two", body: "line\n\nBREAKING CHANGE: x" },
    ]);
  });
});

describe("prepare", () => {
  let root: string;
  let origin: string;
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: GIT_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  /** Pushes main and every tag, so main matches origin/main. */
  const publish = () => {
    git(["push", "-q", "origin", "main"]);
    git(["push", "-q", "--tags", "origin"]);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "x402-release-prepare-"));
    origin = mkdtempSync(join(tmpdir(), "x402-release-origin-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: GIT_ENV });
    git(["init", "-q", "-b", "main"]);
    git(["remote", "add", "origin", origin]);
    writeFileSync(join(root, "package.json"), '{\n  "name": "r",\n  "version": "0.1.0-dev"\n}\n');
    mkdirSync(join(root, "packages/a"), { recursive: true });
    writeFileSync(
      join(root, "packages/a/package.json"),
      '{\n  "name": "a",\n  "version": "0.1.0-dev"\n}\n',
    );
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "chore: init"]);
    git(["commit", "-q", "--allow-empty", "-m", "feat(cli): add a flag"]);
    publish();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  it("syncs versions, generates the changelog, branches and commits the release subject", () => {
    const result = prepare({ root, version: "0.2.0", date: "2026-11-01", git });
    expect(result.branch).toBe("release/v0.2.0");
    expect(result.range).toBe("HEAD");
    expect(result.generated).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("release/v0.2.0");
    expect(git(["log", "-1", "--format=%s"]).trim()).toBe("chore(release): v0.2.0");
    expect(git(["status", "--porcelain"]).trim()).toBe("");
    expect(JSON.parse(readFileSync(join(root, "packages/a/package.json"), "utf8")).version).toBe(
      "0.2.0",
    );
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## [0.2.0] - 2026-11-01");
    expect(changelog).toContain("- **cli:** add a flag");
    expect(result.commands.join("\n")).toContain('--title "chore(release): v0.2.0"');
    expect(result.commands.join("\n")).not.toMatch(/--force|tag/);
    expect(git(["ls-remote", "--heads", "origin", "release/v0.2.0"]).trim()).toBe("");
  });

  it("collects commits since the last release tag", () => {
    git(["tag", "v0.1.0"]);
    git(["commit", "-q", "--allow-empty", "-m", "fix: later"]);
    publish();
    const result = prepare({ root, version: "0.1.1", date: "2026-11-01", git });
    expect(result.range).toBe("v0.1.0..HEAD");
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("- later");
    expect(changelog).not.toContain("add a flag");
  });

  it("keeps a hand-written section for the version", () => {
    writeFileSync(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-01\n\nHand-written.\n",
    );
    git(["commit", "-q", "-am", "docs: notes"]);
    publish();
    const result = prepare({ root, version: "0.2.0", date: "2026-11-01", git });
    expect(result.generated).toBe(false);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain("Hand-written.");
  });

  it("refuses a dirty working tree", () => {
    writeFileSync(join(root, "stray.txt"), "x");
    expect(() => prepare({ root, version: "0.2.0", git })).toThrow(/uncommitted/);
  });

  it("refuses to run off main", () => {
    git(["switch", "-q", "-c", "topic"]);
    expect(() => prepare({ root, version: "0.2.0", git })).toThrow(/runs on main/);
  });

  it("refuses a main that differs from origin/main", () => {
    git(["commit", "-q", "--allow-empty", "-m", "fix: unpushed"]);
    expect(() => prepare({ root, version: "0.2.0", git })).toThrow(/origin\/main/);
  });

  it("restores the working tree and stays on main when a step fails", () => {
    rmSync(join(root, "CHANGELOG.md"));
    git(["commit", "-q", "-am", "chore: drop changelog"]);
    publish();
    expect(() => prepare({ root, version: "0.2.0", git })).toThrow(/CHANGELOG\.md/);
    expect(git(["status", "--porcelain"]).trim()).toBe("");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(git(["branch", "--list", "release/v0.2.0"]).trim()).toBe("");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.1.0-dev");
  });

  it("refuses a tag that exists only on origin, and an invalid version", () => {
    git(["tag", "v0.2.0"]);
    git(["push", "-q", "origin", "v0.2.0"]);
    git(["tag", "-d", "v0.2.0"]);
    expect(() => prepare({ root, version: "0.2.0", git })).toThrow(/already exists/);
    expect(() => prepare({ root, version: "v0.3.0", git })).toThrow(/MAJOR\.MINOR\.PATCH/);
  });
});
