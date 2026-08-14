import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This checkout is exposed through a Windows junction in the desktop app.
// Use its physical directory consistently so Vite/Rollup never mix both paths.
const root = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
process.chdir(root);

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787",
      // Keep the real-time state stream on the API server in development.
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
