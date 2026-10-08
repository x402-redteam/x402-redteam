/**
 * Static checks of the repository-governance workflows: they parse, grant nothing at the
 * top level, never use `pull_request_target`, and keep every `${{ }}` expression out of
 * `run:` scripts (values reach the shell through `env:` only).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOWS = [".github/workflows/pr-hygiene.yml", ".github/workflows/heldout-guard.yml"];

type Workflow = {
  on: Record<string, unknown>;
  permissions: unknown;
  jobs: Record<string, { permissions?: Record<string, string>; environment?: string; if?: string }>;
};

function load(relPath: string): { text: string; doc: Workflow } {
  const text = readFileSync(`${REPO_ROOT}${relPath}`, "utf8");
  return { text, doc: parse(text) as Workflow };
}

function runScripts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) runScripts(item, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "run" && typeof value === "string") out.push(value);
      else runScripts(value, out);
    }
  }
  return out;
}

describe.each(WORKFLOWS)("%s", (relPath) => {
  it("parses, sets top-level permissions: {} and avoids pull_request_target", () => {
    const { text, doc } = load(relPath);
    expect(doc).toBeTypeOf("object");
    expect(doc.permissions).toEqual({});
    expect(Object.keys(doc.on)).not.toContain("pull_request_target");
    expect(text).not.toMatch(/pull_request_target:/);
  });

  it("keeps every GitHub expression out of run: scripts", () => {
    const scripts = runScripts(load(relPath).doc);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toMatch(/\$\{\{/);
  });

  it("disables persisted checkout credentials", () => {
    const { text } = load(relPath);
    expect(text).toMatch(/persist-credentials: false/);
  });
});

describe("pr-hygiene.yml", () => {
  it("grants only contents and pull-requests read", () => {
    const { doc } = load(".github/workflows/pr-hygiene.yml");
    expect(Object.keys(doc.jobs)).toEqual(["pr-hygiene"]);
    expect(doc.jobs["pr-hygiene"]?.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(Object.keys(doc.on)).toEqual(["pull_request"]);
  });

  it("checks out the base commit so the PR cannot edit its own check", () => {
    const { text } = load(".github/workflows/pr-hygiene.yml");
    expect(text).toMatch(/ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  });
});

describe("heldout-guard.yml", () => {
  it("runs on push to main and same-repo PRs in the guard environment", () => {
    const { doc } = load(".github/workflows/heldout-guard.yml");
    expect(doc.on.push).toEqual({ branches: ["main"] });
    expect(Object.keys(doc.on).sort()).toEqual(["pull_request", "push"]);
    const job = doc.jobs.guard;
    expect(job?.environment).toBe("guard");
    expect(job?.permissions).toEqual({ contents: "read" });
    expect(job?.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("runs the base commit's script and HMAC list on PRs", () => {
    const script = runScripts(load(".github/workflows/heldout-guard.yml").doc).join("\n");
    expect(script).toContain(
      'git show "$BASE_SHA:scripts/heldout-guard-ci.mjs" > "$RUNNER_TEMP/g.mjs"',
    );
    expect(script).toContain('git show "$BASE_SHA:.github/heldout-guard.hmac"');
    expect(script).toContain('node "$RUNNER_TEMP/g.mjs" --base "$BASE_SHA" --hmac-file');
  });
});
