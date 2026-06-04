// vitest/shared.ts
// Defaults shared across every workspace project.
import type { UserConfig } from "vitest/config";

export const sharedTest: NonNullable<UserConfig["test"]> = {
  globals: true,
  passWithNoTests: true,
  reporters: process.env.CI ? ["default", "junit"] : ["default"],
  outputFile: { junit: ".test-reports/junit.xml" },
  coverage: {
    provider: "v8",
    reporter: ["text", "lcov", "html"],
    reportsDirectory: ".test-reports/coverage",
    exclude: ["**/dist/**", "**/node_modules/**", "**/*.config.*", "**/*.test.*"],
    // Lenient, honest, RATCHET-ONLY gate. Set just under the measured baseline
    // (2026-05-30: ~13.8% lines/stmts, ~60% branch, ~32% funcs across the merged
    // workspace report) so coverage can only go up — raise these as surfaces
    // gain tests; never lower them to make a red run pass.
    thresholds: {
      statements: 13,
      branches: 55,
      functions: 30,
      lines: 13,
    },
  },
};
