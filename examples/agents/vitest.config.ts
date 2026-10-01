import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agents",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
