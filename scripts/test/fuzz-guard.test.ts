import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FUZZ_PRIVATE_MARKER as SCHEMA_MARKER } from "../../packages/schema/src/fuzz-private.js";
import {
  FUZZ_PRIVATE_MARKER,
  hasFuzzTechnique,
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
