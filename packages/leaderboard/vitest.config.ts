import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "leaderboard",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
