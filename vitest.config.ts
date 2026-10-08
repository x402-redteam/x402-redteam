import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // "examples/*" added by U12 so examples/agents' own vitest project (stubbed-LLM
    // agent-loop tests, tool-handler tests against a live adversary) runs under the
    // root `pnpm test` / `pnpm test:all`, same as every packages/* project.
    // "scripts" holds the unit tests for the repository scripts (PR hygiene, held-out guard).
    projects: ["packages/*", "examples/*", "scripts"],
    // Used by `pnpm test:coverage` (unit tests only, same excludes as `pnpm test`).
    coverage: {
      provider: "v8",
      // examples/guardrails is left out: those policies run only as child processes of
      // the guardrail driver (E2E, self-test and the calibration suite), which v8
      // coverage of the unit-test workers cannot observe.
      include: ["packages/*/src/**", "examples/*/src/**"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // ADR-018 §6: each threshold is the measured baseline minus 2 points, rounded
      // down; raise them as coverage grows (target ≥ 80 % statements overall). The
      // top-level numbers apply to all files together, each glob to one package.
      // packages/driver and examples/agents are mostly exercised by the E2E suite.
      thresholds: {
        statements: 75,
        branches: 68,
        functions: 80,
        lines: 76,
        "packages/adversary/src/**": { statements: 86, branches: 73, functions: 90, lines: 88 },
        "packages/capture/src/**": { statements: 86, branches: 66, functions: 96, lines: 86 },
        "packages/cli/src/**": { statements: 79, branches: 69, functions: 82, lines: 79 },
        "packages/driver/src/**": { statements: 41, branches: 32, functions: 44, lines: 44 },
        "packages/leaderboard/src/**": { statements: 83, branches: 79, functions: 88, lines: 84 },
        "packages/schema/src/**": { statements: 93, branches: 87, functions: 96, lines: 94 },
        "packages/scorer/src/**": { statements: 93, branches: 86, functions: 92, lines: 94 },
        "examples/agents/src/**": { statements: 39, branches: 34, functions: 40, lines: 40 },
      },
    },
  },
});
