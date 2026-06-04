import { defineProject } from "vitest/config";
import { sharedTest } from "../../vitest/shared";

export default defineProject({
  test: {
    ...sharedTest,
    name: "cli-unit",
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
