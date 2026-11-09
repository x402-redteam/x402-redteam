/**
 * run-llm.sh key-file mode (M5, m10, m4): the refusals happen before anything starts and the
 * script never exports the key. Exercises only the refusal paths, with a dummy secret.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(repo, "examples", "third-party", "agentkit", "scripts", "run-llm.sh");

function run(env: Record<string, string>): { status: number | null; out: string } {
  const r = spawnSync("bash", [script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("agentkit run-llm.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-runllm-"));
  const key = (mode: number): string => {
    const p = join(dir, `key-${mode.toString(8)}`);
    writeFileSync(p, "sk-dummy\n");
    chmodSync(p, mode);
    return p;
  };
  it("refuses when ANTHROPIC_API_KEY is also exported", () => {
    const r = run({ X402_ANTHROPIC_KEY_FILE: key(0o600), ANTHROPIC_API_KEY: "sk-dummy-env" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/also exported/);
    expect(r.out).not.toContain("sk-dummy");
  });
  it("refuses an exported key on its own: the key file is required", () => {
    const r = run({ ANTHROPIC_API_KEY: "sk-dummy-env" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/X402_ANTHROPIC_KEY_FILE/);
    expect(r.out).not.toContain("sk-dummy");
  });
  it("refuses a key file that is not mode 0600", () => {
    const r = run({ X402_ANTHROPIC_KEY_FILE: key(0o644) });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/0600/);
  });
  it("refuses a missing key file", () => {
    const r = run({ X402_ANTHROPIC_KEY_FILE: join(dir, "missing") });
    expect(r.status).not.toBe(0);
  });
  it("skips cleanly when neither a key nor a key file is set", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/SKIPPED/);
  });
  it("never exports or prints the key, and keeps the spend file in a 0700 dir with a cleanup trap", () => {
    const text = readFileSync(script, "utf8");
    expect(text).not.toMatch(/export\s+ANTHROPIC_API_KEY/);
    expect(text).not.toMatch(/cat\s+"?\$X402_ANTHROPIC_KEY_FILE/);
    expect(text).toMatch(/mktemp -d/);
    expect(text).toMatch(/trap .*rm -rf.* EXIT/);
  });
  it("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
