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

  it("--guardrail alone exits 2 (not yet implemented, ADR-010/U18)", () => {
    const result = runCli(["run", "--guardrail", "true"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not implemented/);
  });

  it("neither --agent nor --guardrail exits 2", () => {
    const result = runCli(["run"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--agent or --guardrail/);
  });
});

// ADR-012 (full)/U17: localhost and proxy are real host modes now - only --host-mode
// bogus (above) is a usage error. `--host-mode <mode>`'s own default flip (path -> ADR-012
// §1's canonical "localhost") is checked via `--help`, per commander's auto-appended
// "(default: ...)" text, rather than a real run - a real run exercises the adversary and
// corpus end to end, which belongs in `hosts.e2e.test.ts`, not this fast usage-error suite.
describe("main `run` --host-mode defaults to localhost (ADR-012 full, U17)", () => {
  it("--help shows localhost as --host-mode's default", () => {
    const result = runCli(["run", "--help"]);
    expect(result.stdout).toMatch(/--host-mode <mode>[\s\S]*?\(default:\s*"localhost"\)/);
  });
});

// Code review item 6: a stub flag must fail loudly, not be silently accepted.
describe("main `run` rejects not-yet-implemented stub flags (v3, code review item 6)", () => {
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
