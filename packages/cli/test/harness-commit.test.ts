import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSuite } from "../src/run.js";

/**
 * `config.harness_commit` resolution order (run.ts's `computeHarnessCommit`):
 * `X402_HARNESS_COMMIT` when it's a 40-hex SHA, else `git rev-parse HEAD`, else
 * "unknown". `execFileSync` is mocked (preserving every other `node:child_process`
 * export, same pattern as `season-redact-uid.test.ts`'s `chownSync` mock) so each case
 * is deterministic regardless of whether this checkout actually has `.git` or `git` on
 * `PATH` - a real container build (`.dockerignore` excludes `.git`) has neither.
 *
 * `computeHarnessCommit`'s own result is memoized per module instance, so each case
 * resets the module registry and re-imports `run.ts` fresh, after setting the env var
 * and the mock it needs to observe.
 */
const FIXTURE_CORPUS = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));
const ENV_NAME = "X402_HARNESS_COMMIT";
const ORIGINAL_ENV = process.env[ENV_NAME];

async function resolvedHarnessCommit(opts: {
  envValue?: string;
  git: { sha?: string; unavailable?: boolean };
}): Promise<string> {
  vi.resetModules();
  if (opts.envValue === undefined) {
    delete process.env[ENV_NAME];
  } else {
    process.env[ENV_NAME] = opts.envValue;
  }

  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
      ...actual,
      execFileSync: vi.fn((cmd: string, args: readonly string[], options: unknown) => {
        if (cmd === "git") {
          if (opts.git.unavailable) throw new Error("git: not available in this test");
          return `${opts.git.sha}\n`;
        }
        return actual.execFileSync(cmd, args as string[], options as never);
      }),
    };
  });

  const { runSuite } = await import("../src/run.js");
  const outDir = mkdtempSync(join(tmpdir(), "x402-harness-commit-"));
  try {
    const { report } = await runSuite({
      agentCmd: "true",
      corpus: FIXTURE_CORPUS,
      scenarioIds: ["prose-lure"],
      chains: ["evm"],
      repeat: 1,
      timeoutMs: 5_000,
      startupTimeoutMs: 5_000,
      seed: "x402-redteam-v1",
      outDir,
      agentId: "a",
      guardrailId: "none",
      failOn: "low",
      // `harnessCommit` is intentionally omitted so `computeHarnessCommit()` itself runs.
    });
    return report.config.harness_commit;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  }
}

describe('harness commit resolution: X402_HARNESS_COMMIT, then git, then "unknown"', () => {
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = ORIGINAL_ENV;
    }
  });

  it("uses X402_HARNESS_COMMIT when it is a 40-hex SHA, without ever calling git", async () => {
    const sha = "a".repeat(40);
    const commit = await resolvedHarnessCommit({ envValue: sha, git: { unavailable: true } });
    expect(commit).toBe(sha);
  });

  it("accepts an uppercase-hex 40-char value and records it lowercased (the leaderboard's own format)", async () => {
    const sha = "B".repeat(40);
    const commit = await resolvedHarnessCommit({ envValue: sha, git: { unavailable: true } });
    expect(commit).toBe(sha.toLowerCase());
  });

  it("falls back to git when the env value is set but not a 40-hex SHA", async () => {
    const gitSha = "b".repeat(40);
    const commit = await resolvedHarnessCommit({ envValue: "not-a-sha", git: { sha: gitSha } });
    expect(commit).toBe(gitSha);
  });

  it("falls back to git when no env value is set at all", async () => {
    const gitSha = "c".repeat(40);
    const commit = await resolvedHarnessCommit({ envValue: undefined, git: { sha: gitSha } });
    expect(commit).toBe(gitSha);
  });

  it('falls back to "unknown" when neither the env value nor git produce anything usable', async () => {
    const commit = await resolvedHarnessCommit({ envValue: undefined, git: { unavailable: true } });
    expect(commit).toBe("unknown");
  });
});

describe("X402_HARNESS_COMMIT is never forwarded to the agent subprocess's own env", () => {
  const ECHO_ENV_AGENT = fileURLToPath(new URL("./fixtures/echo-env-agent.mjs", import.meta.url));

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = ORIGINAL_ENV;
    }
  });

  it("is absent from the agent's env even when set on the harness's own env and explicitly named via --pass-env", async () => {
    process.env[ENV_NAME] = "d".repeat(40);
    const outDir = mkdtempSync(join(tmpdir(), "x402-harness-commit-env-"));
    try {
      await runSuite({
        agentCmd: `"${process.execPath}" "${ECHO_ENV_AGENT}"`,
        corpus: FIXTURE_CORPUS,
        scenarioIds: ["prose-lure"],
        chains: ["evm"],
        repeat: 1,
        timeoutMs: 5_000,
        startupTimeoutMs: 5_000,
        seed: "x402-redteam-v1",
        outDir,
        agentId: "a",
        guardrailId: "none",
        failOn: "low",
        passEnv: [ENV_NAME],
        harnessCommit: "test-harness-commit",
      });

      const logsDir = join(outDir, "logs");
      const [logFile] = readdirSync(logsDir);
      expect(logFile).toBeDefined();
      const envKeys: string[] = JSON.parse(
        readFileSync(join(logsDir, String(logFile)), "utf8").trim(),
      );
      expect(envKeys).not.toContain(ENV_NAME);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
