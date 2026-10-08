import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateList,
  hmacToken,
  matchingLines,
  parseHmacList,
  tokens,
} from "../heldout-guard-ci.mjs";

const SCRIPT = fileURLToPath(new URL("../heldout-guard-ci.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/test.hmac", import.meta.url));
const COMMITTED = fileURLToPath(new URL("../../.github/heldout-guard.hmac", import.meta.url));
// Test-only key and synthetic tokens; the fixture holds HMAC(TEST_KEY, t) for CANARY and ID.
const TEST_KEY = "x402-redteam-test-key-00000000000000000";
const CANARY = "zzcanary";
const ID = "zz-swap-9";

describe("tokenising and HMAC list", () => {
  it("yields whole runs and every contiguous segment sequence, lowercased, edges trimmed", () => {
    expect([...tokens("See Zz-Host.tld, ok.")].sort()).toEqual(
      ["host", "host.tld", "ok", "see", "tld", "zz", "zz-host", "zz-host.tld"].sort(),
    );
  });

  it.each([
    `corpus/${ID}.yaml`,
    `see ${ID}.json`,
    `results/${ID}.json`,
    `${ID}_v2`,
    `prefix.${ID}-extra`,
  ])("finds the listed id inside %j", (text) => {
    expect(tokens(text).has(ID)).toBe(true);
    const list = parseHmacList(readFileSync(FIXTURE, "utf8"));
    expect(matchingLines(text, TEST_KEY, list)).toEqual([1]);
  });

  it("does not join segments across a run boundary or past 12 segments", () => {
    expect(tokens("zz swap-9").has(ID)).toBe(false);
    const long = Array.from({ length: 14 }, (_, i) => `s${i}`).join("-");
    const t = tokens(long);
    expect(t.has(long)).toBe(true);
    expect(t.has(Array.from({ length: 12 }, (_, i) => `s${i}`).join("-"))).toBe(true);
    expect(t.has(Array.from({ length: 13 }, (_, i) => `s${i}`).join("-"))).toBe(false);
  });

  it("the fixture is HMAC-SHA256 of the synthetic tokens under the test key", () => {
    const list = parseHmacList(readFileSync(FIXTURE, "utf8"));
    expect([...list].sort()).toEqual([hmacToken(TEST_KEY, CANARY), hmacToken(TEST_KEY, ID)].sort());
  });

  it("the committed list is comments and 64-hex digests only", () => {
    const lines = readFileSync(COMMITTED, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds a known token through the HMAC list only with the right key", () => {
    const list = parseHmacList(readFileSync(FIXTURE, "utf8"));
    const text = `ok\nhttps://${CANARY}.example/x\nzzcanaryx\n`;
    expect(matchingLines(text, TEST_KEY, list)).toEqual([2]);
    expect(matchingLines(text, "other-key", list)).toEqual([]);
  });

  it("generates a sorted, de-duplicated list and counts multi-token terms", () => {
    const { digests, skipped } = generateList(TEST_KEY, [
      "# c",
      CANARY,
      "ZZCANARY",
      "two words",
      "",
    ]);
    expect(digests).toEqual([hmacToken(TEST_KEY, CANARY)]);
    expect(skipped).toBe(1);
  });

  it("pads the list with random digests", () => {
    const { digests } = generateList(TEST_KEY, [CANARY], 5);
    expect(digests).toHaveLength(6);
    expect(digests).toContain(hmacToken(TEST_KEY, CANARY));
    expect([...digests].sort()).toEqual(digests);
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("heldout-guard-ci.mjs", () => {
  let dir: string;
  const run = (args: string[], key?: string) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HELDOUT_GUARD_KEY: key ?? "" },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guard-ci-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a key shorter than 32 bytes", () => {
    writeFileSync(join(dir, "a.txt"), "fine\n");
    const r = run(["--hmac-file", FIXTURE, "a.txt"], "a".repeat(31));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("openssl rand -hex 32");
  });

  it("skips with exit 0 when no key is set", () => {
    writeFileSync(join(dir, "leak.txt"), `${CANARY}\n`);
    const r = run(["--hmac-file", FIXTURE, "leak.txt"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skipped (no key)");
  });

  it("detects a known token in a file, printing location only", () => {
    writeFileSync(join(dir, "clean.txt"), "fine\n");
    writeFileSync(join(dir, "leak.txt"), `a\nb ${CANARY} c\n`);
    const r = run(["--hmac-file", FIXTURE, "clean.txt", "leak.txt"], TEST_KEY);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("leak.txt:2");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  it("withholds a file path that itself matches", () => {
    writeFileSync(join(dir, `${CANARY}.yaml`), `x: ${CANARY}\n`);
    const r = run(["--hmac-file", FIXTURE, `${CANARY}.yaml`], TEST_KEY);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("(file path withheld):1");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
  });

  it("scans files changed and commit messages since --base", () => {
    const git = (...a: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=T", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", ...a],
        { cwd: dir },
      )
        .toString()
        .trim();
    git("init", "-q");
    writeFileSync(join(dir, "old.txt"), `${CANARY}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "new.txt"), "fine\n");
    git("add", ".");
    git("commit", "-q", "-m", `docs: ${CANARY}`);

    const r = run(["--hmac-file", FIXTURE, "--base", base], TEST_KEY);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("scanned 1 file(s), 1 commit message(s)");
    expect(r.stdout).toMatch(/commit [0-9a-f]{7} message:1/);
    expect(r.stdout).not.toContain("old.txt");
    expect(r.stdout + r.stderr).not.toContain(CANARY);

    // An unusable base scans every tracked file.
    const all = run(["--hmac-file", FIXTURE, "--base", "0".repeat(40)], TEST_KEY);
    expect(all.stdout).toContain("old.txt:1");
  });
});
