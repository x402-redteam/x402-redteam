#!/usr/bin/env node
// Local fuzz-privacy guard (U29-00, ADR-028 #7), run by the pre-commit and pre-push hooks
// next to the held-out guard (ADR-027). Unlike that guard it needs no local denylist, so it
// always runs. It refuses:
//   1. a file under a fuzz output path: a `fuzz-out/` directory or any `*.fuzz/` directory;
//   2. a .yaml, .yml, .json or .jsonl file whose `technique` starts with `fuzz:`, anywhere
//      outside the public smoke catalogue, packages/fuzz/catalogue-public/;
//   3. any .yaml, .yml, .json, .jsonl or .md file that carries the private marker (stamped
//      by the generator and `diff` on every output, so an output written to an arbitrary
//      `--out` directory is caught), outside the public smoke catalogue.
// Fuzz families, seeds, outputs and triage results stay private until their first triage
// closes (private catalogue: ~/x402-redteam-private/fuzz/catalogue/). It prints paths only,
// never file contents.
//
// Modes: (default) staged files; --pre-push: commits about to be pushed, refs on stdin.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The only place a scenario with a `fuzz:` technique may be committed. */
export const PUBLIC_CATALOGUE = "packages/fuzz/catalogue-public/";

const OUTPUT_DIR_RE = /(?:^|\/)(?:fuzz-out|[^/]*\.fuzz)\//;
const SCENARIO_EXT_RE = /\.(?:ya?ml|jsonl?)$/i;
const MARKED_EXT_RE = /\.(?:ya?ml|jsonl?|md)$/i;

/** Same value as FUZZ_PRIVATE_MARKER in packages/schema/src/fuzz-private.ts (a test checks). */
export const FUZZ_PRIVATE_MARKER = "x402_redteam_fuzz_private";
// Errs towards refusing: also matches the key mid-line (inline JSON or YAML flow style).
const FUZZ_TECHNIQUE_RE = /(?:^|[\s{,])["']?technique["']?\s*:\s*["']?fuzz:/m;

/** True when `path` is under a fuzz output location. */
export function isFuzzOutputPath(path) {
  return OUTPUT_DIR_RE.test(path);
}

/** True when `path` is inside the public smoke catalogue. */
export function isPublicCataloguePath(path) {
  return path.startsWith(PUBLIC_CATALOGUE);
}

/** True when scenario text declares a `fuzz:` technique. */
export function hasFuzzTechnique(text) {
  return FUZZ_TECHNIQUE_RE.test(text);
}

/**
 * Violations for one added or changed file. `read` returns its text and is only called for
 * scenario-shaped files outside the public catalogue.
 * @param {string} path
 * @param {() => string} read
 * @returns {string[]}
 */
export function violationsFor(path, read) {
  if (isFuzzOutputPath(path)) return [`${path}: fuzz output path`];
  if (isPublicCataloguePath(path)) return [];
  if (MARKED_EXT_RE.test(path)) {
    const text = read();
    if (text.includes(FUZZ_PRIVATE_MARKER)) return [`${path}: carries the fuzz private marker`];
    if (SCENARIO_EXT_RE.test(path) && hasFuzzTechnique(text)) {
      return [`${path}: fuzz: technique outside ${PUBLIC_CATALOGUE}`];
    }
  }
  return [];
}

function git(args) {
  return execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024 });
}

const nulList = (buf) => buf.toString("utf8").split("\0").filter(Boolean);

function scanStaged() {
  const hits = [];
  for (const name of nulList(
    git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]),
  )) {
    hits.push(...violationsFor(name, () => git(["show", `:${name}`]).toString("utf8")));
  }
  return hits;
}

function scanPrePush(stdin) {
  const hits = [];
  for (const ref of stdin.split("\n").filter(Boolean)) {
    const [, localSha, , remoteSha] = ref.split(" ");
    if (!localSha || /^0+$/.test(localSha)) continue;
    const range =
      !remoteSha || /^0+$/.test(remoteSha)
        ? [localSha, "--not", "--remotes"]
        : [`${remoteSha}..${localSha}`];
    for (const sha of git(["rev-list", ...range])
      .toString("utf8")
      .split("\n")
      .filter(Boolean)) {
      const names = nulList(
        git([
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-only",
          "-r",
          "--diff-filter=ACMR",
          "-z",
          sha,
        ]),
      );
      for (const name of names) {
        hits.push(
          ...violationsFor(name, () => git(["show", `${sha}:${name}`]).toString("utf8")).map(
            (h) => `${sha.slice(0, 7)} ${h}`,
          ),
        );
      }
    }
  }
  return hits;
}

function main(argv) {
  const hits = argv.includes("--pre-push") ? scanPrePush(readFileSync(0, "utf8")) : scanStaged();
  if (hits.length === 0) return 0;
  console.error(`fuzz guard: ${hits.length} file(s) must stay private (ADR-028 #7):`);
  for (const h of hits) console.error(`  ${h}`);
  console.error(
    "Fuzz outputs, families and seeds stay out of the repo until their first triage closes.",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
