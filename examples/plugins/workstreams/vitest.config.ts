import { defineWorkspaceTestConfig } from "../../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    name: "bb-plugin-workstreams",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
