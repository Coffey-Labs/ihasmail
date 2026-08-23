import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp, sessions } from "./app.js";

async function main() {
  await sessions.init();
  const app = createApp();
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`[ihasmail] ${config.appName} listening on http://${info.address}:${info.port}`);
    console.log(`[ihasmail] upstream Stalwart: ${config.stalwartUrl}`);
    console.log(`[ihasmail] static dir: ${config.staticDir}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[ihasmail] ${signal} received, shutting down`);
    server.close();
    await sessions.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[ihasmail] fatal:", err);
  process.exit(1);
});
