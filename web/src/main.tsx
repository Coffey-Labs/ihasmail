import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { App } from "./App";
import { startBuildWatch } from "@/lib/staleBuild";
import { BASE_PATH, withBase } from "@/lib/basePath";

startBuildWatch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    /*
     * The scope is spelled out rather than left to default to the script's own
     * directory. Both come to `${BASE_PATH}/` today, but the default is a
     * property of where the file happens to sit, and this is a statement about
     * what the worker is allowed to control -- which under a prefix must stop
     * at the mount. A worker scoped to `/` on a host shared with other
     * applications would intercept their navigations too, and its offline
     * fallback would answer them with ihasmail's shell.
     */
    navigator.serviceWorker.register(withBase("/sw.js"), { scope: `${BASE_PATH}/` }).catch(() => {
      /* ignore */
    });
  });
}
