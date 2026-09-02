import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { resolveVersion } from "../scripts/version.mjs";
import { baseUrlOf } from "../scripts/basePath.mjs";

// Resolved here, at build time: the browser has no git to ask, and neither does
// the Docker build, which is handed the answer as IHASMAIL_VERSION instead.
const version = resolveVersion();

/*
 * Where the app is mounted. Unlike everything else ihasmail is told, this one
 * cannot wait until the process starts: the hashed asset URLs are written into
 * index.html when the bundle is built, so a build that does not know its prefix
 * emits `/assets/...` and the shell 404s under `/mail/`. So `BASE_PATH` is read
 * at build time here as well as at run time in the server, and the Dockerfile
 * carries one value into both.
 *
 * Vite wants the directory form with the trailing slash, and hands it back to
 * the app as `import.meta.env.BASE_URL` -- which is where `lib/basePath.ts`
 * gets it, so the browser never has to be told separately.
 */
const base = baseUrlOf(process.env.BASE_PATH);

export default defineConfig({
  base,
  plugins: [react()],
  define: { __IHASMAIL_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      // Under a prefix the dev server serves the app from `base`, so the app's
      // API calls arrive here prefixed too. Forwarded whole, prefix included:
      // the dev server behind this reads the same BASE_PATH and expects it.
      [`${base}api`]: {
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
