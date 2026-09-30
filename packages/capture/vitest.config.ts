import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "capture",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
