import { defineConfig, type Plugin } from "vitest/config";
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

/*
 * Every file the build made, written into the app page for the service worker.
 *
 * The page names only what it loads at start; the composer, settings, viewers
 * and the rest arrive when first used, and after each deploy that first use
 * went back to the server. With the whole list in the page, the worker can
 * fetch them in the background once a new version is seen, and knows to keep
 * them. Language catalogs are listed apart: a reader wants one of them, which
 * is cached when it is first loaded.
 *
 * An inert JSON block rather than prefetch links, which the browser would
 * fetch on every load.
 */
function assetList(): Plugin {
  return {
    name: "ihasmail-asset-list",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        const precache: string[] = [];
        const onDemand: string[] = [];
        for (const file of Object.values(ctx.bundle)) {
          if (!file.fileName.startsWith("assets/") || file.fileName.endsWith(".map")) continue;
          const catalog = file.type === "chunk" && file.moduleIds.length > 0 && file.moduleIds.every((id) => /[\\/]src[\\/]locales[\\/][^\\/]+\.ts$/.test(id));
          (catalog ? onDemand : precache).push(`${base}${file.fileName}`);
        }
        const json = JSON.stringify({ precache: precache.sort(), onDemand: onDemand.sort() });
        return html.replace("</body>", `  <script type="application/json" id="ihasmail-assets">${json}</script>\n  </body>`);
      },
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), assetList()],
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
    rolldownOptions: {
      output: {
        /*
         * Rolldown, which vite 8 bundles with, dropped the object form of
         * `manualChunks` -- naming a chunk and listing the packages in it --
         * and takes groups matched against module paths instead. Same two
         * chunks out the other end; `icons` is listed first because groups are
         * tried in order and the first match wins.
         */
        codeSplitting: {
          groups: [
            { name: "icons", test: /node_modules[\\/]lucide-react[\\/]/ },
            {
              name: "vendor",
              test: /node_modules[\\/](wouter|zustand|dompurify|@tanstack[\\/]react-virtual)[\\/]/,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
