/**
 * U22 functional-design.md §4 "Developer (each < 1 min)" acceptance tests, extended by
 * the U22 code review round 2 (items 8, 9):
 *
 * 1. `action.yml` and the workflows parse as valid YAML (a node `yaml` script, not a
 *    hand-rolled parser).
 * 2/9. A regex test asserting every `${{ }}` expression inside a `run:` (shell) script
 *    block is either `matrix.*` (a value the workflow author curates, not attacker- or
 *    caller-controlled - e.g. `ci.yml`'s e2e shard name) or absent entirely - every other
 *    value (`inputs.*`, `steps.*.outputs.*`, `steps.*.outcome`, ...) must go through that
 *    step's `env:` mapping and a quoted shell variable instead, never interpolated
 *    directly into the script text by GitHub Actions before the shell ever sees it. This
 *    is the regression guard for Review 1 M7 (see action.yml's own comment on the "Run
 *    x402-redteam" step): an unquoted-at-substitution-time value containing `"` or a
 *    backtick would otherwise let arbitrary shell get spliced into that step.
 * 8. `ci.yml`'s `e2e` job matrix stays in sync with the real
 *    `packages/cli/test/*.e2e.test.ts` files, and every `pnpm install` in `ci.yml` uses
 *    `--frozen-lockfile`.
 *
 * Scoped to `run:` blocks specifically (not every `${{ }}` reference in the file) -
 * `if:`/`with:` values (e.g. `if: ${{ inputs.upload-sarif == 'true' }}`) are evaluated by
 * the Actions runtime itself, never concatenated into shell text, so they aren't the M7
 * hazard this guards against.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const YAML_FILES = ["action.yml", ".github/workflows/self-test.yml", ".github/workflows/ci.yml"];

function readYamlFile(relPath: string): unknown {
  return parse(readFileSync(`${REPO_ROOT}${relPath}`, "utf8"));
}

describe("action.yml and workflow YAML parse (U22 §4 item 1)", () => {
  for (const relPath of YAML_FILES) {
    it(`${relPath} parses as valid YAML`, () => {
      expect(() => readYamlFile(relPath)).not.toThrow();
      const doc = readYamlFile(relPath);
      expect(doc).toBeTypeOf("object");
      expect(doc).not.toBeNull();
    });
  }
});

/** Recursively collects every string value found under a `run:` key, anywhere in the
 * parsed YAML tree (composite action steps, or every job's steps in a workflow). */
function collectRunScripts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRunScripts(item, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "run" && typeof value === "string") {
        out.push(value);
      } else {
        collectRunScripts(value, out);
      }
    }
  }
  return out;
}

/** Every `${{ ... }}` expression found in a run: script's text, trimmed. */
const EXPRESSION_RE = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;

function findDisallowedExpressions(script: string): string[] {
  const disallowed: string[] = [];
  for (const match of script.matchAll(EXPRESSION_RE)) {
    const expr = match[1]?.trim() ?? "";
    // matrix.* is curated by whoever wrote the workflow (a fixed, reviewed list of
    // shard/case names), never attacker- or caller-supplied, so it's the one allowlisted
    // exception to "everything goes through env:".
    if (!/^matrix\./.test(expr)) {
      disallowed.push(match[0]);
    }
  }
  return disallowed;
}

describe("M7 regression guard (§4 item 2, code review item 9): run: scripts allow only matrix.*, everything else via env:", () => {
  for (const relPath of YAML_FILES) {
    it(`${relPath}: every \${{ }} inside a run: script is matrix.* (or absent)`, () => {
      const scripts = collectRunScripts(readYamlFile(relPath));
      for (const script of scripts) {
        expect(findDisallowedExpressions(script)).toEqual([]);
      }
    });
  }

  it("action.yml's own run: scripts are non-empty (the test above isn't vacuous)", () => {
    const scripts = collectRunScripts(readYamlFile("action.yml"));
    expect(scripts.length).toBeGreaterThan(0);
  });

  it("action.yml has zero GitHub Actions expressions anywhere inside a run: script", () => {
    // action.yml (a composite action) has no `matrix` context of its own at all - so for
    // this file specifically, the item-9 allowlist reduces to "none": every dynamic value
    // reaches its run: scripts through env: (plain shell vars) or a quoted Node heredoc
    // reading process.env, never a `${{ }}` expression.
    const scripts = collectRunScripts(readYamlFile("action.yml"));
    for (const script of scripts) {
      expect(script).not.toContain("${{");
    }
  });

  it("the mutually-exclusive agent/guardrail inputs are both only read via env: in the run: step", () => {
    const doc = readYamlFile("action.yml") as {
      runs: { steps: Array<Record<string, unknown>> };
    };
    const runStep = doc.runs.steps.find((step) => step.name === "Run x402-redteam") as Record<
      string,
      unknown
    >;
    expect(runStep).toBeDefined();
    const env = runStep.env as Record<string, string>;
    const envValues = Object.values(env).join("\n");
    expect(envValues).toContain("inputs.agent");
    expect(envValues).toContain("inputs.guardrail");
    expect(envValues).toContain("inputs.host-mode");
    expect(envValues).toContain("inputs.redact");
  });

  it("self-test.yml reads steps.run.outcome via env:, never inline in a run: script", () => {
    const scripts = collectRunScripts(readYamlFile(".github/workflows/self-test.yml"));
    for (const script of scripts) {
      expect(script).not.toMatch(/\$\{\{\s*steps\.run\.outcome\s*\}\}/);
    }
  });
});

describe("ci.yml e2e matrix and install flags (U22 code review round 2, item 8)", () => {
  it("the e2e job's matrix.shard list equals the real packages/cli/test/*.e2e.test.ts basenames", () => {
    const realShards = readdirSync(`${REPO_ROOT}packages/cli/test`)
      .filter((f) => f.endsWith(".e2e.test.ts"))
      .map((f) => f.replace(/\.e2e\.test\.ts$/, ""))
      .sort();

    const doc = readYamlFile(".github/workflows/ci.yml") as {
      jobs: { e2e: { strategy: { matrix: { shard: string[] } } } };
    };
    const matrixShards = [...doc.jobs.e2e.strategy.matrix.shard].sort();

    expect(matrixShards).toEqual(realShards);
    expect(realShards.length).toBeGreaterThan(0);
  });

  it("every `pnpm install` step in ci.yml uses --frozen-lockfile", () => {
    const scripts = collectRunScripts(readYamlFile(".github/workflows/ci.yml"));
    const installLines = scripts
      .flatMap((s) => s.split("\n"))
      .map((l) => l.trim())
      .filter((l) => l.startsWith("pnpm install"));

    expect(installLines.length).toBeGreaterThan(0);
    for (const line of installLines) {
      expect(line).toBe("pnpm install --frozen-lockfile");
    }
  });
});
