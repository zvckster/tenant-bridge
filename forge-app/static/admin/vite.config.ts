import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Forge serves Custom UI from a static folder, so assets must use relative paths.
// `--mode mock` swaps @forge/bridge for sample data, to preview the page outside Jira.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react()],
  build: { outDir: "build", emptyOutDir: true, sourcemap: false },
  resolve: {
    alias: (mode === "mock" ? { "@forge/bridge": fileURLToPath(new URL("./src/mockBridge.ts", import.meta.url)) } : {}) as Record<string, string>,
  },
}));
