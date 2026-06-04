import { defineProject } from "vitest/config";
import { sharedTest } from "../../vitest/shared";

export default defineProject({
  test: {
    ...sharedTest,
    name: "mcp-server-unit",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
