#!/usr/bin/env node
// Release notes for one version: the body of its CHANGELOG.md section.
//
//   node scripts/release/notes.mjs X.Y.Z > notes.md

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./version.mjs";

/**
 * The body of the `## [version]` section (without its heading), trimmed; null when the
 * changelog has no such section.
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function extractSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body;
}

/** @param {string[]} argv */
function main(argv) {
  const version = argv[0];
  if (!version) {
    console.error("usage: notes.mjs X.Y.Z");
    return 2;
  }
  const body = extractSection(readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8"), version);
  if (body === null || body === "") {
    console.error(`CHANGELOG.md has no section for ${version}`);
    return 1;
  }
  process.stdout.write(`${body}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
