/**
 * Static checks of the release pipeline (ADR-021, ADR-022 §2, ADR-024): release.yml's
 * trigger, permissions, environment and step order, and the Action's install and branding.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RELEASE = ".github/workflows/release.yml";

type Step = {
  id?: string;
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  environment?: string;
  concurrency?: unknown;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> };

function read(relPath: string): string {
  return readFileSync(`${REPO_ROOT}${relPath}`, "utf8");
}

const text = read(RELEASE);
const doc = parse(text) as Workflow;
const job = (name: string): Job => {
  const found = doc.jobs[name];
  if (!found) throw new Error(`no ${name} job`);
  return found;
};

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

describe("release.yml", () => {
  it("runs on push to main only and grants nothing at the top level", () => {
    expect(doc.on).toEqual({ push: { branches: ["main"] } });
    expect(doc.permissions).toEqual({});
  });

  it("serialises only the release job, never cancelling it", () => {
    expect((doc as unknown as Record<string, unknown>).concurrency).toBeUndefined();
    expect(job("release").concurrency).toEqual({ group: "release", "cancel-in-progress": false });
  });

  it("has the detect, verify, release, major-tag and image jobs in that dependency order", () => {
    expect(Object.keys(doc.jobs)).toEqual(["detect", "verify", "release", "major-tag", "image"]);
    expect(job("verify").needs).toBe("detect");
    expect(job("release").needs).toEqual(["detect", "verify"]);
    expect(job("major-tag").needs).toEqual(["detect", "release"]);
    expect(job("image").needs).toEqual(["detect", "release"]);
    for (const name of ["verify", "release", "major-tag", "image"]) {
      expect(job(name).if, name).toBe("needs.detect.outputs.release == 'true'");
    }
  });

  it("detect reads only contents and exposes release and version", () => {
    expect(job("detect").permissions).toEqual({ contents: "read" });
    expect(Object.keys(job("detect").outputs ?? {}).sort()).toEqual(["release", "version"]);
    expect(runScripts(job("detect")).join("\n")).toContain("node scripts/release/detect.mjs");
  });

  it("verify runs the full CI workflow on the release commit", () => {
    expect(job("verify").uses).toBe("./.github/workflows/ci.yml");
    expect(job("verify").permissions).toEqual({ contents: "read" });
  });

  it("the release job runs in the release environment with only the permissions it needs", () => {
    expect(job("release").environment).toBe("release");
    expect(job("release").permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
      "pull-requests": "read",
    });
  });

  it("major-tag moves the tag through the REST API with contents: write only", () => {
    expect(job("major-tag").permissions).toEqual({ contents: "write" });
    expect(job("major-tag").environment).toBeUndefined();
    const script = runScripts(job("major-tag")).join("\n");
    expect(script).toContain("major=");
    expect(script).toMatch(
      /gh api -X PATCH "repos\/\$GITHUB_REPOSITORY\/git\/refs\/tags\/\$major"/,
    );
    expect(script).toMatch(/gh api -X POST "repos\/\$GITHUB_REPOSITORY\/git\/refs"/);
  });

  it("image delegates to release-image.yml with the version and the permissions its job needs", () => {
    expect(job("image").uses).toBe("./.github/workflows/release-image.yml");
    expect(job("image").with).toEqual({ version: `\${{ needs.detect.outputs.version }}` });
    expect(job("image").permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
      attestations: "write",
    });
  });

  it("keeps every GitHub expression out of run: scripts", () => {
    const scripts = runScripts(doc);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toMatch(/\$\{\{/);
  });

  it("every checkout sets persist-credentials: false", () => {
    const blocks = text.split("uses: actions/checkout@").slice(1);
    expect(blocks.length).toBe(2);
    for (const block of blocks)
      expect(block).toMatch(/^[^\n]*\n\s+with:\n\s+persist-credentials: false/);
  });

  const steps = job("release").steps ?? [];
  const index = (pred: (s: Step) => boolean, label: string) => {
    const i = steps.findIndex(pred);
    expect(i, label).toBeGreaterThan(-1);
    return i;
  };

  it("checks the version and that the commit was merged from a release/v* PR into main", () => {
    const check = index((s) => s.run?.includes("version.mjs --check") === true, "check");
    const script = steps[check]?.run ?? "";
    expect(script).toContain("commits/$GITHUB_SHA/pulls");
    expect(script).toContain('.base.ref == "main"');
    expect(script).toContain("grep -q '^release/v'");
  });

  it("skips build and publish when the release is already published at this commit", () => {
    const existing = index((s) => s.id === "existing", "existing");
    const check = index((s) => s.run?.includes("version.mjs --check") === true, "check");
    const script = steps[existing]?.run ?? "";
    expect(check).toBeLessThan(existing);
    expect(script).toContain("git/ref/tags/v$VERSION");
    expect(script).toContain('gh release view "v$VERSION"');
    expect(script).toMatch(/\[ "\$draft" = "false" \] && \[ "\$tag_sha" = "\$GITHUB_SHA" \]/);
    expect(script).toContain("skip=true");
    for (const step of steps.slice(existing + 1)) {
      expect(step.if, step.name).toBe("steps.existing.outputs.skip == 'false'");
    }
  });

  it("attests the assets, writes *.sigstore.json bundles, then creates a draft and publishes it", () => {
    const provenance = index(
      (s) => s.uses?.startsWith("actions/attest@") === true && !s.with?.["sbom-path"],
      "provenance",
    );
    const sbom = index(
      (s) =>
        s.uses?.startsWith("actions/attest@") === true &&
        s.with?.["sbom-path"] === "dist/sbom.spdx.json",
      "sbom",
    );
    const bundles = index(
      (s) => s.run?.includes(".sigstore.json") === true && s.run.includes("cp "),
      "bundles",
    );
    const draft = index(
      (s) => /gh release create "v\$VERSION"[\s\S]*--draft/.test(s.run ?? ""),
      "draft",
    );
    const publish = index(
      (s) => /gh release edit "v\$VERSION"[^\n]*--draft=false/.test(s.run ?? ""),
      "publish",
    );
    expect(provenance).toBeLessThan(bundles);
    expect(sbom).toBeLessThan(bundles);
    expect(bundles).toBeLessThan(draft);
    expect(draft).toBeLessThan(publish);
    expect(publish).toBe(steps.length - 1);

    const draftScript = steps[draft]?.run ?? "";
    expect(draftScript).toContain('--target "$GITHUB_SHA"');
    expect(draftScript).toContain("--notes-file dist/notes.md");
    expect(draftScript.match(/\.sigstore\.json/g)?.length).toBe(3);
    expect(draftScript).toContain("dist/sbom.spdx.json");
  });

  it("builds the notes from CHANGELOG.md and never pushes with git", () => {
    const scripts = runScripts(doc).join("\n");
    expect(scripts).toContain('node scripts/release/notes.mjs "$VERSION"');
    expect(scripts).not.toMatch(/git push/);
    expect(scripts).not.toMatch(/npm publish/);
  });
});

describe("action.yml release packaging", () => {
  const action = parse(read("action.yml")) as {
    branding?: { icon?: string; color?: string };
    runs: { steps: Step[] };
  };

  it("carries Marketplace branding", () => {
    expect(action.branding).toEqual({ icon: "shield", color: "red" });
  });

  it("installs production dependencies only, without install scripts", () => {
    const installs = action.runs.steps
      .flatMap((s) => (s.run ?? "").split("\n"))
      .map((l) => l.trim())
      .filter((l) => l.startsWith("pnpm install"));
    expect(installs).toEqual(["pnpm install --frozen-lockfile --prod --ignore-scripts"]);
  });

  it("puts the CLI package's bin directory, where the production install places tsx, on PATH", () => {
    expect(read("action.yml")).toContain("$ACTION_PATH/packages/cli/node_modules/.bin");
  });
});
