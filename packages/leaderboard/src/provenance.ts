/**
 * ADR-011 provenance tiers (U19). Only Tier 1 is ranked:
 * - **Tier 1 "Ranked (held-out)"**: a maintainer-initiated `ranked-run.yml` run against
 *   the season's held-out corpus, publishing a redacted report plus an attestation.
 * - **Tier 2 "Verified (public corpus)"**: a submitter's own public repo calling the
 *   reusable `rank.yml` workflow against the public corpus, publishing a full report
 *   plus an attestation. Shown in its own table, never merged into Tier 1's.
 * - **Tier 3 "Self-reported"**: no attestation at all. Rejected by default (user
 *   decision, Phase C G7 item 4 - deferred to G8 whether this ever changes).
 *
 * Verifying an attestation means calling `gh attestation verify`, a real network call -
 * `pnpm leaderboard`'s own default path stays offline and deterministic (CLAUDE.md), so
 * it only ever *reads* the result of that check from `results/_verified.json`, written
 * ahead of time by a separate step (this module's `verifyEntries`, driven by `main.ts`'s
 * `--verify-attestations`). `buildLeaderboard` never calls a `ProvenanceVerifier` itself.
 */

/**
 * Security review HIGH-3/HIGH-6: the harness's own org/repo, the *single* place it's
 * named (everything else here - the two signer paths, `--repo` - is derived from it).
 * The org hasn't been created yet (Phase C user decisions) - update this one constant
 * once it has. `rank.yml` hard-codes the identical literal (it can't `import` this
 * module - it's a GitHub Actions YAML file, not TypeScript) and is checked against it
 * by `packages/cli/test/ranked-workflows.test.ts`.
 */
export const HARNESS_ORG_REPO = "x402-redteam/x402-redteam";

/** Security review HIGH-6: `gh attestation verify --source-ref` - both signer
 * workflows only ever run from `main` (`ranked-run.yml` is `workflow_dispatch` on the
 * default branch; `rank.yml` is called by a tag-pinned `uses:`, but the workflow
 * *file's own* source ref recorded in its attestation's certificate is still the
 * branch it was published from). */
export const SIGNER_SOURCE_REF = "refs/heads/main";

/** The signer workflow each tier's attestation must come from (ADR-011 "Harness
 * identity" / "Tier 1"/"Tier 2"), as the *full* `owner/repo/.github/workflows/file.yml`
 * path `gh attestation verify --signer-workflow` expects (security review HIGH-6) -
 * not just the file's own repo-relative path. */
export const RANKED_RUN_SIGNER = `${HARNESS_ORG_REPO}/.github/workflows/ranked-run.yml`;
export const RANK_SIGNER = `${HARNESS_ORG_REPO}/.github/workflows/rank.yml`;

/** One `results/_verified.json` entry - what the out-of-band attestation check found
 * for one committed result id. Entries absent from the map are Tier 3 by definition. */
export interface VerifiedEntry {
  tier: 1 | 2;
  /** The attesting workflow's own path (`RANKED_RUN_SIGNER` for tier 1, `RANK_SIGNER`
   * for tier 2), kept for display/audit. */
  signer: string;
  /**
   * Security review HIGH-5: sha256 of the exact report content the attestation
   * covered (the same canonicalized-JSON hash `load-results.ts`'s `contentHash`
   * computes from the committed file) - `buildLeaderboard` recomputes this from
   * whatever's actually committed today and rejects a mismatch. This is what makes
   * `results/_verified.json` bind to *this* file's content, not merely to "an id
   * someone once attested something for."
   */
  subject_sha256: string;
  /** The GitHub Actions run that produced this entry, when known. */
  run_url?: string;
}

/** `results/_verified.json`: `{ "<id>": {tier, signer, subject_sha256, run_url?} }`. */
export type VerifiedMap = Record<string, VerifiedEntry>;

/**
 * Security review HIGH-6: everything one `gh attestation verify` call needs, as a
 * plain data object - keeps the "build the argv" step (`buildGhAttestationVerifyArgs`,
 * below) pure and independently testable from the actual child-process call.
 */
export interface AttestationCheckParams {
  resultPath: string;
  bundlePath: string;
  tier: 1 | 2;
  /** Required for tier 2 (`--owner <submitter>`) - a Tier 2 report is attested by the
   * *submitter's* repo, so the signer-workflow path alone (which only names the
   * harness's own reusable workflow file) doesn't pin who called it. Ignored for
   * tier 1, where the signer is always this harness's own `ranked-run.yml`. */
  submitterOwner?: string;
  /** Pins the signer's own published certificate digest, once known (left unset until
   * a real one is resolved - `gh attestation verify` still enforces signer-workflow and
   * source-ref either way). */
  signerDigest?: string;
}

/**
 * Security re-review finding 6: Tier 1 and Tier 2 scope trust *differently*, and
 * `gh attestation verify` only wants one scoping flag, not both:
 * - **Tier 1**: the attestation was produced by `ranked-run.yml`, running in *our own*
 *   harness repo - we know exactly which repo, so we scope with `--repo
 *   HARNESS_ORG_REPO` and can also pin `--source-ref` (that workflow only ever runs
 *   from `main`).
 * - **Tier 2**: the attestation was produced by `rank.yml`, but *called from the
 *   submitter's own repo* - `--repo` would (wrongly) mean "this harness's repo", and
 *   the submitter's own ref isn't ours to constrain. Scope with `--owner
 *   <submitterOwner>` instead (trusts attestations from that GitHub user/org,
 *   regardless of which of their repos called `rank.yml`), and never force
 *   `--source-ref`.
 *
 * Pure and synchronous, so it can be unit-tested without ever invoking `gh`. The real
 * verifier (`main.ts`'s `ghAttestationVerifier`) does nothing but pass this straight to
 * `execFile`.
 */
export function buildGhAttestationVerifyArgs(params: AttestationCheckParams): string[] {
  const args = ["attestation", "verify", "--bundle", params.bundlePath];
  if (params.tier === 1) {
    args.push("--repo", HARNESS_ORG_REPO, "--signer-workflow", RANKED_RUN_SIGNER);
    args.push("--source-ref", SIGNER_SOURCE_REF);
  } else {
    if (!params.submitterOwner) {
      throw new Error("a Tier 2 attestation check requires submitterOwner (--owner)");
    }
    args.push("--owner", params.submitterOwner, "--signer-workflow", RANK_SIGNER);
  }
  if (params.signerDigest !== undefined) {
    args.push("--signer-digest", params.signerDigest);
  }
  args.push(params.resultPath);
  return args;
}

/**
 * Verifies one GitHub artifact attestation against the constraints
 * `buildGhAttestationVerifyArgs` encodes. Injected: the real implementation
 * (`main.ts`'s `ghAttestationVerifier`) calls `gh attestation verify` and makes a real
 * network call to GitHub - never during `pnpm leaderboard`'s offline default path, and
 * never in a unit test (tests inject a stub that resolves immediately).
 */
export type ProvenanceVerifier = (params: AttestationCheckParams) => Promise<boolean>;

/** The offline default every `ProvenanceVerifier` call site other than
 * `--verify-attestations` itself should use: always "unverified" - never makes a call at
 * all, so every entry is Tier 3 (self-reported, rejected by default) unless
 * `results/_verified.json` already says otherwise. */
export const unverifiedVerifier: ProvenanceVerifier = async () => false;

export interface VerifyCandidate {
  /** The committed result's own id (matches `results/<id>.json`'s filename stem). */
  id: string;
  /** Path to the report file (`report.json` or `report.redacted.json`) the attestation
   * covers. */
  resultPath: string;
  /** Path to the downloaded attestation bundle for this id. */
  bundlePath: string;
  /** Which tier this candidate is being checked for - selects the expected signer. */
  tier: 1 | 2;
  /** Required for tier 2 - see `AttestationCheckParams.submitterOwner`. A tier 2
   * candidate with no owner is skipped (never verified) rather than guessed at. */
  submitterOwner?: string;
  signerDigest?: string;
  /** Security review HIGH-5: `load-results.ts`'s `contentHash` of this candidate's
   * *own* committed file, recorded into the written `VerifiedEntry.subject_sha256` once
   * verified - the binding `buildLeaderboard` later re-checks. */
  contentHash: string;
}

/**
 * Runs `verifier` over every candidate and returns the `results/_verified.json` shape -
 * the separate `--verify-attestations` step's own job (functional-design.md "Files":
 * "packages/leaderboard/src/main.ts ... --verify-attestations uses `gh attestation
 * verify --bundle … --signer-workflow …`"), never called from `pnpm leaderboard`'s
 * default path or from `buildLeaderboard` itself.
 */
export async function verifyEntries(
  candidates: VerifyCandidate[],
  verifier: ProvenanceVerifier,
): Promise<VerifiedMap> {
  const out: VerifiedMap = {};
  for (const candidate of candidates) {
    if (candidate.tier === 2 && !candidate.submitterOwner) continue;
    const ok = await verifier({
      resultPath: candidate.resultPath,
      bundlePath: candidate.bundlePath,
      tier: candidate.tier,
      submitterOwner: candidate.submitterOwner,
      signerDigest: candidate.signerDigest,
    });
    if (ok) {
      const signer = candidate.tier === 1 ? RANKED_RUN_SIGNER : RANK_SIGNER;
      out[candidate.id] = {
        tier: candidate.tier,
        signer,
        subject_sha256: candidate.contentHash,
      };
    }
  }
  return out;
}
