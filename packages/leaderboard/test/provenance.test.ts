import { describe, expect, it } from "vitest";
import {
  buildGhAttestationVerifyArgs,
  HARNESS_ORG_REPO,
  type ProvenanceVerifier,
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

  it("tier 2: scopes with --owner <submitter> only - never --repo or --source-ref", () => {
    const args = buildGhAttestationVerifyArgs({
      resultPath: "report.json",
      bundlePath: "bundle.jsonl",
      tier: 2,
      submitterOwner: "some-submitter",
    });
    expect(args).toEqual([
      "attestation",
      "verify",
      "--bundle",
      "bundle.jsonl",
      "--owner",
      "some-submitter",
      "--signer-workflow",
      RANK_SIGNER,
      "report.json",
    ]);
    expect(args).not.toContain("--repo");
    expect(args).not.toContain("--source-ref");
  });

  it("throws building a tier 2 argv with no submitterOwner", () => {
    expect(() =>
      buildGhAttestationVerifyArgs({ resultPath: "r", bundlePath: "b", tier: 2 }),
    ).toThrow(/submitterOwner/);
  });

  it("appends --signer-digest when given, on either tier", () => {
    const tier1Args = buildGhAttestationVerifyArgs({
      resultPath: "r",
      bundlePath: "b",
      tier: 1,
      signerDigest: "sha256:deadbeef",
    });
    expect(tier1Args).toContain("--signer-digest");
    expect(tier1Args).toContain("sha256:deadbeef");

    const tier2Args = buildGhAttestationVerifyArgs({
      resultPath: "r",
      bundlePath: "b",
      tier: 2,
      submitterOwner: "some-submitter",
      signerDigest: "sha256:deadbeef",
    });
    expect(tier2Args).toContain("--signer-digest");
  });
});

describe("verifyEntries (ADR-011 provenance tiers, U19)", () => {
  it("picks RANKED_RUN_SIGNER for tier 1 and RANK_SIGNER for tier 2, and records subject_sha256", async () => {
    const seenTiers: Array<1 | 2> = [];
    const verifier: ProvenanceVerifier = async (params) => {
      seenTiers.push(params.tier);
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
          contentHash: "hash-b",
        },
      ],
      verifier,
    );

    expect(seenTiers).toEqual([1, 2]);
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
