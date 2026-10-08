import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addedLines,
  compileMatcher,
  denylistPath,
  matchingLines,
  parseDenylist,
} from "../heldout-guard.mjs";

const SCRIPT = fileURLToPath(new URL("../heldout-guard.mjs", import.meta.url));
// Synthetic denylist term; never a real held-out value.
const CANARY = "zzcanary";

describe("denylist parsing and matching", () => {
  it("defaults to ~/x402-redteam-heldout/.denylist and honours X402_HELDOUT_DIR", () => {
    expect(denylistPath({})).toBe(join(homedir(), "x402-redteam-heldout", ".denylist"));
    expect(denylistPath({ X402_HELDOUT_DIR: "/d" })).toBe(join("/d", ".denylist"));
  });

  it("skips blank and comment lines", () => {
    expect(parseDenylist("# c\n\n  zzcanary \nzz.host.tld\r\n")).toEqual([
      "zzcanary",
      "zz.host.tld",
    ]);
  });

  it("matches case-insensitively on token boundaries and escapes regex characters", () => {
    const m = compileMatcher(["zzcanary", "zz.host.tld"]);
    expect(
      matchingLines("a\nid: ZZCanary\nzzcanaryx\nzzXhostXtld\nhttps://zz.host.tld/x", m),
    ).toEqual([2, 5]);
  });

  it.each(["corpus/zzcanary.yaml", "see zzcanary.json", "zzcanary_v2"])(
    "matches the term inside %j",
    (text) => {
      expect(matchingLines(text, compileMatcher([CANARY]))).toEqual([1]);
    },
  );

  it("matches nothing with an empty denylist", () => {
    expect(matchingLines(CANARY, compileMatcher([]))).toEqual([]);
  });

  it("maps added lines to their file and new line number", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,0 +2,2 @@",
      "+one",
      "+two",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n");
    expect(addedLines(patch)).toEqual([
      { file: "f.txt", line: 2, text: "one" },
      { file: "f.txt", line: 3, text: "two" },
    ]);
  });

  it("reads an added line starting with '++ ' as content, using the hunk line counts", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -3 +3,3 @@",
      "-old",
      "+++ zzcanary",
      "+--- b",
      " ctx",
      "\\ No newline at end of file",
      "diff --git a/g.txt b/g.txt",
      "--- a/g.txt",
      "+++ b/g.txt",
      "@@ -0,0 +1 @@",
      "+last",
    ].join("\n");
    expect(addedLines(patch)).toEqual([
      { file: "f.txt", line: 3, text: "++ zzcanary" },
      { file: "f.txt", line: 4, text: "--- b" },
      { file: "g.txt", line: 1, text: "last" },
    ]);
  });
});

describe("heldout-guard.mjs as a hook", () => {
  let repo: string;
  let heldout: string;

  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.org",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo },
    );
  const run = (args: string[] = [], input?: string) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      input,
      encoding: "utf8",
      env: { ...process.env, X402_HELDOUT_DIR: heldout },
    });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "guard-repo-"));
    heldout = mkdtempSync(join(tmpdir(), "guard-heldout-"));
    git("init", "-q");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(heldout, { recursive: true, force: true });
  });

  it("exits 0 with no output when the denylist is absent", () => {
    writeFileSync(join(repo, "a.txt"), `${CANARY}\n`);
    git("add", "a.txt");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("fails on a staged match and prints the file and line but never the text", () => {
    writeFileSync(join(heldout, ".denylist"), `# synthetic\n${CANARY}\n`);
    writeFileSync(join(repo, "clean.txt"), "nothing here\n");
    writeFileSync(join(repo, "leak.yaml"), `id: public\nnote: see ${CANARY} later\n`);
    git("add", "clean.txt", "leak.yaml");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("leak.yaml:2");
    expect(r.stderr).not.toContain("clean.txt");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
    expect(r.stdout + r.stderr).not.toContain("see");
  });

  it("withholds a staged path that matches", () => {
    writeFileSync(join(heldout, ".denylist"), `${CANARY}\n`);
    writeFileSync(join(repo, `${CANARY}.yaml`), `x: ${CANARY}\n`);
    writeFileSync(join(repo, `${CANARY}-empty.txt`), "");
    git("add", ".");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("(file path withheld):1");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  it("withholds a pushed path that matches, including an empty file", () => {
    writeFileSync(join(heldout, ".denylist"), `${CANARY}\n`);
    writeFileSync(join(repo, "a.txt"), "base\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").toString().trim();
    writeFileSync(join(repo, `${CANARY}.txt`), "");
    git("add", ".");
    git("commit", "-q", "-m", "add file");
    const head = git("rev-parse", "HEAD").toString().trim();
    const r = run(["--pre-push"], `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${head.slice(0, 7)} (file path withheld)`);
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  it("passes clean staged content", () => {
    writeFileSync(join(heldout, ".denylist"), `${CANARY}\n`);
    writeFileSync(join(repo, "a.txt"), "fine\n");
    git("add", "a.txt");
    expect(run().status).toBe(0);
  });

  it("checks a commit message file", () => {
    writeFileSync(join(heldout, ".denylist"), `${CANARY}\n`);
    const msg = join(repo, "MSG");
    writeFileSync(msg, `fix: x\n\nrelates to ${CANARY.toUpperCase()}\n`);
    const r = run(["--message-file", msg]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("commit message:3");
    expect(r.stderr.toLowerCase()).not.toContain(CANARY);
  });

  it("checks messages and added lines of commits about to be pushed", () => {
    writeFileSync(join(heldout, ".denylist"), `${CANARY}\n`);
    writeFileSync(join(repo, "a.txt"), "base\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").toString().trim();
    writeFileSync(join(repo, "a.txt"), `base\n${CANARY}\n`);
    git("commit", "-q", "-am", `docs: mention ${CANARY}`);
    const head = git("rev-parse", "HEAD").toString().trim();

    const r = run(["--pre-push"], `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${head.slice(0, 7)} commit message:1`);
    expect(r.stderr).toContain(`${head.slice(0, 7)} a.txt:2`);
    expect(r.stdout + r.stderr).not.toContain(CANARY);

    const clean = run(["--pre-push"], `refs/heads/main ${base} refs/heads/main ${base}\n`);
    expect(clean.status).toBe(0);
  });
});
