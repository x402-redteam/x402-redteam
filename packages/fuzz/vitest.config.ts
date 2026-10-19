import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "fuzz",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
