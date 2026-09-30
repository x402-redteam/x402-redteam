import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cli",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // E2E tests spawn real tsx subprocesses (crawl + pay against the adversary
    // server) for the whole fixture corpus, so this needs more room than the
    // library packages' default timeout - functional-design.md §6.
    testTimeout: 240_000,
    // Each E2E file spawns an agent per scenario x chain; running files in parallel
    // starves agent startup on loaded machines and turns runs into timeouts.
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
