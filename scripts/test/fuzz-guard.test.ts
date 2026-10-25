import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generate } from "../../packages/fuzz/src/index.js";
import { FUZZ_PRIVATE_MARKER as SCHEMA_MARKER } from "../../packages/schema/src/fuzz-private.js";
import {
  FUZZ_PRIVATE_MARKER,
  hasFuzzTechnique,
  isCommittedCorpusFuzzPath,
  isFuzzOutputPath,
  isPublicCataloguePath,
  violationsFor,
} from "../fuzz-guard.mjs";

const SCRIPT = fileURLToPath(new URL("../fuzz-guard.mjs", import.meta.url));
const FUZZ_YAML = "id: g1\ntechnique: fuzz:amount_overflow\n";
const PLAIN_YAML = "id: g1\ntechnique: address_poisoning\n";

describe("fuzz output paths", () => {
  it.each([
    "fuzz-out/run1/diff.json",
    "a/b/fuzz-out/x.txt",
    "x.fuzz/manifest.json",
    "deep/seed7.fuzz/cases/a.yaml",
  ])("refuses %s", (p) => {
    expect(isFuzzOutputPath(p)).toBe(true);
  });

  it.each(["fuzz-output.txt", "packages/fuzz/src/gen.ts", "notfuzz/x.json", "a.fuzz", "fuzz-out"])(
    "allows %s",
    (p) => {
      expect(isFuzzOutputPath(p)).toBe(false);
    },
  );
});

describe("fuzz: technique", () => {
  it.each([
    "technique: fuzz:a",
    "  technique: 'fuzz:a'",
    'technique: "fuzz:a"',
    "- technique: fuzz:a",
    '{"technique": "fuzz:a"}',
    "id: x\ntechnique:   fuzz:b\nfoo: 1",
  ])("detects %j", (t) => {
    expect(hasFuzzTechnique(t)).toBe(true);
  });

  it.each(["technique: address_poisoning", "fuzz: x"])("ignores %j", (t) => {
    expect(hasFuzzTechnique(t)).toBe(false);
  });

  it("allows it only under the public catalogue", () => {
    expect(isPublicCataloguePath("packages/fuzz/catalogue-public/a.yaml")).toBe(true);
    expect(isPublicCataloguePath("packages/fuzz/catalogue/a.yaml")).toBe(false);
    expect(violationsFor("packages/fuzz/catalogue-public/a.yaml", () => FUZZ_YAML)).toEqual([]);
    expect(violationsFor("corpus/a/a.yaml", () => FUZZ_YAML)).toHaveLength(1);
    expect(violationsFor("corpus/a/a.yaml", () => PLAIN_YAML)).toEqual([]);
  });

  it("does not read non-scenario files", () => {
    const read = () => {
      throw new Error("must not read");
    };
    expect(violationsFor("src/x.ts", read)).toEqual([]);
    expect(violationsFor("data.csv", read)).toEqual([]);
  });

  it("scans .jsonl for a fuzz: technique", () => {
    expect(violationsFor("a/b.jsonl", () => '{"technique":"fuzz:x"}\n')).toHaveLength(1);
  });
});

describe("private marker", () => {
  it("equals the schema's constant", () => {
    expect(FUZZ_PRIVATE_MARKER).toBe(SCHEMA_MARKER);
  });

  it.each(["a.yaml", "a.yml", "out/a.json", "x/a.jsonl", "triage.md"])(
    "refuses a marked %s anywhere",
    (p) => {
      expect(violationsFor(p, () => `# ${FUZZ_PRIVATE_MARKER}\nid: x\n`)).toHaveLength(1);
    },
  );

  it("allows a marked file under the public catalogue, and ignores unmarked text", () => {
    expect(
      violationsFor(
        "packages/fuzz/catalogue-public/c.json",
        () => `{"${FUZZ_PRIVATE_MARKER}":true}`,
      ),
    ).toEqual([]);
    expect(violationsFor("triage.md", () => "nothing here")).toEqual([]);
  });
});

describe("fuzz- scenarios in the committed corpora (U30-4, N2)", () => {
  it.each([
    "corpus/fuzz-a.yaml",
    "corpus/sub/fuzz-a.yml",
    "corpus-mcp/fuzz-a.yaml",
    "corpus-mcp/nested/fuzz-get-report.yaml",
  ])("refuses %s", (p) => {
    expect(isCommittedCorpusFuzzPath(p)).toBe(true);
    expect(violationsFor(p, () => PLAIN_YAML)).toHaveLength(1);
  });

  it.each([
    "corpus/mcp-fuzzy.yaml",
    "corpus/not-fuzz-a.yaml",
    "corpus-mcp/mcp-control-paid-tool.yaml",
    "packages/fuzz/catalogue-public/fuzz-a.yaml",
    "examples/corpus/fuzz-a.yaml",
    "corpus/fuzz-a.txt",
  ])("allows %s", (p) => {
    expect(isCommittedCorpusFuzzPath(p)).toBe(false);
    expect(violationsFor(p, () => PLAIN_YAML)).toEqual([]);
  });

  it("a generated mcp scenario with a fuzz: technique is refused wherever it is committed", () => {
    const generated = "id: fuzz-get-report\ntechnique: fuzz:get-report\ntransport: mcp\n";
    expect(violationsFor("corpus-mcp/anything.yaml", () => generated)).toHaveLength(1);
    expect(violationsFor("corpus/anything.yaml", () => generated)).toHaveLength(1);
  });
});

describe("generated corpus-mcp output (U30-4, build condition 3)", () => {
  /** Every file `fuzz --shape mcp` writes for the public catalogue, as {relative path: text}. */
  function generated(): Record<string, string> {
    const out = mkdtempSync(join(tmpdir(), "fuzz-guard-mcp-"));
    try {
      generate({
        catalogueDir: fileURLToPath(
          new URL("../../packages/fuzz/catalogue-public", import.meta.url),
        ),
        shape: "mcp",
        outDir: out,
      });
      const files: Record<string, string> = {};
      const walk = (rel: string) => {
        for (const e of readdirSync(join(out, rel), { withFileTypes: true })) {
          const r = join(rel, e.name);
          if (e.isDirectory()) walk(r);
          else files[r] = readFileSync(join(out, r), "utf8");
        }
      };
      walk("");
      return files;
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  it("is refused under a fuzz output directory", () => {
    const files = generated();
    expect(Object.keys(files).some((f) => f.startsWith("corpus-mcp/"))).toBe(true);
    for (const rel of Object.keys(files)) {
      expect(violationsFor(`seed7.fuzz/gen/${rel}`, () => files[rel] as string)).toHaveLength(1);
      expect(violationsFor(`fuzz-out/${rel}`, () => files[rel] as string)).toHaveLength(1);
    }
  });

  it("is refused anywhere else by the private marker every generated file carries", () => {
    const files = generated();
    for (const [rel, text] of Object.entries(files)) {
      expect(text, rel).toContain(FUZZ_PRIVATE_MARKER);
      expect(
        violationsFor(`elsewhere/${rel}`, () => text),
        rel,
      ).toHaveLength(1);
    }
    // ...including a copy placed in the committed corpus-mcp/ directory.
    for (const [rel, text] of Object.entries(files)) {
      if (!rel.startsWith("corpus-mcp/")) continue;
      expect(
        violationsFor(rel, () => text),
        rel,
      ).toHaveLength(1);
    }
  });
});

describe("hook behaviour in a scratch repository", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
    git("add", "-f", rel);
  };
  const guard = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "fuzz-guard-"));
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("passes on staged clean files", () => {
    write("corpus/a.yaml", PLAIN_YAML);
    expect(guard().status).toBe(0);
  });

  it("refuses a staged fuzz output path and names it without printing contents", () => {
    write("fuzz-out/run/report.json", '{"secret":"zzcontent"}');
    const r = guard();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fuzz-out/run/report.json");
    expect(r.stderr).not.toContain("zzcontent");
  });

  it("refuses a staged fuzz: scenario outside the public catalogue only", () => {
    write("packages/fuzz/catalogue-public/ok.yaml", FUZZ_YAML);
    expect(guard().status).toBe(0);
    write("packages/fuzz/catalogue/private.yaml", FUZZ_YAML);
    const r = guard();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("packages/fuzz/catalogue/private.yaml");
  });

  it("refuses a staged marked output written to an arbitrary directory", () => {
    write("somewhere/else/diff.json", `{"${FUZZ_PRIVATE_MARKER}":true,"n":1}`);
    const r = guard();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("somewhere/else/diff.json");
  });

  it("--tree scans every tracked file, as CI runs it", () => {
    write("corpus/a.yaml", PLAIN_YAML);
    write("corpus-mcp/b.yaml", PLAIN_YAML);
    git("commit", "-qm", "clean");
    expect(guard("--tree").status).toBe(0);
    write("corpus-mcp/fuzz-get-report.yaml", FUZZ_YAML);
    git("commit", "-qm", "offending");
    const r = guard("--tree");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("corpus-mcp/fuzz-get-report.yaml");
    expect(r.stderr).not.toContain("amount_overflow");
  });

  it("--tree skips a tracked file that was deleted in the working tree", () => {
    write("corpus/a.yaml", PLAIN_YAML);
    write("corpus/b.yaml", PLAIN_YAML);
    git("commit", "-qm", "two files");
    rmSync(join(repo, "corpus/b.yaml"));
    const r = guard("--tree");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("ENOENT");
  });

  it("--tree refuses a fuzz: technique committed in the HTTP corpus too", () => {
    write("corpus/a.yaml", FUZZ_YAML);
    git("commit", "-qm", "offending");
    const r = guard("--tree");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("corpus/a.yaml");
  });

  it("--pre-push refuses a committed offending file", () => {
    write("a.txt", "x");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").toString().trim();
    write("seed.fuzz/c.yaml", "id: x\n");
    git("commit", "-qm", "add");
    const head = git("rev-parse", "HEAD").toString().trim();
    const r = spawnSync(process.execPath, [SCRIPT, "--pre-push"], {
      cwd: repo,
      encoding: "utf8",
      input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("seed.fuzz/c.yaml");
  });
});
