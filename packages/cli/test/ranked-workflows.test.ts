import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

  /** Returns one step's own block (its `- name:` line through the next top-level
   * `- name:` or end of file), for asserting on that step's `env:`/`run:` text in
   * isolation from every other step. */
  function stepBlockContaining(text: string, marker: string): string {
    const markerIndex = text.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const start = text.lastIndexOf("\n      - name:", markerIndex);
    const rest = text.slice(start + 1);
    const nextIndex = rest.indexOf("\n      - name:", 1);
    return nextIndex === -1 ? rest : rest.slice(0, nextIndex);
  }

  it("the ranked Dockerfile declares a HARNESS_COMMIT build arg exported as X402_HARNESS_COMMIT", () => {
    const text = readFileSync(resolve(REPO_ROOT, ".github/ranked/Dockerfile"), "utf8");
    expect(text).toMatch(/^ARG HARNESS_COMMIT/m);
    expect(text).toMatch(/^ENV X402_HARNESS_COMMIT=\$\{HARNESS_COMMIT\}/m);
  });

  it("rank.yml passes the checked-out harness's own commit as a HARNESS_COMMIT build arg via env, with no GitHub expression inside the run block", () => {
    const text = readWorkflow(".github/workflows/rank.yml");
    const block = stepBlockContaining(text, "docker build -t x402-redteam-ranked");
    expect(block).toMatch(/HARNESS_COMMIT:\s*\$\{\{\s*env\.HARNESS_COMMIT\s*\}\}/);
    expect(block).toContain('--build-arg HARNESS_COMMIT="$HARNESS_COMMIT"');
    const runLines = block.slice(block.indexOf("run:"));
    expect(runLines).not.toMatch(/\$\{\{/);
  });

  it("ranked-run.yml passes the checked-out harness's own commit as a HARNESS_COMMIT build arg via env, with no GitHub expression inside the run block", () => {
    const text = readWorkflow(".github/workflows/ranked-run.yml");
    expect(text).toContain(
      'echo "HARNESS_COMMIT=$(git -C harness rev-parse HEAD)" >> "$GITHUB_ENV"',
    );
    const block = stepBlockContaining(text, "docker build -t x402-redteam-ranked");
    expect(block).toMatch(/HARNESS_COMMIT:\s*\$\{\{\s*env\.HARNESS_COMMIT\s*\}\}/);
    expect(block).toContain('--build-arg HARNESS_COMMIT="$HARNESS_COMMIT"');
    const runLines = block.slice(block.indexOf("run:"));
    expect(runLines).not.toMatch(/\$\{\{/);
  });
});
