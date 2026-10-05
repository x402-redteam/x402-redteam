import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const FIXTURE_CORPUS = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));

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

// ADR-011 (U19): --agent-uid, --redact and --season-seed-env are real now. These three
// checks stay in this fast usage-error suite only because each one fails *before*
// `runSuite` boots an adversary or spawns the full corpus (an uid/platform check, or a
// missing `corpus/season.json`) - functional coverage of what each flag actually does
// (report.redacted.json's shape, the seed never reaching a written file, etc.) lives in
// season-redact-uid.test.ts, which drives `runSuite` directly against a tiny one-scenario
// fixture corpus instead of the full default one.
describe("main `run` --agent-uid / --redact / --season-seed-env (ADR-011, U19)", () => {
  it("--agent-uid rejects a non-integer before runSuite ever starts", () => {
    const result = runCli(["run", "--agent", "true", "--agent-uid", "not-a-number"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--agent-uid/);
  });

  it("--agent-uid exits 2 on this platform/privilege (Linux + root only)", () => {
    const result = runCli(["run", "--agent", "true", "--agent-uid", "2001"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(process.platform === "linux" ? /root/ : /Linux/);
  });

  it("security review HIGH-4/LOW: --agent-uid 0 and reserved uids (1000, 1001) are rejected outright", () => {
    for (const uid of ["0", "1000", "1001"]) {
      const result = runCli(["run", "--agent", "true", "--agent-uid", uid]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/refused|reserved/);
    }
  });

  it("--redact alone is accepted (no usage error) - --agent-uid's own check runs first and independently", () => {
    // Exercises only option parsing, not a real run: an invalid --host-mode fails
    // before runSuite would ever get to spawn the full corpus with --redact set.
    const result = runCli(["run", "--agent", "true", "--redact", "--host-mode", "bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--host-mode/);
    expect(result.stderr).not.toMatch(/redact/);
  });

  it("--season-seed-env exits 2 fast when corpus/season.json is missing (the default corpus has none)", () => {
    const result = runCli(["run", "--agent", "true", "--season-seed-env", "SEED_ENV"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/season\.json/);
  });
});

// `--scenario` naming an id that matches nothing in the loaded corpus fails fast, before
// `runSuite` ever boots an adversary or spawns the agent command - same fast-usage-error
// budget as the checks above.
describe("main `run` --scenario validation", () => {
  it("one unknown id exits 2, naming it on stderr", () => {
    const result = runCli([
      "run",
      "--agent",
      "true",
      "--corpus",
      FIXTURE_CORPUS,
      "--scenario",
      "no-such-scenario",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown scenario id\(s\)/);
    expect(result.stderr).toContain("no-such-scenario");
  });

  it("several unknown ids are all named, sorted and de-duplicated, leaving the valid id out", () => {
    const result = runCli([
      "run",
      "--agent",
      "true",
      "--corpus",
      FIXTURE_CORPUS,
      "--scenario",
      "zebra-bad,prose-lure,alpha-bad",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("alpha-bad, zebra-bad");
    expect(result.stderr).not.toContain("prose-lure");
  });
});
