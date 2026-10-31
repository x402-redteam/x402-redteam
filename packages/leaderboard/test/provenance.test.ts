import { describe, expect, it } from "vitest";
import {
  buildGhAttestationVerifyArgs,
  HARNESS_ORG_REPO,
  type ProvenanceVerifier,
  RANK_CERT_IDENTITY_REGEX,
  RANK_SIGNER,
  RANKED_RUN_SIGNER,
  SIGNER_SOURCE_REF,
  unverifiedVerifier,
  verifyEntries,
} from "../src/provenance.js";

describe("buildGhAttestationVerifyArgs (security review HIGH-6, re-review finding 6)", () => {
  it("tier 1: scopes with --repo + --source-ref, never --owner", () => {
    const args = buildGhAttestationVerifyArgs({
      resultPath: "report.redacted.json",
      bundlePath: "bundle.jsonl",
      tier: 1,
    });
    expect(args).toEqual([
      "attestation",
      "verify",
      "--bundle",
      "bundle.jsonl",
      "--repo",
      HARNESS_ORG_REPO,
      "--signer-workflow",
      RANKED_RUN_SIGNER,
      "--source-ref",
      SIGNER_SOURCE_REF,
      "report.redacted.json",
    ]);
    expect(args).not.toContain("--owner");
  });

  const COMMIT = "c".repeat(40);

  it("tier 2 (U34 C1): --owner + --cert-identity-regex + --signer-digest <harness_commit>; no --signer-workflow, --repo or --source-ref", () => {
    const args = buildGhAttestationVerifyArgs({
      resultPath: "report.json",
      bundlePath: "bundle.jsonl",
      tier: 2,
      submitterOwner: "some-submitter",
      signerDigest: COMMIT,
    });
    expect(args).toEqual([
      "attestation",
      "verify",
      "--bundle",
      "bundle.jsonl",
      "--owner",
      "some-submitter",
      "--cert-identity-regex",
      RANK_CERT_IDENTITY_REGEX,
      "--signer-digest",
      COMMIT,
      "report.json",
    ]);
    expect(args).not.toContain("--signer-workflow");
    expect(args).not.toContain("--repo");
    expect(args).not.toContain("--source-ref");
  });

  it("tier 2 (C1): the identity regex is built from HARNESS_ORG_REPO, escaped and anchored, and accepts a release tag or a 40-hex SHA only", () => {
    const re = new RegExp(RANK_CERT_IDENTITY_REGEX);
    const base = `https://github.com/${HARNESS_ORG_REPO}/.github/workflows/rank.yml`;
    expect(RANK_CERT_IDENTITY_REGEX.startsWith("^")).toBe(true);
    expect(RANK_CERT_IDENTITY_REGEX.endsWith("$")).toBe(true);
    expect(RANK_CERT_IDENTITY_REGEX).toContain(HARNESS_ORG_REPO.replace(/\./g, "\\\\."));
    expect(re.test(`${base}@refs/tags/v0.1.1`)).toBe(true);
    expect(re.test(`${base}@refs/tags/v12.0.345`)).toBe(true);
    expect(re.test(`${base}@${"a".repeat(40)}`)).toBe(true);
    // a branch, a pre-release tag, a short or over-long SHA, other workflows or repos
    expect(re.test(`${base}@refs/heads/main`)).toBe(false);
    expect(re.test(`${base}@refs/tags/v0.1.1-rc1`)).toBe(false);
    expect(re.test(`${base}@${"a".repeat(39)}`)).toBe(false);
    expect(re.test(`${base}@${"a".repeat(41)}`)).toBe(false);
    expect(re.test(`${base}x@refs/tags/v0.1.1`)).toBe(false);
    expect(re.test(`${base}@refs/tags/v0.1.1/extra`)).toBe(false);
    expect(re.test(`${base.replace("rank.yml", "ranked-run.yml")}@refs/tags/v0.1.1`)).toBe(false);
    expect(re.test(`${base.replace("github.com", "githubXcom")}@refs/tags/v0.1.1`)).toBe(false);
    expect(re.test(`${base.replace(HARNESS_ORG_REPO, "evil/x402-redteam")}@refs/tags/v0.1.1`)).toBe(
      false,
    );
    expect(re.test(`evil-${base}@refs/tags/v0.1.1`)).toBe(false);
  });

  it("tier 1 args are unchanged by U34", () => {
    expect(
      buildGhAttestationVerifyArgs({ resultPath: "r.json", bundlePath: "b", tier: 1 }),
    ).toEqual([
      "attestation",
      "verify",
      "--bundle",
      "b",
      "--repo",
      HARNESS_ORG_REPO,
      "--signer-workflow",
      RANKED_RUN_SIGNER,
      "--source-ref",
      SIGNER_SOURCE_REF,
      "r.json",
    ]);
  });

  it("throws building a tier 2 argv with no (or a malformed) signerDigest", () => {
    const base = { resultPath: "r", bundlePath: "b", tier: 2 as const, submitterOwner: "o" };
    expect(() => buildGhAttestationVerifyArgs(base)).toThrow(/signerDigest/);
    expect(() => buildGhAttestationVerifyArgs({ ...base, signerDigest: "sha256:dead" })).toThrow(
      /signerDigest/,
    );
  });

  it("throws building a tier 2 argv with no submitterOwner", () => {
    expect(() =>
      buildGhAttestationVerifyArgs({ resultPath: "r", bundlePath: "b", tier: 2 }),
    ).toThrow(/submitterOwner/);
  });

  it("appends --signer-digest on tier 1 when given", () => {
    const args = buildGhAttestationVerifyArgs({
      resultPath: "r",
      bundlePath: "b",
      tier: 1,
      signerDigest: "sha256:deadbeef",
    });
    expect(args).toContain("--signer-digest");
    expect(args).toContain("sha256:deadbeef");
  });
});

describe("verifyEntries (ADR-011 provenance tiers, U19)", () => {
  it("picks RANKED_RUN_SIGNER for tier 1 and RANK_SIGNER for tier 2, and records subject_sha256", async () => {
    const seenTiers: Array<1 | 2> = [];
    const seenDigests: Array<string | undefined> = [];
    const verifier: ProvenanceVerifier = async (params) => {
      seenTiers.push(params.tier);
      seenDigests.push(params.signerDigest);
      return true;
    };

    const verified = await verifyEntries(
      [
        { id: "a", resultPath: "a.json", bundlePath: "a.bundle", tier: 1, contentHash: "hash-a" },
        {
          id: "b",
          resultPath: "b.json",
          bundlePath: "b.bundle",
          tier: 2,
          submitterOwner: "owner-b",
          harnessCommit: "d".repeat(40),
          contentHash: "hash-b",
        },
      ],
      verifier,
    );

    expect(seenTiers).toEqual([1, 2]);
    // C3: tier 2's signer digest is the candidate report's harness_commit
    expect(seenDigests).toEqual([undefined, "d".repeat(40)]);
    expect(verified).toEqual({
      a: { tier: 1, signer: RANKED_RUN_SIGNER, subject_sha256: "hash-a" },
      b: { tier: 2, signer: RANK_SIGNER, subject_sha256: "hash-b" },
    });
  });

  it("only records an entry when the verifier resolves true", async () => {
    const verifier: ProvenanceVerifier = async (params) => params.resultPath === "good.json";

    const verified = await verifyEntries(
      [
        { id: "good", resultPath: "good.json", bundlePath: "b1", tier: 1, contentHash: "h1" },
        { id: "bad", resultPath: "bad.json", bundlePath: "b2", tier: 1, contentHash: "h2" },
      ],
      verifier,
    );

    expect(verified).toEqual({
      good: { tier: 1, signer: RANKED_RUN_SIGNER, subject_sha256: "h1" },
    });
  });

  it("security review HIGH-6: a tier 2 candidate with no submitterOwner is skipped, never verified", async () => {
    const verifier: ProvenanceVerifier = async () => true;

    const verified = await verifyEntries(
      [{ id: "no-owner", resultPath: "r.json", bundlePath: "b", tier: 2, contentHash: "h" }],
      verifier,
    );

    expect(verified).toEqual({});
  });

  it("U34 C3: a tier 2 candidate with a missing or malformed harness commit is skipped, never verified", async () => {
    let calls = 0;
    const verifier: ProvenanceVerifier = async () => {
      calls++;
      return true;
    };
    const base = {
      resultPath: "r.json",
      bundlePath: "b",
      tier: 2 as const,
      submitterOwner: "o",
      contentHash: "h",
    };
    const verified = await verifyEntries(
      [
        { ...base, id: "none" },
        { ...base, id: "short", harnessCommit: "abc" },
        { ...base, id: "upper", harnessCommit: "A".repeat(40) },
        { ...base, id: "unknown", harnessCommit: "unknown" },
      ],
      verifier,
    );
    expect(verified).toEqual({});
    expect(calls).toBe(0);
  });

  it("unverifiedVerifier always resolves false (the offline default)", async () => {
    await expect(unverifiedVerifier({ resultPath: "a", bundlePath: "b", tier: 1 })).resolves.toBe(
      false,
    );
    const verified = await verifyEntries(
      [{ id: "a", resultPath: "a.json", bundlePath: "a.bundle", tier: 1, contentHash: "h" }],
      unverifiedVerifier,
    );
    expect(verified).toEqual({});
  });
});
