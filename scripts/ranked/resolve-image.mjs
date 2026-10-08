#!/usr/bin/env node
// Resolves the ranked image digest for a harness release from results/_harness.json
// (ADR-023). rank.yml and ranked-run.yml call it before pulling the image by digest.
//
// _harness.json: {"allow": [{"commit": "<40 hex>", "version": "vX.Y.Z", "image": "sha256:<64 hex>"}, ...]}.
// Plain commit strings are still valid for the leaderboard reader, but a ranked run needs
// the object form, because only it names an image.
//
// CLI (environment only, no arguments):
//   HARNESS_JSON     path to _harness.json
//   HARNESS_REF      the requested harness ref: a vX.Y.Z tag or a 40-hex commit
//   HARNESS_COMMIT   the commit the workflow checked out; the resolved entry must name it
// Prints the digest (sha256:...) on stdout and exits 0, or prints a ::error:: line and
// exits 2. No dependencies, so it runs on the runner's own node.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Looks up `ref` (a vX.Y.Z tag or a 40-hex commit) in a parsed `_harness.json`.
 * Returns `{ ok: true, digest, commit, version }` for exactly one well-formed object
 * entry, or `{ ok: false, error }` otherwise.
 */
export function resolveImage(harnessJson, ref) {
  if (typeof ref !== "string" || !(VERSION.test(ref) || COMMIT.test(ref))) {
    return {
      ok: false,
      error: `harness ref ${JSON.stringify(ref)} is not a vX.Y.Z tag or a 40-hex commit`,
    };
  }
  const allow = harnessJson?.allow;
  if (!Array.isArray(allow)) {
    return { ok: false, error: '_harness.json must be shaped like {"allow": [...]}' };
  }
  const field = VERSION.test(ref) ? "version" : "commit";
  if (allow.some((entry) => entry === ref)) {
    return {
      ok: false,
      error: `_harness.json lists ${ref} as a plain string; ranked runs need an object entry {"commit", "version", "image"}`,
    };
  }
  const matches = allow.filter(
    (entry) => typeof entry === "object" && entry !== null && entry[field] === ref,
  );
  if (matches.length === 0) {
    return { ok: false, error: `no _harness.json entry has ${field} ${ref}` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `${matches.length} _harness.json entries have ${field} ${ref}` };
  }
  const { commit, version, image } = matches[0];
  if (typeof commit !== "string" || !COMMIT.test(commit)) {
    return { ok: false, error: `_harness.json entry for ${ref} has a malformed commit` };
  }
  if (typeof version !== "string" || !VERSION.test(version)) {
    return { ok: false, error: `_harness.json entry for ${ref} has a malformed version` };
  }
  if (typeof image !== "string" || !DIGEST.test(image)) {
    return { ok: false, error: `_harness.json entry for ${ref} has a malformed image digest` };
  }
  return { ok: true, digest: image, commit, version };
}

/** Runs the CLI against `env`; returns `{ status, stdout, stderr }` without exiting. */
export function main(env) {
  const fail = (message) => ({ status: 2, stdout: "", stderr: `::error::${message}\n` });
  if (!env.HARNESS_JSON) return fail("HARNESS_JSON is not set");
  if (!env.HARNESS_COMMIT || !COMMIT.test(env.HARNESS_COMMIT)) {
    return fail("HARNESS_COMMIT is not a 40-hex commit");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(env.HARNESS_JSON, "utf8"));
  } catch (err) {
    return fail(
      `cannot read ${env.HARNESS_JSON}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = resolveImage(parsed, env.HARNESS_REF);
  if (!result.ok) return fail(result.error);
  if (result.commit !== env.HARNESS_COMMIT) {
    return fail(
      `_harness.json maps ${env.HARNESS_REF} to commit ${result.commit}, but the checked-out harness is ${env.HARNESS_COMMIT}`,
    );
  }
  return { status: 0, stdout: `${result.digest}\n`, stderr: "" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { status, stdout, stderr } = main(process.env);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exit(status);
}
