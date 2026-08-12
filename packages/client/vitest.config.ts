import { defineProject } from "vitest/config";
import { sharedTest } from "../../vitest/shared";

export default defineProject({
  test: {
    ...sharedTest,
    name: "client-unit",
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
