import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FUZZ_PRIVATE_MARKER } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PUBLIC = join(REPO, "packages/fuzz/catalogue-public");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, mainPath, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("x402-redteam fuzz (U29-2)", () => {
  for (const shape of ["page", "chat"]) {
    it(`generates the public smoke catalogue (${shape}) and \`validate\` passes it`, () => {
      const out = mkdtempSync(join(tmpdir(), "x402-fuzz-cli-"));
      const gen = runCli(["fuzz", "--catalogue", PUBLIC, "--shape", shape, "--out", out]);
      expect(gen.status, gen.stderr).toBe(0);
      expect(gen.stdout).toMatch(/^fuzz: 4 case\(s\) \(2 base\)/);
      const cases = readFileSync(join(out, "cases.json"), "utf8");
      expect(cases).toContain(FUZZ_PRIVATE_MARKER);
      const validate = runCli(["validate", "--corpus", join(out, "corpus")]);
      expect(validate.status, validate.stderr).toBe(0);
      expect(validate.stdout).toContain("OK: 4 scenario(s)");
    });
  }

  it("refuses an --out inside the repository, a bad --shape and a missing catalogue", () => {
    const inRepo = runCli([
      "fuzz",
      "--catalogue",
      PUBLIC,
      "--shape",
      "page",
      "--out",
      join(REPO, "gen-out"),
    ]);
    expect(inRepo.status).toBe(2);
    expect(inRepo.stderr).toMatch(/inside a git repository/);
    const out = mkdtempSync(join(tmpdir(), "x402-fuzz-cli-"));
    expect(runCli(["fuzz", "--catalogue", PUBLIC, "--shape", "mcp", "--out", out]).status).toBe(2);
    expect(
      runCli(["fuzz", "--catalogue", join(out, "nope"), "--shape", "page", "--out", out]).status,
    ).toBe(2);
  });
});
