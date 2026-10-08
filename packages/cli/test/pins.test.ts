/**
 * Action pins and workflow hardening (ADR-019).
 *
 * - Every `uses:` in `action.yml` and `.github/workflows/*.yml` is either a local
 *   `./…` reference or `owner/repo[/path]@<40-hex commit SHA> # vX.Y.Z`.
 * - The same action at the same version resolves to the same SHA everywhere.
 * - Each action is on a Node-24-runtime major or newer; `attest-build-provenance` is
 *   replaced by `actions/attest`.
 * - `.github/dependabot.yml` covers github-actions, npm and docker, each with a cooldown.
 * - The security workflows grant no permissions at the top level, grant per job, and
 *   keep `${{ }}` expressions out of `run:` scripts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const WORKFLOW_DIR = ".github/workflows";
const PINNED_FILES = [
  "action.yml",
  ...readdirSync(`${REPO_ROOT}${WORKFLOW_DIR}`)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `${WORKFLOW_DIR}/${name}`),
];

/** Oldest major of each action whose `runs.using` is node24. */
const MINIMUM_MAJOR: Record<string, number> = {
  "actions/checkout": 7,
  "actions/setup-node": 7,
  "actions/setup-python": 7,
  "actions/upload-artifact": 7,
  "actions/download-artifact": 8,
  "actions/attest": 4,
  "pnpm/action-setup": 6,
  "github/codeql-action": 4,
};

const PIN_PATTERN =
  /^(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?<subpath>\/[A-Za-z0-9_./-]+)?@(?<sha>[0-9a-f]{40}) # (?<version>v\d+\.\d+\.\d+)$/;

interface UsesLine {
  file: string;
  line: number;
  value: string;
}

function read(relPath: string): string {
  return readFileSync(`${REPO_ROOT}${relPath}`, "utf8");
}

/** Every `uses:` key in a file, as raw text (so the trailing version comment is kept). */
function usesLines(relPath: string): UsesLine[] {
  const out: UsesLine[] = [];
  read(relPath)
    .split("\n")
    .forEach((text, index) => {
      const match = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/.exec(text);
      if (match?.[1]) out.push({ file: relPath, line: index + 1, value: match[1] });
    });
  return out;
}

/** Every `uses` value in the parsed YAML tree, to cross-check the line scan. */
function parsedUses(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) parsedUses(item, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "uses" && typeof value === "string") out.push(value);
      else parsedUses(value, out);
    }
  }
  return out;
}

const ALL_USES = PINNED_FILES.flatMap(usesLines);
const REMOTE_USES = ALL_USES.filter((u) => !u.value.startsWith("./"));

describe("action pins", () => {
  it("scans action.yml and every workflow file", () => {
    expect(PINNED_FILES).toContain("action.yml");
    expect(PINNED_FILES).toContain(`${WORKFLOW_DIR}/codeql.yml`);
    expect(PINNED_FILES).toContain(`${WORKFLOW_DIR}/scorecard.yml`);
    expect(PINNED_FILES).toContain(`${WORKFLOW_DIR}/zizmor.yml`);
    expect(REMOTE_USES.length).toBeGreaterThan(0);
  });

  for (const file of PINNED_FILES) {
    it(`${file}: the line scan finds every parsed uses: value`, () => {
      const fromYaml = parsedUses(parse(read(file))).sort();
      const fromLines = usesLines(file)
        .map((u) => u.value.replace(/\s+#.*$/, ""))
        .sort();
      expect(fromLines).toEqual(fromYaml);
    });
  }

  it("every remote uses: is pinned to a 40-hex commit SHA with a # vX.Y.Z comment", () => {
    const unpinned = REMOTE_USES.filter((u) => !PIN_PATTERN.test(u.value)).map(
      (u) => `${u.file}:${u.line} ${u.value}`,
    );
    expect(unpinned).toEqual([]);
  });

  it("the same action at the same version uses the same SHA in every file", () => {
    const shaByKey = new Map<string, Set<string>>();
    for (const u of REMOTE_USES) {
      const groups = PIN_PATTERN.exec(u.value)?.groups;
      if (!groups) continue;
      const key = `${groups.repo}@${groups.version}`;
      const shas = shaByKey.get(key) ?? new Set<string>();
      shas.add(groups.sha as string);
      shaByKey.set(key, shas);
    }
    const conflicting = [...shaByKey].filter(([, shas]) => shas.size > 1).map(([key]) => key);
    expect(conflicting).toEqual([]);
  });

  it("every action is on a node24-runtime major or newer", () => {
    const outdated = REMOTE_USES.flatMap((u) => {
      const groups = PIN_PATTERN.exec(u.value)?.groups;
      if (!groups) return [];
      const minimum = MINIMUM_MAJOR[groups.repo as string];
      const major = Number(/^v(\d+)/.exec(groups.version as string)?.[1]);
      return minimum !== undefined && major < minimum ? [`${u.file}:${u.line} ${u.value}`] : [];
    });
    expect(outdated).toEqual([]);
  });

  it("no workflow uses attest-build-provenance (actions/attest replaces it)", () => {
    const wrapped = ALL_USES.filter((u) => u.value.includes("attest-build-provenance"));
    expect(wrapped).toEqual([]);
  });

  it("the ranked workflows attest with actions/attest by subject-path", () => {
    for (const file of [`${WORKFLOW_DIR}/rank.yml`, `${WORKFLOW_DIR}/ranked-run.yml`]) {
      const doc = parse(read(file)) as {
        jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
      };
      const attestSteps = Object.values(doc.jobs).flatMap((job) =>
        (job.steps ?? []).filter((step) => step.uses?.startsWith("actions/attest@")),
      );
      expect(attestSteps.length, file).toBeGreaterThan(0);
      for (const step of attestSteps) {
        expect(typeof step.with?.["subject-path"], file).toBe("string");
      }
    }
  });

  it("zizmor-action runs a pinned zizmor version", () => {
    const doc = parse(read(`${WORKFLOW_DIR}/zizmor.yml`)) as {
      jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
    };
    const step = Object.values(doc.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((s) => s.uses?.startsWith("zizmorcore/zizmor-action@"));
    expect(String(step?.with?.version)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("dependabot.yml", () => {
  interface UpdateEntry {
    "package-ecosystem": string;
    directory?: string;
    directories?: string[];
    cooldown?: { "default-days"?: number; "semver-major-days"?: number };
    groups?: Record<string, { patterns?: string[]; "exclude-patterns"?: string[] }>;
    ignore?: { "dependency-name": string; "update-types"?: string[] }[];
  }
  const doc = parse(read(".github/dependabot.yml")) as {
    version: number;
    updates: UpdateEntry[];
  };
  const byEcosystem = (name: string): UpdateEntry => {
    const entry = doc.updates.find((u) => u["package-ecosystem"] === name);
    if (!entry) throw new Error(`no ${name} entry`);
    return entry;
  };

  it("is version 2 with github-actions, npm and docker entries, each with a cooldown", () => {
    expect(doc.version).toBe(2);
    expect(doc.updates.map((u) => u["package-ecosystem"]).sort()).toEqual([
      "docker",
      "github-actions",
      "npm",
    ]);
    for (const entry of doc.updates) {
      expect(entry.cooldown?.["default-days"], entry["package-ecosystem"]).toBe(7);
    }
    expect(byEcosystem("github-actions").cooldown?.["semver-major-days"]).toBe(14);
    expect(byEcosystem("npm").cooldown?.["semver-major-days"]).toBe(14);
  });

  it("github-actions covers the root composite action and the workflows directory", () => {
    expect(byEcosystem("github-actions").directories).toEqual(["/", "/.github/workflows"]);
  });

  it("docker watches the ranked image", () => {
    expect(byEcosystem("docker").directory).toBe("/.github/ranked");
  });

  it("npm keeps @x402/* in its own group and holds typescript and @types/node majors", () => {
    const npm = byEcosystem("npm");
    expect(npm.groups?.x402?.patterns).toEqual(["@x402/*"]);
    for (const [name, group] of Object.entries(npm.groups ?? {})) {
      if (name !== "x402") expect(group["exclude-patterns"], name).toContain("@x402/*");
    }
    const ignored = (npm.ignore ?? []).map((i) => [i["dependency-name"], i["update-types"]]);
    expect(ignored).toContainEqual(["typescript", ["version-update:semver-major"]]);
    expect(ignored).toContainEqual(["@types/node", ["version-update:semver-major"]]);
  });

  it("no workflow auto-merges update PRs", () => {
    for (const file of PINNED_FILES) {
      const text = read(file);
      expect(text, file).not.toContain("dependabot/fetch-metadata");
      expect(text, file).not.toMatch(/gh pr merge[^\n]*--auto/);
    }
  });
});

describe("security workflows", () => {
  const SECURITY_WORKFLOWS = ["codeql.yml", "scorecard.yml", "zizmor.yml"].map(
    (name) => `${WORKFLOW_DIR}/${name}`,
  );

  interface Workflow {
    permissions?: unknown;
    jobs: Record<string, { permissions?: Record<string, string>; steps: { run?: string }[] }>;
  }

  for (const file of SECURITY_WORKFLOWS) {
    const doc = parse(read(file)) as Workflow;

    it(`${file}: top-level permissions are empty and every job grants its own`, () => {
      expect(doc.permissions).toEqual({});
      for (const [name, job] of Object.entries(doc.jobs)) {
        expect(job.permissions, name).toBeTypeOf("object");
        expect(Object.keys(job.permissions ?? {}).length, name).toBeGreaterThan(0);
      }
    });

    it(`${file}: no \${{ }} expression inside a run: script`, () => {
      const scripts = Object.values(doc.jobs).flatMap((job) =>
        job.steps.map((s) => s.run).filter((r): r is string => typeof r === "string"),
      );
      for (const script of scripts) expect(script).not.toContain("${{");
    });

    it(`${file}: every checkout sets persist-credentials: false`, () => {
      const blocks = read(file).split("uses: actions/checkout@").slice(1);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(block).toMatch(/persist-credentials:\s*false/);
    });
  }

  it("scorecard.yml grants id-token: write only to its analysis job and publishes results", () => {
    const doc = parse(read(`${WORKFLOW_DIR}/scorecard.yml`)) as {
      permissions: unknown;
      jobs: Record<
        string,
        {
          permissions?: Record<string, string>;
          steps: { uses?: string; with?: Record<string, unknown> }[];
        }
      >;
    };
    expect(doc.permissions).toEqual({});
    expect(Object.keys(doc.jobs)).toEqual(["analysis"]);
    const analysis = doc.jobs.analysis;
    if (!analysis) throw new Error("no analysis job");
    expect(analysis.permissions?.["id-token"]).toBe("write");
    const scorecard = analysis.steps.find((s) => s.uses?.startsWith("ossf/scorecard-action@"));
    expect(scorecard?.with?.publish_results).toBe(true);
  });

  it("codeql.yml analyses javascript-typescript, actions and python with security-extended", () => {
    const doc = parse(read(`${WORKFLOW_DIR}/codeql.yml`)) as {
      jobs: {
        analyze: {
          strategy: { matrix: { language: string[] } };
          steps: { uses?: string; with?: Record<string, unknown> }[];
        };
      };
    };
    expect(doc.jobs.analyze.strategy.matrix.language).toEqual([
      "javascript-typescript",
      "actions",
      "python",
    ]);
    const init = doc.jobs.analyze.steps.find((s) =>
      s.uses?.startsWith("github/codeql-action/init@"),
    );
    expect(init?.with?.queries).toBe("security-extended");
    expect(init?.with?.["build-mode"]).toBe("none");
  });

  it("zizmor.yml verifies the actionlint binary against a pinned sha256 before running it", () => {
    const text = read(`${WORKFLOW_DIR}/zizmor.yml`);
    expect(text).toMatch(/ACTIONLINT_SHA256: [0-9a-f]{64}\n/);
    expect(text).toMatch(/sha256sum --check --strict/);
    expect(text).toMatch(/persona: pedantic/);
  });
});
