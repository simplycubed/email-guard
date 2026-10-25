import { defineConfig } from "vitest/config";

// Hermetic unit suite. NOTHING here reaches the network: DNS goes through an injected
// resolver or fake fetch, storage through the in-memory stores from ./testing, and the
// package holds no credentials.
export default defineConfig({
  test: {
    environment: "node",
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: process.env.CI ? { junit: "./test-results/junit.xml" } : undefined,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary", "json"],
      include: ["src/**/*.ts"],
      // Barrels and pure type declarations carry no logic and would only drag the
      // denominator.
      exclude: ["test/**", "**/index.ts", "**/types.ts", "**/*.d.ts"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
