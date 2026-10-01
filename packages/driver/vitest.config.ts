import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "driver",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
