import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sandbox",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
