#!/usr/bin/env node
// CI held-out leak guard (ADR-027 §2), run by .github/workflows/heldout-guard.yml.
//
// Tokenises changed files (paths, contents) and the commit messages in the pushed range,
// HMAC-SHA256s each token with $HELDOUT_GUARD_KEY, and compares the digests to the list in
// .github/heldout-guard.hmac. The list reveals nothing without the key. Without the key the
// guard prints "skipped (no key)" and exits 0, which is what happens on fork PRs.
//
// A token is a run of [a-z0-9._-] (lowercased, edge punctuation trimmed). Each run is split
// into segments at ".", "_" and "-", and every contiguous sequence of up to 12 segments is
// also a token, with its original separators: "corpus/asset-swap-2_v2.yaml" yields
// "asset-swap-2" among others.
//
// The key must be at least 32 bytes; create one with `openssl rand -hex 32`.
//
// Generate the list with the same rules:
//   HELDOUT_GUARD_KEY=... node scripts/heldout-guard-ci.mjs --generate [--pad N] < terms.txt
// --generate takes held-out corpus tokens ONLY (scenario ids, hosts, distinctive words).
// Never feed it personal data such as account numbers: those belong only in the local,
// uncommitted history-rewrite list. Terms that are not a single token (e.g. contain spaces)
// cannot be matched and are counted on stderr. --pad N adds N random digests so the list
// length does not reveal the number of terms.
//
// Usage:
//   node scripts/heldout-guard-ci.mjs --base <sha> [--hmac-file <path>]
//   node scripts/heldout-guard-ci.mjs [--hmac-file <path>] <file>...
// On a match it prints locations only (file and line number; a matching path is withheld)
// and exits 1.

import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HMAC_FILE = fileURLToPath(new URL("../.github/heldout-guard.hmac", import.meta.url));
const TOKEN_RE = /[a-z0-9][a-z0-9._-]*/g;
const SINGLE_TOKEN_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
const MAX_SEGMENTS = 12;
export const MIN_KEY_BYTES = 32;

/** Distinct tokens of one line of text. @param {string} text */
export function tokens(text) {
  const out = new Set();
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const run = m[0].replace(/[._-]+$/, "");
    if (!run) continue;
    out.add(run);
    // parts alternates segment, separator, segment, ...
    const parts = run.split(/([._-]+)/);
    const segments = (parts.length + 1) / 2;
    for (let i = 0; i < segments; i++) {
      let token = parts[2 * i];
      out.add(token);
      for (let j = i + 1; j < Math.min(segments, i + MAX_SEGMENTS); j++) {
        token += parts[2 * j - 1] + parts[2 * j];
        out.add(token);
      }
    }
  }
  return out;
}

export function hmacToken(key, token) {
  return createHmac("sha256", key).update(token).digest("hex");
}

/** @param {string} text */
export function parseHmacList(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => /^[0-9a-f]{64}$/.test(l)),
  );
}

/** 1-based line numbers of `text` holding a token whose HMAC is in `list`. */
export function matchingLines(text, key, list) {
  if (list.size === 0) return [];
  const lines = [];
  text.split("\n").forEach((line, i) => {
    for (const t of tokens(line)) {
      if (list.has(hmacToken(key, t))) {
        lines.push(i + 1);
        return;
      }
    }
  });
  return lines;
}

/** Sorted, de-duplicated HMAC list for the given terms. */
export function generateList(key, terms, pad = 0) {
  const digests = new Set();
  let skipped = 0;
  for (const raw of terms) {
    const term = raw.trim().toLowerCase();
    if (term === "" || term.startsWith("#")) continue;
    if (!SINGLE_TOKEN_RE.test(term)) {
      skipped++;
      continue;
    }
    digests.add(hmacToken(key, term));
  }
  for (let i = 0; i < pad; i++) digests.add(randomBytes(32).toString("hex"));
  return { digests: [...digests].sort(), skipped };
}

function git(args) {
  return execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024 });
}

function commitExists(sha) {
  if (!sha || /^0+$/.test(sha)) return false;
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function collectTargets(argv) {
  const baseIdx = argv.indexOf("--base");
  if (baseIdx < 0) {
    const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--hmac-file");
    return { files, messages: [] };
  }
  const base = argv[baseIdx + 1];
  const split = (buf) => buf.toString("utf8").split("\0").filter(Boolean);
  if (!commitExists(base)) {
    // No usable base (first push of a branch, or a force-push): scan every tracked file.
    const head = git(["rev-parse", "HEAD"]).toString("utf8").trim();
    return { files: split(git(["ls-files", "-z"])), messages: [head] };
  }
  return {
    files: split(git(["diff", "--name-only", "--diff-filter=ACMR", "-z", base, "HEAD"])),
    messages: git(["rev-list", `${base}..HEAD`])
      .toString("utf8")
      .split("\n")
      .filter(Boolean),
  };
}

function main(argv, env) {
  const key = env.HELDOUT_GUARD_KEY;
  if (!key) {
    console.log("held-out guard: skipped (no key)");
    return 0;
  }
  if (Buffer.byteLength(key, "utf8") < MIN_KEY_BYTES) {
    console.error(
      `held-out guard: HELDOUT_GUARD_KEY must be at least ${MIN_KEY_BYTES} bytes (openssl rand -hex 32)`,
    );
    return 2;
  }

  if (argv.includes("--generate")) {
    const padIdx = argv.indexOf("--pad");
    const pad = padIdx >= 0 ? Number.parseInt(argv[padIdx + 1] ?? "0", 10) || 0 : 0;
    const terms = readFileSync(0, "utf8").split(/\r?\n/);
    const { digests, skipped } = generateList(key, terms, pad);
    for (const d of digests) console.log(d);
    if (skipped > 0) console.error(`held-out guard: ${skipped} multi-token term(s) skipped`);
    return 0;
  }

  const hmacIdx = argv.indexOf("--hmac-file");
  const list = parseHmacList(
    readFileSync(hmacIdx >= 0 ? argv[hmacIdx + 1] : DEFAULT_HMAC_FILE, "utf8"),
  );
  const { files, messages } = collectTargets(argv);
  const hits = [];
  for (const file of files) {
    const pathMatches = matchingLines(file, key, list).length > 0;
    const shown = pathMatches ? "(file path withheld)" : file;
    if (pathMatches) hits.push(shown);
    const buf = readFileSync(file);
    if (buf.includes(0)) continue;
    for (const line of matchingLines(buf.toString("utf8"), key, list)) {
      hits.push(`${shown}:${line}`);
    }
  }
  for (const sha of messages) {
    const message = git(["log", "-1", "--format=%B", sha]).toString("utf8");
    for (const line of matchingLines(message, key, list)) {
      hits.push(`commit ${sha.slice(0, 7)} message:${line}`);
    }
  }

  console.log(
    `held-out guard: scanned ${files.length} file(s), ${messages.length} commit message(s)`,
  );
  if (hits.length === 0) return 0;
  console.log(`held-out guard: ${hits.length} location(s) match the held-out list:`);
  for (const h of hits) console.log(`  ${h}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2), process.env));
}
