import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "relay/test/**/*.test.ts", "forge-app/test/**/*.test.ts"],
  },
});
