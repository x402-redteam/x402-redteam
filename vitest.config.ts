import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // "examples/*" added by U12 so examples/agents' own vitest project (stubbed-LLM
    // agent-loop tests, tool-handler tests against a live adversary) runs under the
    // root `pnpm test` / `pnpm test:all`, same as every packages/* project.
    projects: ["packages/*", "examples/*"],
  },
});
