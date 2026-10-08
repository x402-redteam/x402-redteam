#!/usr/bin/env node
// One version for the whole repository (ADR-021 §1). The root package.json holds it;
// every workspace package.json carries the same value in its "version" field.
//
//   node scripts/release/version.mjs X.Y.Z    writes X.Y.Z into every package.json
//   node scripts/release/version.mjs --check  exits 1 unless every package.json matches the root

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const WORKSPACE_DIRS = ["packages", "examples"];

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Accepts MAJOR.MINOR.PATCH only: no "v" prefix and no pre-release or build suffix.
 * @param {string} version
 */
export function assertReleaseVersion(version) {
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `version must be MAJOR.MINOR.PATCH with no "v" prefix or suffix, got "${version}"`,
    );
  }
}

/**
 * The root package.json followed by every packages/* and examples/* package.json, as
 * repo-relative paths in sorted order.
 * @param {string} root
 * @returns {string[]}
 */
export function packageFiles(root) {
  const files = ["package.json"];
  for (const dir of WORKSPACE_DIRS) {
    let entries;
    try {
      entries = readdirSync(join(root, dir)).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      const rel = `${dir}/${name}/package.json`;
      try {
        if (statSync(join(root, rel)).isFile()) files.push(rel);
      } catch {
        // not a package directory
      }
    }
  }
  return files;
}

/**
 * Replaces the top-level "version" value in package.json text and leaves every other byte
 * unchanged. Adds "version" after "name" when the file has none.
 * @param {string} text
 * @param {string} version
 */
export function setVersionInText(text, version) {
  const pkg = JSON.parse(text);
  if (typeof pkg.version === "string") {
    const re = /^( {2}"version":\s*")[^"]*(")/m;
    if (!re.test(text)) throw new Error('"version" is not a top-level key on its own line');
    return text.replace(re, `$1${version}$2`);
  }
  const nameRe = /^( {2}"name":\s*"[^"]*",\n)/m;
  if (!nameRe.test(text)) throw new Error('no top-level "name" line to place "version" after');
  return text.replace(nameRe, `$1  "version": "${version}",\n`);
}

/**
 * Writes `version` into every package.json under `root` and returns the files written.
 * @param {string} root
 * @param {string} version
 * @returns {string[]}
 */
export function syncVersions(root, version) {
  assertReleaseVersion(version);
  const files = packageFiles(root);
  for (const rel of files) {
    const path = join(root, rel);
    writeFileSync(path, setVersionInText(readFileSync(path, "utf8"), version));
  }
  return files;
}

/**
 * The root version and every package.json whose version differs from it.
 * @param {string} root
 * @returns {{ version: string, mismatched: { file: string, version: unknown }[] }}
 */
export function checkVersions(root) {
  const [rootFile = "package.json", ...rest] = packageFiles(root);
  const version = JSON.parse(readFileSync(join(root, rootFile), "utf8")).version;
  const mismatched = [];
  for (const rel of rest) {
    const v = JSON.parse(readFileSync(join(root, rel), "utf8")).version;
    if (v !== version) mismatched.push({ file: rel, version: v });
  }
  return { version, mismatched };
}

/** @param {string[]} argv */
function main(argv) {
  const arg = argv[0];
  if (arg === "--check") {
    const { version, mismatched } = checkVersions(REPO_ROOT);
    for (const m of mismatched) console.error(`${m.file}: ${m.version} (root: ${version})`);
    if (mismatched.length > 0) return 1;
    console.log(version);
    return 0;
  }
  if (!arg) {
    console.error("usage: version.mjs X.Y.Z | --check");
    return 2;
  }
  try {
    for (const file of syncVersions(REPO_ROOT, arg)) console.log(`${file} -> ${arg}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
