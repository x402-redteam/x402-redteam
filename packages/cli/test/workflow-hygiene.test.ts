/**
 * U27 §1.1, §1.2 and §2: release hardening of the Action and the workflows.
 *
 * - `action.yml` passes the artifact directory as a step output, never through
 *   `GITHUB_ENV`.
 * - `ranked-run.yml` grants `contents: read` at the top level; only a separate attest
 *   job holds `id-token`/`attestations`, and it never runs the guardrail.
 * - Every job has a `name:`, every `permissions:` entry has a comment, and the release,
 *   verify-results and ranked-run workflows queue rather than cancel.
 * - `.github/zizmor.yml` disables the self-repository rule, with a comment.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RESULT_ID_PATTERN } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOW_DIR = ".github/workflows";
const WORKFLOWS = readdirSync(`${REPO_ROOT}${WORKFLOW_DIR}`)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort()
  .map((f) => `${WORKFLOW_DIR}/${f}`);

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string> | string;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  permissions?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, Job>;
}

function read(relPath: string): string {
  return readFileSync(`${REPO_ROOT}${relPath}`, "utf8");
}

function workflow(relPath: string): Workflow {
  return parse(read(relPath)) as Workflow;
}

describe("action.yml artifact directory (U27 §1.1)", () => {
  const text = read("action.yml");
  const doc = parse(text) as { runs: { steps: Step[] } };

  it("never writes to GITHUB_ENV", () => {
    expect(text).not.toContain("GITHUB_ENV");
    expect(text).not.toContain("env.X402_REDTEAM_ARTIFACT_DIR");
  });

  it("the prepare step writes the directory as a step output and the upload reads it", () => {
    const prepare = doc.runs.steps.find((s) => s.name?.startsWith("Prepare artifact contents"));
    expect(prepare?.id).toBe("artifact");
    expect(prepare?.run).toContain('echo "dir=$staging/out" >> "$GITHUB_OUTPUT"');
    const upload = doc.runs.steps.find((s) => s.name === "Upload report artifact");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Actions expression
    expect(upload?.with?.path).toBe("${{ steps.artifact.outputs.dir }}");
  });
});

describe("ranked-run.yml least privilege (U27 §1.2)", () => {
  const doc = workflow(`${WORKFLOW_DIR}/ranked-run.yml`);
  const runsGuardrail = (job: Job) => (job.steps ?? []).some((s) => s.run?.includes("docker run"));
  const attests = (job: Job) =>
    (job.steps ?? []).some((s) => s.uses?.startsWith("actions/attest@") === true);

  it("grants only contents: read at the top level", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
  });

  it("the job that runs the guardrail holds no attestation permissions and attests nothing", () => {
    const [name, job] = Object.entries(doc.jobs).find(([, j]) => runsGuardrail(j)) ?? [];
    expect(name).toBe("ranked-run");
    expect(job?.environment).toBe("ranked");
    expect(job?.permissions).toEqual({ contents: "read" });
    expect(job && attests(job)).toBe(false);
  });

  it("a separate attest job, after the run, is the only one with id-token and attestations", () => {
    const attest = doc.jobs.attest;
    expect(attest?.needs).toBe("ranked-run");
    expect(attest?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(attest && runsGuardrail(attest)).toBe(false);
    expect(attest && attests(attest)).toBe(true);
    for (const [name, job] of Object.entries(doc.jobs)) {
      if (name === "attest") continue;
      const perms = typeof job.permissions === "object" ? job.permissions : {};
      expect(perms["id-token"], name).toBeUndefined();
      expect(perms.attestations, name).toBeUndefined();
    }
  });

  it("the attest job gets the image and commit from the run job's outputs", () => {
    const outputs = doc.jobs["ranked-run"]?.outputs ?? {};
    expect(Object.keys(outputs).sort()).toEqual(["guardrail-id", "harness-commit", "ranked-image"]);
    const text = read(`${WORKFLOW_DIR}/ranked-run.yml`);
    expect(text).toContain("needs.ranked-run.outputs.ranked-image");
    expect(text).toContain("needs.ranked-run.outputs.harness-commit");
  });
});

describe("workflow hygiene (U27 §2)", () => {
  it("every job has a name", () => {
    for (const file of WORKFLOWS) {
      for (const [id, job] of Object.entries(workflow(file).jobs)) {
        expect(typeof job.name === "string" && job.name.length > 0, `${file}: ${id}`).toBe(true);
      }
    }
  });

  it("every permissions entry carries a comment saying why it is needed", () => {
    for (const file of WORKFLOWS) {
      const lines = read(file).split("\n");
      lines.forEach((line, index) => {
        const header = /^(\s*)permissions:\s*(#.*)?$/.exec(line);
        if (!header) return;
        const indent = header[1]?.length ?? 0;
        for (let i = index + 1; i < lines.length; i++) {
          const entry = lines[i] ?? "";
          if (entry.trim() === "" || entry.trim().startsWith("#")) continue;
          if ((/^(\s*)/.exec(entry)?.[1]?.length ?? 0) <= indent) break;
          expect(entry, `${file}:${i + 1}`).toMatch(/^\s+[a-z-]+:\s*(read|write|none)\s+#\s*\S/);
        }
      });
    }
  });

  it("release, verify-results and ranked-run queue instead of cancelling", () => {
    for (const name of ["release.yml", "verify-results.yml", "ranked-run.yml"]) {
      const doc = workflow(`${WORKFLOW_DIR}/${name}`);
      expect(doc.concurrency?.group, name).toBeTypeOf("string");
      expect(doc.concurrency?.["cancel-in-progress"], name).toBe(false);
    }
  });

  it("ranked runs are grouped per guardrail id", () => {
    const doc = workflow(`${WORKFLOW_DIR}/ranked-run.yml`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Actions expression
    expect(doc.concurrency?.group).toContain("${{ inputs.guardrail-id }}");
  });

  it(".github/zizmor.yml disables self-repository with a comment", () => {
    const text = read(".github/zizmor.yml");
    const doc = parse(text) as { rules?: Record<string, { disable?: boolean }> };
    expect(doc.rules?.["self-repository"]?.disable).toBe(true);
    const lines = text.split("\n");
    const at = lines.findIndex((l) => /^\s*self-repository:/.test(l));
    expect(lines[at - 1] ?? "").toMatch(/^\s*#\s*\S/);
  });
});

describe("result ids in the ranked workflows and the Action (U27 review)", () => {
  for (const name of ["rank.yml", "ranked-run.yml"]) {
    it(`${name} validates guardrail-id against RESULT_ID_PATTERN`, () => {
      const doc = workflow(`${WORKFLOW_DIR}/${name}`);
      const steps = Object.values(doc.jobs).flatMap((job) => job.steps ?? []);
      const validate = steps.find((s) => s.name?.startsWith("Validate"));
      expect(validate?.run).toBeTypeOf("string");
      const declared = /id_pattern='([^']+)'/.exec(validate?.run ?? "")?.[1];
      expect(declared).toBe(RESULT_ID_PATTERN.source);
      expect(validate?.run).toContain('"$GUARDRAIL_ID"');
      expect(validate?.run).toContain("LC_ALL=C");
    });
  }

  /** The derivation block in action.yml's run step, run with a given repository name. */
  function deriveAgentId(repository: string, agentId = ""): string {
    const run = (parse(read("action.yml")) as { runs: { steps: Step[] } }).runs.steps
      .map((s) => s.run ?? "")
      .find((r) => r.includes("# agent-id default: begin"));
    const block = /# agent-id default: begin\n([\s\S]*?)# agent-id default: end/.exec(
      run ?? "",
    )?.[1];
    expect(block).toBeTypeOf("string");
    const result = spawnSync("bash", ["-c", `${block}\nprintf '%s' "$AGENT_ID"`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_REPOSITORY: repository, AGENT_ID: agentId },
    });
    expect(result.status).toBe(0);
    return result.stdout;
  }

  it("action.yml derives a valid default agent-id from the repository", () => {
    expect(deriveAgentId("Owner/My_Repo.v2")).toBe("owner-my_repo.v2");
    expect(deriveAgentId("Owner/a+b c")).toBe("owner-a-b-c");
    const long = deriveAgentId(`owner/${"x".repeat(100)}`);
    expect(long).toHaveLength(64);
    for (const repo of ["Owner/My_Repo.v2", "UPPER/Case", `o/${"y".repeat(80)}`]) {
      expect(deriveAgentId(repo)).toMatch(RESULT_ID_PATTERN);
    }
  });

  it("action.yml keeps an explicit agent-id and states the rule in the input description", () => {
    expect(deriveAgentId("Owner/Repo", "my-agent")).toBe("my-agent");
    const inputs = (
      parse(read("action.yml")) as {
        inputs: Record<string, { default?: string; description: string }>;
      }
    ).inputs;
    expect(inputs["agent-id"]?.default).toBe("");
    expect(inputs["agent-id"]?.description).toContain(RESULT_ID_PATTERN.source);
    expect(inputs["guardrail-id"]?.description).toContain(RESULT_ID_PATTERN.source);
  });
});
