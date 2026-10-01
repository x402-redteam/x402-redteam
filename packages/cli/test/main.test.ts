import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/**
 * v3 (ADR-016 CLI flags, Bolt 6 Phase A): both checks fail fast, inside `main.ts`'s own
 * option validation, before `runSuite` ever boots an adversary or spawns an agent - so
 * this spawns the real CLI (same way `bin/x402-redteam.mjs` does) rather than driving
 * `runSuite` directly, and stays well inside the 2-minute probe budget.
 */
function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, mainPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("main `run` usage errors (v3)", () => {
  it("--agent together with --guardrail exits 2 with a usage error", () => {
    const result = runCli(["run", "--agent", "true", "--guardrail", "true"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });

  it("--host-mode bogus exits 2 with a usage error", () => {
    const result = runCli(["run", "--agent", "true", "--host-mode", "bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--host-mode/);
  });

  it("neither --agent nor --guardrail exits 2", () => {
    const result = runCli(["run"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--agent or --guardrail/);
  });
});

// Code review item 6: a stub flag must fail loudly, not be silently accepted.
describe("main `run` rejects not-yet-implemented stub flags (v3, code review item 6)", () => {
  it("--host-mode localhost exits 2 (not yet implemented, ADR-012/U17)", () => {
    const result = runCli(["run", "--agent", "true", "--host-mode", "localhost"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--host-mode "localhost" is not implemented yet/);
  });

  it("--host-mode proxy exits 2 (not yet implemented, ADR-012/U17)", () => {
    const result = runCli(["run", "--agent", "true", "--host-mode", "proxy"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--host-mode "proxy" is not implemented yet/);
  });

  it("--agent-uid exits 2 (not yet implemented, U19)", () => {
    const result = runCli(["run", "--agent", "true", "--agent-uid", "1000"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--agent-uid is not implemented yet/);
  });

  it("--redact exits 2 (not yet implemented, ADR-011/U19)", () => {
    const result = runCli(["run", "--agent", "true", "--redact"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--redact is not implemented yet/);
  });

  it("--season-seed-env exits 2 (not yet implemented, ADR-011/U19)", () => {
    const result = runCli(["run", "--agent", "true", "--season-seed-env", "SEED_ENV"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--season-seed-env is not implemented yet/);
  });
});
