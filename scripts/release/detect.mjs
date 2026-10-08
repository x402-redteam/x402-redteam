#!/usr/bin/env node
// Decides whether a commit on main is a release commit (ADR-021 §4), for release.yml.
//
// A release commit is the squash merge of the release PR: its subject is
// "chore(release): vX.Y.Z", optionally followed by GitHub's " (#123)" PR suffix, and X.Y.Z
// equals the root package.json version, which must be a plain MAJOR.MINOR.PATCH.
//
// CLI: reads the subject from $COMMIT_SUBJECT and writes `release=true|false` and
// `version=X.Y.Z` to $GITHUB_OUTPUT (or stdout). Exits 1 when the subject names a release
// whose version differs from package.json or is not MAJOR.MINOR.PATCH.

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./version.mjs";

export const RELEASE_PREFIX = "chore(release): v";

/** @param {string} version */
function escapeRegExp(version) {
  return version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `subject` is the release commit subject for `version`.
 * @param {string} subject
 * @param {string} version  MAJOR.MINOR.PATCH, no "v"
 */
export function isReleaseCommit(subject, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const re = new RegExp(`^chore\\(release\\): v${escapeRegExp(version)}(?: \\(#\\d+\\))?$`);
  return re.test(subject.trim());
}

/**
 * True when `subject` claims to be a release commit for any version.
 * @param {string} subject
 */
export function looksLikeRelease(subject) {
  return subject.trim().startsWith(RELEASE_PREFIX);
}

/** @param {string[]} lines */
function emit(lines) {
  const text = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

/**
 * The decision for one commit: a release, not a release, or an error for a subject that
 * claims a release the package.json version doesn't support.
 * @param {string} subject
 * @param {string} version  the root package.json version
 * @returns {{ release: boolean, error: string | null }}
 */
export function decide(subject, version) {
  if (isReleaseCommit(subject, version)) return { release: true, error: null };
  if (looksLikeRelease(subject)) {
    return {
      release: false,
      error: `"${subject}" looks like a release commit but package.json has version ${version} (a release needs MAJOR.MINOR.PATCH matching the subject)`,
    };
  }
  return { release: false, error: null };
}

function main() {
  const subject = process.env.COMMIT_SUBJECT ?? "";
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
  const { release, error } = decide(subject, version);
  if (error) {
    console.error(error);
    return 1;
  }
  emit([`release=${release}`, `version=${version}`]);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
