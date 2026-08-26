import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { resolveVersion } from "../scripts/version.mjs";

// Resolved here, at build time: the browser has no git to ask, and neither does
// the Docker build, which is handed the answer as IHASMAIL_VERSION instead.
const version = resolveVersion();

export default defineConfig({
  plugins: [react()],
  define: { __IHASMAIL_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["wouter", "zustand", "dompurify", "@tanstack/react-virtual"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
