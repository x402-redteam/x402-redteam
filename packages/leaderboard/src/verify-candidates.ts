import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RawResultEntry, ResultsMeta } from "./load-results.js";
import type { VerifyCandidate } from "./provenance.js";

/** Only the current schemas are verified: a `report@3*` result is "Superseded schema"
 * (U36-b), never ranked, so there is nothing to attest. */
export const TIER1_SCHEMA = "x402-redteam/report@4-redacted";
export const TIER2_SCHEMA = "x402-redteam/report@4";

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
 * Builds the verify candidates from whatever's committed: a `report@4-redacted` entry
 * is a Tier 1 candidate, a `report@4` entry a Tier 2 one - only when its bundle file
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

export function buildVerifyCandidates(
  entries: RawResultEntry[],
  resultsDir: string,
  meta: ResultsMeta,
  tier2Eligible: string[],
): VerifyCandidate[] {
  const candidates: VerifyCandidate[] = [];
  const digest = signerDigest();
  for (const entry of entries) {
    const bundlePath = bundlePathFor(resultsDir, entry.id);
    if (!existsSync(bundlePath)) continue;
    const resultPath = resolve(resultsDir, `${entry.id}.json`);
    const schema = schemaOf(entry.data);
    if (schema === TIER1_SCHEMA) {
      candidates.push({
        id: entry.id,
        resultPath,
        bundlePath,
        tier: 1,
        contentHash: entry.sha256,
        signerDigest: digest,
      });
    } else if (schema === TIER2_SCHEMA) {
      // U34 (A1, C3): the signer digest is the report's own harness_commit, and only a
      // Tier 2-eligible release is worth a network check at all.
      const commit = (entry.data as { config?: { harness_commit?: unknown } }).config
        ?.harness_commit;
      if (typeof commit !== "string" || !tier2Eligible.includes(commit)) continue;
      candidates.push({
        id: entry.id,
        resultPath,
        bundlePath,
        tier: 2,
        submitterOwner: meta[entry.id]?.owner,
        contentHash: entry.sha256,
        harnessCommit: commit,
      });
    }
  }
  return candidates;
}
