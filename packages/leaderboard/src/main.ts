/**
 * `pnpm leaderboard`: reads every committed `results/*.json` report (never
 * `results/internal/**`, which isn't a `.json` file at the top level of `results/` —
 * see `load-results.ts`) plus `results/_meta.json`, derives the current corpus's hash
 * and scenario set from `corpus/` for the acceptance checks and re-score in
 * `build-leaderboard.ts` §3, and writes `LEADERBOARD.md` at the repo root. Run from the
 * repo root (the root `leaderboard` script does this).
 *
 * ADR-011 (U19) provenance: by default this reads whatever `results/_verified.json`
 * already says (`{}` if it doesn't exist - every guardrail-track entry is then Tier 3,
 * self-reported, rejected) and never makes a network call, per CLAUDE.md ("no network
 * calls from `pnpm leaderboard` or any unit test"). Passing `--verify-attestations`
 * additionally re-derives `results/_verified.json` first, by actually calling `gh
 * attestation verify` against each committed result's sibling `<id>.attestation.jsonl`
 * bundle - a separate, explicit, networked step a maintainer runs by hand (or a
 * dedicated CI job), never part of the default `pnpm leaderboard` invocation CI's own
 * diff-check runs.
 */
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCorpus } from "@x402-redteam/schema";
import { buildLeaderboard } from "./build-leaderboard.js";
import {
  loadHarnessAllowlist,
  loadResultsDir,
  loadResultsMeta,
  loadSeasonRecords,
  loadVerifiedMap,
  type RawResultEntry,
  type ResultsMeta,
} from "./load-results.js";
import {
  type AttestationCheckParams,
  buildGhAttestationVerifyArgs,
  type ProvenanceVerifier,
  type VerifyCandidate,
  verifyEntries,
} from "./provenance.js";

/** The real, networked verifier `--verify-attestations` uses - never called from this
 * module's own default path, and never from a unit test (tests inject a stub into
 * `verifyEntries` directly instead of going through this file at all). Security review
 * HIGH-6: the argv itself is built by the pure, independently-tested
 * `buildGhAttestationVerifyArgs` - this function does nothing but pass it to
 * `execFile`. */
const ghAttestationVerifier: ProvenanceVerifier = (params: AttestationCheckParams) =>
  new Promise((resolvePromise) => {
    let args: string[];
    try {
      args = buildGhAttestationVerifyArgs(params);
    } catch {
      resolvePromise(false);
      return;
    }
    execFile("gh", args, (err) => resolvePromise(err === null));
  });

/** `results/<id>.json`'s sibling attestation bundle - the convention documented in
 * CONTRIBUTING.md, downloaded by a maintainer (Tier 1) or fetched from the submitter's
 * workflow run (Tier 2) before `--verify-attestations` is run. */
function bundlePathFor(resultsDir: string, id: string): string {
  return resolve(resultsDir, `${id}.attestation.jsonl`);
}

function schemaOf(data: unknown): string | undefined {
  return typeof data === "object" && data !== null
    ? ((data as { schema?: unknown }).schema as string | undefined)
    : undefined;
}

/**
 * Builds the verify candidates from whatever's committed: a `report@3-redacted` entry
 * is a Tier 1 candidate, a `report@3` entry a Tier 2 one - only when its bundle file
 * actually exists; an entry with no bundle simply isn't a candidate, and
 * `verifyEntries` only writes a map entry when `gh attestation verify` actually
 * succeeds (a failure, or no candidate at all, leaves that id absent -> Tier 3).
 * Security review HIGH-5: `entry.sha256` (already computed by `loadResultsDir`) becomes
 * the recorded `subject_sha256` once verified. Security review HIGH-6: a Tier 2
 * candidate additionally needs `results/_meta.json`'s `owner` (the submitter's GitHub
 * login) for `--owner` - `verifyEntries` itself skips any tier 2 candidate missing one.
 */
/**
 * Security re-review finding 3c/6: the signer's own published certificate digest,
 * once resolved - unset (`undefined`) until then, in which case
 * `buildGhAttestationVerifyArgs` simply omits `--signer-digest` and `gh attestation
 * verify` still enforces signer-workflow (+ --repo/--source-ref for Tier 1,
 * +--owner for Tier 2) on its own. Read from an env var, not hardcoded, so it can be
 * populated at verify time (by whoever runs `--verify-attestations`) without a code
 * change once a real digest is known - this harness has no network access to resolve
 * one itself.
 */
function signerDigest(): string | undefined {
  return process.env.X402_SIGNER_DIGEST || undefined;
}

function buildVerifyCandidates(
  entries: RawResultEntry[],
  resultsDir: string,
  meta: ResultsMeta,
): VerifyCandidate[] {
  const candidates: VerifyCandidate[] = [];
  const digest = signerDigest();
  for (const entry of entries) {
    const bundlePath = bundlePathFor(resultsDir, entry.id);
    if (!existsSync(bundlePath)) continue;
    const resultPath = resolve(resultsDir, `${entry.id}.json`);
    const schema = schemaOf(entry.data);
    if (schema === "x402-redteam/report@3-redacted") {
      candidates.push({
        id: entry.id,
        resultPath,
        bundlePath,
        tier: 1,
        contentHash: entry.sha256,
        signerDigest: digest,
      });
    } else if (schema === "x402-redteam/report@3") {
      candidates.push({
        id: entry.id,
        resultPath,
        bundlePath,
        tier: 2,
        submitterOwner: meta[entry.id]?.owner,
        contentHash: entry.sha256,
        signerDigest: digest,
      });
    }
  }
  return candidates;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const resultsDir = resolve(root, "results");
  const corpusDir = resolve(root, "corpus");

  const entries = loadResultsDir(resultsDir);
  const meta = loadResultsMeta(resultsDir);
  const harnessAllowlist = loadHarnessAllowlist(resultsDir);
  const seasonRecords = loadSeasonRecords(resultsDir);
  const scenarios = loadCorpus(corpusDir);

  let verified = loadVerifiedMap(resultsDir);
  if (process.argv.includes("--verify-attestations")) {
    const candidates = buildVerifyCandidates(entries, resultsDir, meta);
    verified = await verifyEntries(candidates, ghAttestationVerifier);
    writeFileSync(resolve(resultsDir, "_verified.json"), `${JSON.stringify(verified, null, 2)}\n`);
  }

  const { markdown, ranked, guardrails, agents, reference, stale, rejected } = buildLeaderboard(
    entries,
    scenarios,
    meta,
    harnessAllowlist,
    verified,
    seasonRecords,
  );
  writeFileSync(resolve(root, "LEADERBOARD.md"), markdown);

  console.log(
    `Wrote LEADERBOARD.md: ${ranked.length} ranked (Tier 1), ${guardrails.length} verified ` +
      `(Tier 2), ${agents.length} agent-track, ${reference.length} reference, ${stale.length} ` +
      `stale, ${rejected.length} rejected`,
  );
}

await main();
