import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "scorer",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
