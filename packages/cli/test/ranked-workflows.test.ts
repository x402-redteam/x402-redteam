import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * ADR-011 (U19): `rank.yml`, `ranked-run.yml` and `verify-results.yml` parse as YAML -
 * the acceptance test functional-design.md §4 asks for, explicitly without `act` or
 * `actionlint` (CLAUDE.md: neither is installed, and must not be). Bolt 6's own
 * lockfile rule ("no other unit adds dependencies" - units-of-work.md, Bolt 6) rules
 * out adding a YAML parser dependency just for this test, so this is a dependency-free
 * structural sanity check (consistent indentation, no tabs, balanced `${{ }}`
 * expressions, the expected top-level keys as plain text) rather than a real parse. A
 * real parse was run by hand during development, using the `yaml` package
 * `@x402-redteam/schema` already depends on
 * (`node -e "require('./packages/schema/node_modules/yaml').parse(...)"`), confirming
 * every workflow file parses cleanly and reports the expected job names - see this
 * unit's report for the exact command. The workflows (and the security-review fixes
 * applied to them) are statically authored only and have not been dry-run against a
 * real GitHub org (none exists yet, per the Phase C user decisions).
 */
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function readWorkflow(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

/** A minimal, dependency-free YAML sanity check: no tab characters (YAML forbids them
 * for indentation), every `${{ ... }}` expression balanced, and the file ends with a
 * trailing newline (consistent with every other committed file here). Not a real
 * parse - see this file's own doc comment. */
function assertYamlLooksWellFormed(text: string): void {
  expect(text).not.toMatch(/\t/);
  const opens = [...text.matchAll(/\$\{\{/g)].length;
  const closes = [...text.matchAll(/\}\}/g)].length;
  expect(opens).toBeGreaterThan(0);
  expect(opens).toBe(closes);
  expect(text.endsWith("\n")).toBe(true);
}

/**
 * Security review HIGH-3/HIGH-8: no `${{ inputs.* }}` may appear inside a `run:`
 * block's shell script text - every input must be passed through `env:` instead, so a
 * crafted input string can't break out of its intended single value. Checks every
 * `run: |` block in the file independently of the others.
 */
function assertNoInputsInterpolatedInRunBlocks(text: string): void {
  const lines = text.split("\n");
  let inRunBlock = false;
  let runBlockIndent = -1;
  for (const line of lines) {
    const runMatch = line.match(/^(\s*)run:\s*\|\s*$/);
    if (runMatch) {
      inRunBlock = true;
      runBlockIndent = runMatch[1]?.length ?? 0;
      continue;
    }
    if (inRunBlock) {
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch?.[1]?.length ?? 0;
      if (line.trim().length > 0 && indent <= runBlockIndent) {
        inRunBlock = false;
      } else {
        expect(line).not.toMatch(/\$\{\{\s*inputs\./);
      }
    }
  }
}

describe("rank.yml / ranked-run.yml / verify-results.yml / ranked Dockerfile (ADR-011, U19, security review)", () => {
  it("rank.yml looks like well-formed YAML and declares a reusable workflow_call with the expected inputs", () => {
    const text = readWorkflow(".github/workflows/rank.yml");
    assertYamlLooksWellFormed(text);
    expect(text).toMatch(/^name:\s*rank\s*$/m);
    expect(text).toMatch(/^on:\s*$/m);
    expect(text).toContain("workflow_call:");
    for (const input of ["harness-ref", "guardrail-cmd", "guardrail-id"]) {
      expect(text).toContain(`${input}:`);
    }
    // Security review HIGH-3: harness-repo is gone as an input.
    expect(text).not.toMatch(/^\s*harness-repo:/m);
  });

  it("security review HIGH-3: rank.yml's harness org/repo is a single hard-coded placeholder, not an input", () => {
    const text = readWorkflow(".github/workflows/rank.yml");
    expect(text).toContain("repository: ORG_PLACEHOLDER/x402-redteam");
  });

  it("security review HIGH-3: rank.yml splits run (no attestation permissions) from a separate attest job", () => {
    const text = readWorkflow(".github/workflows/rank.yml");
    expect(text).toMatch(/^\s*run:\s*$/m);
    expect(text).toMatch(/^\s*attest:\s*$/m);
    expect(text).toMatch(/^\s*needs:\s*run\s*$/m);
    // Top-level permissions are read-only; id-token/attestations only appear once,
    // scoped to the attest job (not the top-level `permissions:` block). Matched as
    // real YAML keys (anchored to line start, ignoring indent) so a comment line
    // merely *describing* id-token/attestations doesn't trip this.
    const topLevelPermissions = text.split("jobs:")[0] ?? "";
    expect(topLevelPermissions).not.toMatch(/^\s*id-token:/m);
    expect(topLevelPermissions).not.toMatch(/^\s*attestations:/m);
    expect(text).toMatch(/^\s*id-token:\s*write/m);
    expect(text).toMatch(/^\s*attestations:\s*write/m);
  });

  it("security review HIGH-3/HIGH-8: rank.yml never interpolates a workflow_call input directly inside a run: block", () => {
    assertNoInputsInterpolatedInRunBlocks(readWorkflow(".github/workflows/rank.yml"));
  });

  it("security review HIGH-4: rank.yml runs the guardrail at a non-reserved agent uid (2001, never 1000/1001/0)", () => {
    const text = readWorkflow(".github/workflows/rank.yml");
    expect(text).toContain("--agent-uid 2001");
    expect(text).not.toMatch(/--agent-uid\s+(0|1000|1001)\b/);
  });

  it("security review LOW: every checkout in rank.yml sets persist-credentials: false", () => {
    const text = readWorkflow(".github/workflows/rank.yml");
    const checkoutBlocks = text.split("uses: actions/checkout@").slice(1);
    expect(checkoutBlocks.length).toBeGreaterThan(0);
    for (const block of checkoutBlocks) {
      expect(block).toMatch(/persist-credentials:\s*false/);
    }
  });

  it("ranked-run.yml looks like well-formed YAML, is workflow_dispatch, and gates on the 'ranked' environment", () => {
    const text = readWorkflow(".github/workflows/ranked-run.yml");
    assertYamlLooksWellFormed(text);
    expect(text).toMatch(/^name:\s*ranked-run\s*$/m);
    expect(text).toContain("workflow_dispatch:");
    for (const input of [
      "harness-ref",
      "guardrail-repo",
      "guardrail-ref",
      "guardrail-entrypoint",
      "guardrail-id",
    ]) {
      expect(text).toContain(`${input}:`);
    }
    expect(text).toMatch(/^\s*environment:\s*ranked\s*$/m);
  });

  it("security review HIGH-8: ranked-run.yml validates harness-ref/guardrail-ref as a commit SHA or release tag", () => {
    const text = readWorkflow(".github/workflows/ranked-run.yml");
    expect(text).toMatch(/0-9a-f.*40/);
    expect(text).toContain("HARNESS_REF");
    expect(text).toContain("GUARDRAIL_REF");
  });

  it("security review HIGH-3/HIGH-8: ranked-run.yml never interpolates a workflow_call input directly inside a run: block", () => {
    assertNoInputsInterpolatedInRunBlocks(readWorkflow(".github/workflows/ranked-run.yml"));
  });

  it("security review HIGH-4: ranked-run.yml runs the guardrail at a non-reserved agent uid (2001, never 1000/1001/0)", () => {
    const text = readWorkflow(".github/workflows/ranked-run.yml");
    expect(text).toContain("--agent-uid 2001");
    expect(text).not.toMatch(/--agent-uid\s+(0|1000|1001)\b/);
  });

  it("security review HIGH-12: ranked-run.yml records --guardrail-repo-ref", () => {
    expect(readWorkflow(".github/workflows/ranked-run.yml")).toContain("--guardrail-repo-ref");
  });

  it("security review LOW: every checkout in ranked-run.yml sets persist-credentials: false", () => {
    const text = readWorkflow(".github/workflows/ranked-run.yml");
    const checkoutBlocks = text.split("uses: actions/checkout@").slice(1);
    expect(checkoutBlocks.length).toBeGreaterThan(0);
    for (const block of checkoutBlocks) {
      expect(block).toMatch(/persist-credentials:\s*false/);
    }
  });

  it("ranked-run.yml never uploads anything but the redacted report", () => {
    const text = readWorkflow(".github/workflows/ranked-run.yml");
    const uploadBlocks = text.split("upload-artifact").slice(1);
    expect(uploadBlocks.length).toBeGreaterThan(0);
    for (const block of uploadBlocks) {
      expect(block).toMatch(/report\.redacted\.json/);
    }
    expect(text).not.toMatch(/logs?\.(txt|log)/);
  });

  it("ranked-run.yml's held-out repo is a repository variable, not a hardcoded org/repo", () => {
    const text = readWorkflow(".github/workflows/ranked-run.yml");
    expect(text).toContain("vars.HELDOUT_REPO");
  });

  it("security review HIGH-5: verify-results.yml exists, parses as well-formed YAML, and targets results/**", () => {
    const text = readWorkflow(".github/workflows/verify-results.yml");
    assertYamlLooksWellFormed(text);
    expect(text).toMatch(/^name:\s*verify-results\s*$/m);
    expect(text).toContain("results/**");
    expect(text).toContain("--verify-attestations");
  });

  it("security review HIGH-5: .github/CODEOWNERS protects the three results/_*.json sidecar files", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/CODEOWNERS"), "utf8");
    for (const file of ["_verified.json", "_harness.json", "_seasons.json"]) {
      expect(text).toContain(file);
    }
  });

  it("security review LOW: .dockerignore excludes .git", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".dockerignore"), "utf8");
    expect(text).toMatch(/^\.git\s*$/m);
  });

  it("security review MEDIUM-9: the ranked Dockerfile strips exactly one path component and verifies age runs", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/Dockerfile"), "utf8");
    expect(text).toContain("--strip-components=1");
    expect(text).toMatch(/age --version/);
  });

  it("security review HIGH-4/LOW: the ranked Dockerfile creates the agent user at uid 2001, never 0/1000/1001", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/Dockerfile"), "utf8");
    expect(text).toContain("--uid 2001");
  });

  it("the ranked Dockerfile installs age at image build time, not referencing a host install", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/Dockerfile"), "utf8");
    expect(text).toMatch(/age/);
    expect(text).not.toMatch(/apt-get install.*\bage\b/);
  });

  it("security review MEDIUM-10: entrypoint.sh decrypts to a file and checks age's exit status before extracting", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/entrypoint.sh"), "utf8");
    expect(text).not.toMatch(/age -d[^|]*\|\s*tar/);
    expect(text).toMatch(/if ! age -d/);
  });

  it("security review HIGH-4: entrypoint.sh writes to a root-only internal dir before copying the final report out", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/entrypoint.sh"), "utf8");
    expect(text).toContain("/root-out");
    expect(text).toMatch(/mkdir -m 0700/);
  });

  it("security re-review 1-residual: entrypoint.sh never copies the full report.json when a redacted one exists", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/entrypoint.sh"), "utf8");
    // The old "copy both if present" loop is gone - redacted is preferred, and the
    // full report is only copied in its absence (an `elif`, not a second branch that
    // always runs).
    expect(text).toMatch(/if \[ -f \/root-out\/report\.redacted\.json \]/);
    expect(text).toMatch(/elif \[ -f \/root-out\/report\.json \]/);
  });

  it("security re-review 4-residual: the ranked Dockerfile installs procps (provides pkill)", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/Dockerfile"), "utf8");
    expect(text).toMatch(/apt-get install[^\n]*\bprocps\b/);
  });

  it("security re-review 1-residual: ranked-run.yml redirects docker's stderr to a non-uploaded file", () => {
    const text = readWorkflow(".github/workflows/ranked-run.yml");
    expect(text).toContain('2> "$RUNNER_TEMP/harness.stderr"');
    const uploadBlocks = text.split("upload-artifact").slice(1);
    for (const block of uploadBlocks) {
      expect(block).not.toMatch(/harness\.stderr/);
    }
  });

  it("security re-review N1: verify-results.yml runs on pull_request (not pull_request_target), with no ranked environment and no base-scope cache writes", () => {
    const text = readWorkflow(".github/workflows/verify-results.yml");
    expect(text).toMatch(/^\s*pull_request:\s*$/m);
    expect(text).not.toContain("pull_request_target");
    expect(text).not.toMatch(/^\s*environment:\s*ranked/m);
    expect(text).not.toMatch(/^\s*cache:\s*pnpm/m);
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("security re-review N3: canonical.ts hardcodes a REFERENCE_IDS allowlist, not just results/_meta.json's own kind field", () => {
    const text = readFileSync(resolve(REPO_ROOT, "packages/leaderboard/src/canonical.ts"), "utf8");
    expect(text).toContain("REFERENCE_IDS");
    for (const id of ["naive-baseline", "guarded-reference", "allow-all", "deny-all"]) {
      expect(text).toContain(id);
    }
  });

  it("security re-review N3: .github/CODEOWNERS also protects results/_meta.json", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/CODEOWNERS"), "utf8");
    expect(text).toContain("_meta.json");
  });

  it("security re-review 3c: rank.yml requires harness-ref to be a vMAJOR.MINOR.PATCH tag and asserts checked-out HEAD matches it", () => {
    const text = readWorkflow(".github/workflows/rank.yml");
    expect(text).toContain(String.raw`^v[0-9]+\.[0-9]+\.[0-9]+$`);
    expect(text).toContain("refs/tags/$HARNESS_REF^{commit}");
    expect(text).not.toMatch(/harness-repo:/);
  });

  it("security re-review finding 6: Tier 2's verify argv never forces --repo or --source-ref", () => {
    const text = readFileSync(resolve(REPO_ROOT, "packages/leaderboard/src/provenance.ts"), "utf8");
    expect(text).toContain("--owner");
  });

  it("the ranked Dockerfile declares a HARNESS_COMMIT build arg exported as X402_HARNESS_COMMIT", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/Dockerfile"), "utf8");
    expect(text).toMatch(/^ARG HARNESS_COMMIT/m);
    expect(text).toMatch(/^ENV X402_HARNESS_COMMIT=\$\{HARNESS_COMMIT\}/m);
  });

  it("the ranked Dockerfile labels the image with its source, revision and version build args", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/Dockerfile"), "utf8");
    expect(text).toMatch(/^ARG IMAGE_SOURCE/m);
    expect(text).toMatch(/^ARG IMAGE_VERSION/m);
    expect(text).toMatch(/org\.opencontainers\.image\.source="\$\{IMAGE_SOURCE\}"/);
    expect(text).toMatch(/org\.opencontainers\.image\.revision="\$\{HARNESS_COMMIT\}"/);
    expect(text).toMatch(/org\.opencontainers\.image\.version="\$\{IMAGE_VERSION\}"/);
  });

  interface Step {
    name?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  }
  interface Job {
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    environment?: string;
    outputs?: Record<string, string>;
    steps: Step[];
  }
  interface Workflow {
    permissions?: unknown;
    on: Record<string, { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }>;
    jobs: Record<string, Job>;
  }

  function parseWorkflow(relativePath: string): Workflow {
    return parse(readWorkflow(relativePath)) as Workflow;
  }

  function stepIndex(steps: Step[], predicate: (step: Step) => boolean, label: string): number {
    const index = steps.findIndex(predicate);
    expect(index, label).toBeGreaterThanOrEqual(0);
    return index;
  }

  const RANKED_JOBS: Array<[string, string]> = [
    [".github/workflows/rank.yml", "run"],
    [".github/workflows/ranked-run.yml", "ranked-run"],
  ];

  for (const [file, jobName] of RANKED_JOBS) {
    it(`${file} never builds an image and runs only the image pulled by digest`, () => {
      const text = readWorkflow(file);
      expect(text).not.toMatch(/docker build/);
      expect(text).not.toMatch(/\bx402-redteam-ranked \\$/m);
      const job = parseWorkflow(file).jobs[jobName] as Job;
      expect(job.env?.RANKED_IMAGE).toBe("ghcr.io/ORG_PLACEHOLDER/x402-redteam-ranked");
      expect(job.env?.HARNESS_REPO).toBe("ORG_PLACEHOLDER/x402-redteam");
      const runs = job.steps.map((step) => step.run ?? "").join("\n");
      expect(runs).toContain('docker pull "$RANKED_IMAGE@$RANKED_IMAGE_DIGEST"');
      const dockerRuns = runs.match(/docker run[\s\S]*?--agent-uid 2001/g) ?? [];
      expect(dockerRuns.length).toBe(1);
      expect(dockerRuns[0]).toContain('"$RANKED_IMAGE@$RANKED_IMAGE_DIGEST"');
      expect(runs).not.toMatch(/docker (pull|run)[^\n]*:v\d/);
    });

    it(`${file} resolves the digest with resolve-image.mjs, verifies the attestation, pulls, then runs`, () => {
      const steps = (parseWorkflow(file).jobs[jobName] as Job).steps;
      const commit = stepIndex(
        steps,
        (s) => (s.run ?? "").includes("HARNESS_COMMIT=") && (s.run ?? "").includes("GITHUB_ENV"),
        "harness commit",
      );
      const allowlist = stepIndex(
        steps,
        (s) =>
          (s.uses ?? "").startsWith("actions/checkout@") &&
          String(s.with?.["sparse-checkout"] ?? "").includes("results/_harness.json"),
        "allowlist checkout",
      );
      const resolveStep = stepIndex(
        steps,
        (s) => (s.run ?? "").includes("scripts/ranked/resolve-image.mjs"),
        "resolve",
      );
      const verify = stepIndex(
        steps,
        (s) => (s.run ?? "").includes("gh attestation verify"),
        "verify",
      );
      const pull = stepIndex(steps, (s) => (s.run ?? "").includes("docker pull"), "pull");
      const run = stepIndex(steps, (s) => (s.run ?? "").includes("docker run"), "run");
      expect(commit).toBeLessThan(resolveStep);
      expect(allowlist).toBeLessThan(resolveStep);
      expect(resolveStep).toBeLessThan(verify);
      expect(verify).toBeLessThan(pull);
      expect(pull).toBeLessThan(run);

      const resolveEnv = steps[resolveStep]?.env ?? {};
      expect(resolveEnv.HARNESS_REF).toMatch(/^\$\{\{\s*inputs\.harness-ref\s*\}\}$/);
      expect(resolveEnv.HARNESS_JSON).toMatch(/results\/_harness\.json$/);
      expect(steps[allowlist]?.with?.["persist-credentials"]).toBe(false);

      const verifyStep = steps[verify] as Step;
      expect(verifyStep.run).toContain('"oci://$RANKED_IMAGE@$RANKED_IMAGE_DIGEST"');
      expect(verifyStep.run).toContain('--repo "$HARNESS_REPO"');
      expect(verifyStep.run).toContain(
        '--signer-workflow "$HARNESS_REPO/.github/workflows/release-image.yml"',
      );
      expect(verifyStep.run).toContain('--source-digest "$HARNESS_COMMIT"');
      expect(verifyStep.run).toContain('--signer-digest "$HARNESS_COMMIT"');
      expect(verifyStep.run).toContain('--source-ref "$RELEASE_REF"');
      expect(verifyStep.env?.RELEASE_REF).toBe("refs/heads/main");
      expect(verifyStep.run).toContain("--bundle-from-oci");
      expect(verifyStep.run).toContain("--deny-self-hosted-runners");
    });

    it(`${file} keeps every GitHub expression out of its run: scripts`, () => {
      const doc = parseWorkflow(file);
      for (const job of Object.values(doc.jobs)) {
        for (const step of job.steps) {
          if (typeof step.run === "string") expect(step.run, step.name).not.toContain("${{");
        }
      }
    });

    it(`${file} attests the report a second time with a predicate naming the image digest`, () => {
      const doc = parseWorkflow(file);
      const steps = Object.values(doc.jobs).flatMap((job) => job.steps);
      const custom = steps.filter(
        (s) => (s.uses ?? "").startsWith("actions/attest@") && s.with?.["predicate-type"],
      );
      expect(custom.length).toBe(1);
      expect(String(custom[0]?.with?.["predicate-path"])).toMatch(/ranked-image\.json$/);
      const writer = steps.find((s) => (s.run ?? "").includes("ranked-image.json"));
      expect(writer?.run).toContain("{image: $image, harness_commit: $commit}");
    });
  }

  it("rank.yml passes the image digest to the attest job, which alone holds id-token", () => {
    const doc = parseWorkflow(".github/workflows/rank.yml");
    expect(doc.jobs.run?.outputs?.["ranked-image"]).toMatch(
      /steps\.resolve\.outputs\.ranked-image/,
    );
    expect(doc.jobs.run?.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.attest?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
    const writer = doc.jobs.attest?.steps.find((s) => (s.run ?? "").includes("ranked-image.json"));
    expect(writer?.env?.RANKED_IMAGE_REF).toMatch(/needs\.run\.outputs\.ranked-image/);
    expect(writer?.run).toContain("@sha256:[0-9a-f]{64}$");
  });

  it("rank.yml reads the allowlist from the harness repo's default branch and runs the resolver from the tag checkout", () => {
    const steps = parseWorkflow(".github/workflows/rank.yml").jobs.run?.steps ?? [];
    const allowlist = steps.find((s) =>
      String(s.with?.["sparse-checkout"] ?? "").includes("results/_harness.json"),
    );
    expect(allowlist?.with?.repository).toBe("ORG_PLACEHOLDER/x402-redteam");
    expect(allowlist?.with?.ref).toBeUndefined();
    expect(String(allowlist?.with?.["sparse-checkout"]).trim()).toBe("results/_harness.json");
    const resolveStep = steps.find((s) => (s.run ?? "").includes("resolve-image.mjs"));
    expect(resolveStep?.run).toContain(
      "node .x402-redteam-harness/scripts/ranked/resolve-image.mjs",
    );
  });

  describe("release-image.yml", () => {
    const FILE = ".github/workflows/release-image.yml";

    it("is a workflow_call-only workflow with a version input and image/digest outputs", () => {
      const doc = parseWorkflow(FILE);
      expect(Object.keys(doc.on)).toEqual(["workflow_call"]);
      expect(Object.keys(doc.on.workflow_call?.inputs ?? {})).toEqual(["version"]);
      expect(Object.keys(doc.on.workflow_call?.outputs ?? {}).sort()).toEqual(["digest", "image"]);
    });

    it("grants nothing at the top level and only the minimal permissions to its one job", () => {
      const doc = parseWorkflow(FILE);
      expect(doc.permissions).toEqual({});
      expect(Object.keys(doc.jobs)).toEqual(["image"]);
      const job = doc.jobs.image as Job;
      expect(job.environment).toBe("release");
      expect(job.permissions).toEqual({
        contents: "read",
        packages: "write",
        "id-token": "write",
        attestations: "write",
      });
      expect(job.outputs?.digest).toMatch(/steps\.build\.outputs\.digest/);
    });

    it("builds linux/amd64 with SBOM, max provenance and the release commit as HARNESS_COMMIT", () => {
      const steps = (parseWorkflow(FILE).jobs.image as Job).steps;
      const build = steps.find((s) => (s.uses ?? "").startsWith("docker/build-push-action@"));
      expect(build?.with?.platforms).toBe("linux/amd64");
      expect(build?.with?.push).toBe(true);
      expect(build?.with?.sbom).toBe(true);
      expect(build?.with?.provenance).toBe("mode=max");
      expect(build?.with?.file).toBe(".github/ranked/Dockerfile");
      expect(build?.with?.["cache-from"]).toBeUndefined();
      expect(build?.with?.["cache-to"]).toBeUndefined();
      const args = String(build?.with?.["build-args"]);
      expect(args).toMatch(/^HARNESS_COMMIT=\$\{\{\s*github\.sha\s*\}\}$/m);
      expect(args).toMatch(/^IMAGE_VERSION=/m);
      expect(args).toMatch(/^IMAGE_SOURCE=/m);
    });

    it("tags vX.Y.Z, vX.Y and vX, never latest", () => {
      const steps = (parseWorkflow(FILE).jobs.image as Job).steps;
      const meta = steps.find((s) => (s.uses ?? "").startsWith("docker/metadata-action@"));
      const tags = String(meta?.with?.tags);
      expect(tags).toContain("pattern=v{{version}}");
      expect(tags).toContain("pattern=v{{major}}.{{minor}}");
      expect(tags).toContain("pattern=v{{major}},");
      expect(tags).not.toMatch(/latest/);
      expect(String(meta?.with?.flavor)).toMatch(/latest=false/);
    });

    it("attests the pushed digest by name and pushes the attestation to the registry", () => {
      const steps = (parseWorkflow(FILE).jobs.image as Job).steps;
      const buildIndex = steps.findIndex((s) =>
        (s.uses ?? "").startsWith("docker/build-push-action@"),
      );
      const attestIndex = steps.findIndex((s) => (s.uses ?? "").startsWith("actions/attest@"));
      expect(buildIndex).toBeGreaterThanOrEqual(0);
      expect(attestIndex).toBeGreaterThan(buildIndex);
      const attest = steps[attestIndex] as Step;
      expect(attest.with?.["subject-digest"]).toMatch(/steps\.build\.outputs\.digest/);
      expect(attest.with?.["subject-name"]).toMatch(/steps\.name\.outputs\.image/);
      expect(attest.with?.["push-to-registry"]).toBe(true);
      expect(attest.with?.["subject-path"]).toBeUndefined();
    });

    it("logs in to GHCR with the job token, checks out without persisted credentials and keeps GitHub expressions out of run: scripts", () => {
      const steps = (parseWorkflow(FILE).jobs.image as Job).steps;
      const login = steps.find((s) => (s.uses ?? "").startsWith("docker/login-action@"));
      expect(login?.with?.registry).toBe("ghcr.io");
      expect(login?.with?.password).toMatch(/secrets\.GITHUB_TOKEN/);
      const checkout = steps.find((s) => (s.uses ?? "").startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
      for (const step of steps) {
        if (typeof step.run === "string") expect(step.run, step.name).not.toContain("${{");
      }
      const summary = steps.find((s) => (s.run ?? "").includes("GITHUB_STEP_SUMMARY"));
      expect(summary?.run).toContain("$IMAGE@$DIGEST");
    });
  });
});
