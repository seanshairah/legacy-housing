import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: [
        "src/domain/**/*.ts",
        "src/integrations/**/*.ts",
        "src/lib/**/*.ts",
      ],
      exclude: ["src/lib/current-user.ts"],
      reporter: ["text", "json-summary", "html"],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
