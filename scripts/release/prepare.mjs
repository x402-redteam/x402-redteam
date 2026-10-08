#!/usr/bin/env node
// pnpm release:prepare X.Y.Z (ADR-021 §4).
//
// On a clean main that matches origin/main (after fetching tags): writes X.Y.Z into every
// package.json, adds the X.Y.Z section to CHANGELOG.md from the Conventional Commits since
// the last vX.Y.Z tag (or since the root commit), creates branch release/vX.Y.Z, commits
// "chore(release): vX.Y.Z" and prints the commands that open the release PR. Any failure
// restores the working tree. It never pushes.
//
// A CHANGELOG.md section written by hand for X.Y.Z is kept as it is.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hasSection, prependSection, renderSection } from "./changelog.mjs";
import { assertReleaseVersion, REPO_ROOT, syncVersions } from "./version.mjs";

const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * Parses `git log --format=%H%x1f%s%x1f%b%x1e` output.
 * @param {string} output
 * @returns {{ sha: string, subject: string, body: string }[]}
 */
export function parseGitLog(output) {
  return output
    .split(RECORD)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [sha = "", subject = "", body = ""] = r.split(FIELD);
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
    });
}

/** @param {string} cwd */
function defaultGit(cwd) {
  /** @param {string[]} args */
  return (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * @param {{ root?: string, version: string, date?: string, git?: (args: string[]) => string }} opts
 * @returns {{ branch: string, range: string, generated: boolean, commands: string[] }}
 */
export function prepare(opts) {
  const root = opts.root ?? REPO_ROOT;
  const version = opts.version;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const git = opts.git ?? defaultGit(root);
  assertReleaseVersion(version);

  if (git(["status", "--porcelain"]).trim() !== "") {
    throw new Error("the working tree has uncommitted changes; commit or stash them first");
  }
  git(["fetch", "--tags", "origin"]);
  if (git(["rev-parse", "--abbrev-ref", "HEAD"]).trim() !== "main") {
    throw new Error("release:prepare runs on main; switch to main first");
  }
  if (git(["rev-parse", "HEAD"]).trim() !== git(["rev-parse", "origin/main"]).trim()) {
    throw new Error("main is not at origin/main; pull or reset it first");
  }
  const tag = `v${version}`;
  if (git(["tag", "--list", tag]).trim() !== "") throw new Error(`tag ${tag} already exists`);

  let lastTag = "";
  try {
    lastTag = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*"]).trim();
  } catch {
    lastTag = "";
  }
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const branch = `release/${tag}`;
  const subject = `chore(release): ${tag}`;
  const changelogPath = join(root, "CHANGELOG.md");

  // Files are edited on main's working tree first and the branch is created last, so any
  // failure is undone by restoring the working tree (and leaving the branch if it exists).
  let generated = false;
  let switched = false;
  try {
    const files = syncVersions(root, version);
    const changelog = readFileSync(changelogPath, "utf8");
    generated = !hasSection(changelog, version);
    if (generated) {
      const commits = parseGitLog(git(["log", "--format=%H%x1f%s%x1f%b%x1e", range]));
      writeFileSync(
        changelogPath,
        prependSection(changelog, renderSection(commits, version, date)),
      );
    }
    git(["switch", "-c", branch]);
    switched = true;
    git(["add", ...files, "CHANGELOG.md"]);
    git(["commit", "-m", subject]);
  } catch (err) {
    git(["reset", "--hard", "--quiet", "HEAD"]);
    if (switched) {
      git(["switch", "main"]);
      git(["branch", "-D", branch]);
    }
    throw err;
  }

  return {
    branch,
    range,
    generated,
    commands: [
      `git push -u origin ${branch}`,
      `gh pr create --base main --head ${branch} --title "${subject}" --body-file <(node scripts/release/notes.mjs ${version})`,
    ],
  };
}

/** @param {string[]} argv */
function main(argv) {
  const version = argv[0];
  if (!version) {
    console.error("usage: pnpm release:prepare X.Y.Z");
    return 2;
  }
  try {
    const result = prepare({ version });
    console.log(`Committed ${result.branch}.`);
    console.log(
      result.generated
        ? `CHANGELOG.md: generated the ${version} section from ${result.range}. Review and edit it before opening the PR.`
        : `CHANGELOG.md: kept the existing ${version} section.`,
    );
    console.log(
      "\nOpen the release PR (squash-merge it so the subject stays the release subject):",
    );
    for (const c of result.commands) console.log(`  ${c}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
