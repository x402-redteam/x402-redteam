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
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const WORKFLOW_DIR = ".github/workflows";

/** Every workflow file in the repo, as a repo-relative path. */
const WORKFLOW_FILES = readdirSync(`${REPO_ROOT}${WORKFLOW_DIR}`)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort()
  .map((f) => `${WORKFLOW_DIR}/${f}`);

/** The workflows gated by ADR-018: least privilege, concurrency and a timeout on every job. */
const GATED_WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/self-test.yml",
  ".github/workflows/nightly.yml",
];

const YAML_FILES = ["action.yml", ...GATED_WORKFLOWS];

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

  for (const relPath of [".github/workflows/ci.yml", ".github/workflows/nightly.yml"]) {
    it(`every \`pnpm install\` step in ${relPath} uses --frozen-lockfile`, () => {
      const scripts = collectRunScripts(readYamlFile(relPath));
      const installLines = scripts
        .flatMap((s) => s.split("\n"))
        .map((l) => l.trim())
        .filter((l) => l.startsWith("pnpm install"));

      expect(installLines.length).toBeGreaterThan(0);
      for (const line of installLines) {
        expect(line).toBe("pnpm install --frozen-lockfile");
      }
    });
  }
});

type Step = Record<string, unknown> & {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = Record<string, unknown> & {
  needs?: string | string[];
  steps?: Step[];
  uses?: string;
  if?: string;
  outputs?: Record<string, string>;
  permissions?: unknown;
  strategy?: { matrix?: Record<string, unknown> };
};
type Workflow = Record<string, unknown> & {
  on: Record<string, unknown> | string | string[];
  permissions?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, Job>;
};

function readWorkflow(relPath: string): Workflow {
  return readYamlFile(relPath) as Workflow;
}

function triggers(wf: Workflow): Record<string, unknown> {
  if (typeof wf.on === "string") return { [wf.on]: null };
  if (Array.isArray(wf.on)) return Object.fromEntries(wf.on.map((t) => [t, null]));
  return wf.on;
}

function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function jobOf(wf: Workflow, name: string): Job {
  const job = wf.jobs[name];
  if (job === undefined) throw new Error(`job ${name} is missing`);
  return job;
}

describe("workflow hardening (ADR-018 §4)", () => {
  it("finds every gated workflow file", () => {
    expect(WORKFLOW_FILES).toEqual(expect.arrayContaining(GATED_WORKFLOWS));
  });

  for (const relPath of WORKFLOW_FILES) {
    it(`${relPath} declares top-level permissions`, () => {
      expect(readWorkflow(relPath)).toHaveProperty("permissions");
    });

    it(`${relPath}: every actions/checkout step sets persist-credentials: false`, () => {
      for (const job of Object.values(readWorkflow(relPath).jobs)) {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("actions/checkout@")) {
            expect(step.with?.["persist-credentials"]).toBe(false);
          }
        }
      }
    });

    it(`${relPath}: a push trigger always has a branches filter`, () => {
      const on = triggers(readWorkflow(relPath));
      if ("push" in on) {
        const push = on.push as { branches?: string[] } | null;
        expect(push?.branches?.length ?? 0).toBeGreaterThan(0);
      }
    });
  }

  for (const relPath of GATED_WORKFLOWS) {
    it(`${relPath} grants nothing at the top level (permissions: {})`, () => {
      expect(readWorkflow(relPath).permissions).toEqual({});
    });

    it(`${relPath}: every job declares its own permissions`, () => {
      for (const [name, job] of Object.entries(readWorkflow(relPath).jobs)) {
        expect(job, name).toHaveProperty("permissions");
      }
    });

    it(`${relPath}: every job that runs steps has timeout-minutes`, () => {
      for (const [name, job] of Object.entries(readWorkflow(relPath).jobs)) {
        // A job that calls a reusable workflow (`uses:`) can't set timeout-minutes; the
        // called workflow's own jobs carry it.
        if (job.uses !== undefined) continue;
        expect(job["timeout-minutes"], name).toBeTypeOf("number");
      }
    });
  }

  it("ci.yml groups pull requests by ref and gives each push its own group", () => {
    const wf = readWorkflow(".github/workflows/ci.yml");
    expect(wf.concurrency?.group).toBe(
      `ci-\${{ github.event_name == 'push' && github.sha || github.ref }}`,
    );
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(`\${{ github.ref != 'refs/heads/main' }}`);
  });

  it("nightly.yml cancels superseded runs except on main", () => {
    const wf = readWorkflow(".github/workflows/nightly.yml");
    expect(wf.concurrency?.group).toContain(`\${{ github.ref }}`);
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(`\${{ github.ref != 'refs/heads/main' }}`);
  });

  it("self-test.yml groups by ref and caller event and never cancels a run on main", () => {
    const wf = readWorkflow(".github/workflows/self-test.yml");
    expect(wf.concurrency?.group).toBe(`self-test-\${{ github.ref }}-\${{ github.event_name }}`);
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(`\${{ github.ref != 'refs/heads/main' }}`);
  });
});

describe("ci.yml gating (ADR-018 §1-2)", () => {
  const ci = () => readWorkflow(".github/workflows/ci.yml");

  it("runs on pull_request, push to main and manual dispatch only", () => {
    const on = triggers(ci());
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect((on.push as { branches: string[] }).branches).toEqual(["main"]);
  });

  it("ci-ok needs every other job and runs even when one fails or is skipped", () => {
    const wf = ci();
    const others = Object.keys(wf.jobs)
      .filter((name) => name !== "ci-ok")
      .sort();
    const ciOk = jobOf(wf, "ci-ok");
    expect([...needsOf(ciOk)].sort()).toEqual(others);
    expect(ciOk.if).toBe("always()");
  });

  it("ci-ok reads each job's result and the runtime output through env:", () => {
    const step = (jobOf(ci(), "ci-ok").steps ?? []).find((s) => typeof s.run === "string");
    expect(step?.env).toEqual({
      RUNTIME: `\${{ needs.changes.outputs.runtime }}`,
      CHANGES: `\${{ needs.changes.result }}`,
      FAST: `\${{ needs.fast.result }}`,
      HOST_RESOLUTION: `\${{ needs.host-resolution.result }}`,
      E2E: `\${{ needs.e2e.result }}`,
      SELF_TEST: `\${{ needs.self-test.result }}`,
    });
  });

  describe("ci-ok's check script", () => {
    const script = () => {
      const step = (jobOf(ci(), "ci-ok").steps ?? []).find((s) => typeof s.run === "string");
      return step?.run ?? "";
    };
    const ok = {
      CHANGES: "success",
      FAST: "success",
      HOST_RESOLUTION: "success",
    };
    function runCheck(env: Record<string, string>): number | null {
      return spawnSync("sh", ["-c", script()], { env: { PATH: process.env.PATH, ...env } }).status;
    }

    it.each([
      [
        "runtime change, heavy suites passed",
        { ...ok, RUNTIME: "true", E2E: "success", SELF_TEST: "success" },
        0,
      ],
      [
        "docs-only change, heavy suites skipped",
        { ...ok, RUNTIME: "false", E2E: "skipped", SELF_TEST: "skipped" },
        0,
      ],
      [
        "runtime change, heavy suites skipped",
        { ...ok, RUNTIME: "true", E2E: "skipped", SELF_TEST: "skipped" },
        1,
      ],
      [
        "docs-only change, e2e ran",
        { ...ok, RUNTIME: "false", E2E: "success", SELF_TEST: "skipped" },
        1,
      ],
      ["e2e failed", { ...ok, RUNTIME: "true", E2E: "failure", SELF_TEST: "success" }, 1],
      [
        "self-test cancelled",
        { ...ok, RUNTIME: "true", E2E: "success", SELF_TEST: "cancelled" },
        1,
      ],
      [
        "fast skipped",
        { ...ok, FAST: "skipped", RUNTIME: "false", E2E: "skipped", SELF_TEST: "skipped" },
        1,
      ],
      [
        "changes failed",
        { ...ok, CHANGES: "failure", RUNTIME: "", E2E: "skipped", SELF_TEST: "skipped" },
        1,
      ],
      [
        "host-resolution failed",
        {
          ...ok,
          HOST_RESOLUTION: "failure",
          RUNTIME: "false",
          E2E: "skipped",
          SELF_TEST: "skipped",
        },
        1,
      ],
    ])("%s -> exit %i", (_label, env, expected) => {
      expect(runCheck(env)).toBe(expected);
    });
  });

  it("the changes job classifies paths with scripts/ci-changes.mjs and exposes runtime", () => {
    const changes = jobOf(ci(), "changes");
    expect(changes.outputs).toHaveProperty("runtime");
    const scripts = collectRunScripts(changes).join("\n");
    expect(scripts).toContain(
      'git -c core.quotePath=false diff --no-renames --name-only "$BASE" "$HEAD"',
    );
    expect(scripts).toContain("scripts/ci-changes.mjs");
  });

  for (const name of ["e2e", "self-test"]) {
    it(`${name} runs only when the changes job reports a runtime change`, () => {
      const job = jobOf(ci(), name);
      expect(needsOf(job)).toContain("changes");
      expect(job.if).toBe("needs.changes.outputs.runtime == 'true'");
    });
  }

  it("self-test is called as a reusable workflow", () => {
    expect(jobOf(ci(), "self-test").uses).toBe("./.github/workflows/self-test.yml");
  });

  it("the fast job runs lint, typecheck, coverage, the leaderboard diff and a build", () => {
    const scripts = collectRunScripts(jobOf(ci(), "fast")).join("\n");
    for (const cmd of [
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test:coverage",
      "git diff --exit-code LEADERBOARD.md",
      "pnpm -r build",
    ]) {
      expect(scripts).toContain(cmd);
    }
  });
});

describe("self-test.yml is reusable only (ADR-018 §2)", () => {
  it("triggers on workflow_call and workflow_dispatch, never push or pull_request", () => {
    const on = triggers(readWorkflow(".github/workflows/self-test.yml"));
    expect(Object.keys(on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
  });
});

describe("nightly.yml (ADR-018 §3)", () => {
  const nightly = () => readWorkflow(".github/workflows/nightly.yml");

  it("runs on a schedule and manual dispatch", () => {
    const on = triggers(nightly());
    expect(Object.keys(on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("the unit matrix covers Node 22/24/26 on ubuntu and Node 24 on macOS", () => {
    const matrix = jobOf(nightly(), "unit-matrix").strategy?.matrix as {
      include: Array<{ os: string; node: number }>;
    };
    const legs = matrix.include.map((leg) => `${leg.os}/${leg.node}`).sort();
    expect(legs).toEqual([
      "macos-latest/24",
      "ubuntu-latest/22",
      "ubuntu-latest/24",
      "ubuntu-latest/26",
    ]);
  });

  it("has the full E2E, python agent, audit, ranked dry run and failure report jobs", () => {
    expect(Object.keys(nightly().jobs).sort()).toEqual([
      "audit",
      "e2e-full",
      "python-agent",
      "ranked-dry",
      "report",
      "unit-matrix",
    ]);
  });

  it("runs the full E2E suite as a single invocation", () => {
    const scripts = collectRunScripts(jobOf(nightly(), "e2e-full")).join("\n");
    expect(scripts.match(/pnpm test:e2e/g)).toHaveLength(1);
  });

  it("the python agent job requires the venv instead of skipping", () => {
    const step = (jobOf(nightly(), "python-agent").steps ?? []).find((s) =>
      s.run?.includes("python-agent"),
    );
    expect(step?.env?.X402_REQUIRE_PY_VENV).toBe("1");
  });

  it("only the report job can write issues, and it runs on main when a job failed or was cancelled", () => {
    const wf = nightly();
    for (const [name, job] of Object.entries(wf.jobs)) {
      const perms = (job.permissions ?? {}) as Record<string, string>;
      if (name === "report") {
        expect(perms).toEqual({ issues: "write" });
        expect(job.if).toBe(
          "always() && github.ref == 'refs/heads/main' && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled'))",
        );
        const others = Object.keys(wf.jobs)
          .filter((n) => n !== "report")
          .sort();
        expect([...needsOf(job)].sort()).toEqual(others);
      } else {
        expect(perms.issues, name).toBeUndefined();
      }
    }
  });
});
