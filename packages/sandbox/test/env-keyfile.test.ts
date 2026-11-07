import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_ENV_NAMES, childEnv } from "../src/env.js";
import { KEY_FILE_ENV, KeyFileError, readKeyFile, resolveAnthropicKey } from "../src/keyfile.js";

describe("childEnv", () => {
  it("passes the base names and the adapter's, nothing else", () => {
    const env = childEnv(
      {
        PATH: "/bin",
        HOME: "/h",
        TMPDIR: "/h/tmp",
        X402_REDTEAM_TASK: "/t",
        EXTRA: "1",
        ANTHROPIC_API_KEY: "sk-x",
        NODE_OPTIONS: "--require evil",
        HTTPS_PROXY: "http://x",
      },
      ["EXTRA"],
    );
    expect(Object.keys(env).sort()).toEqual([...BASE_ENV_NAMES, "EXTRA"].sort());
  });
  it("includes TMPDIR in the exported base list (m5)", () => {
    expect(BASE_ENV_NAMES).toContain("TMPDIR");
  });
});

describe("key-file mode", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-keyfile-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, mode: number, text = "sk-dummy\n"): string => {
    const p = join(dir, name);
    writeFileSync(p, text);
    chmodSync(p, mode);
    return p;
  };

  it("reads a 0600 regular file", () => {
    expect(readKeyFile(file("ok", 0o600))).toBe("sk-dummy");
  });
  it("refuses a file that is not mode 0600", () => {
    expect(() => readKeyFile(file("open", 0o644))).toThrow(KeyFileError);
    expect(() => readKeyFile(file("group", 0o640))).toThrow(KeyFileError);
  });
  it("refuses a missing file, a directory, a symlink and an empty file", () => {
    expect(() => readKeyFile(join(dir, "nope"))).toThrow(KeyFileError);
    const sub = join(dir, "sub");
    mkdirSync(sub, { mode: 0o700 });
    expect(() => readKeyFile(sub)).toThrow(KeyFileError);
    const real = file("real", 0o600);
    const link = join(dir, "link");
    symlinkSync(real, link);
    expect(() => readKeyFile(link)).toThrow(KeyFileError);
    expect(() => readKeyFile(file("empty", 0o600, "\n"))).toThrow(KeyFileError);
  });
  it("refuses when ANTHROPIC_API_KEY is also exported", () => {
    const env = { [KEY_FILE_ENV]: file("both", 0o600), ANTHROPIC_API_KEY: "sk-other" };
    expect(() => resolveAnthropicKey(env)).toThrow(/also exported/);
  });
  it("returns the file's key without copying it into the environment", () => {
    const env: NodeJS.ProcessEnv = { [KEY_FILE_ENV]: file("mem", 0o600, "sk-in-memory\n") };
    const before = JSON.stringify(env);
    expect(resolveAnthropicKey(env)).toBe("sk-in-memory");
    expect(JSON.stringify(env)).toBe(before);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it("falls back to the environment key when no key file is named", () => {
    expect(resolveAnthropicKey({ ANTHROPIC_API_KEY: "sk-env" })).toBe("sk-env");
    expect(resolveAnthropicKey({})).toBeUndefined();
  });
});
