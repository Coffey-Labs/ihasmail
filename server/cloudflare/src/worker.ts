import { createApp, setSessionBackend } from "../../src/app.js";
import { KVSessionStore, type KVLike } from "./kvsessions.js";

/**
 * The Workers entry point, standing where `src/index.ts` stands for Node.
 *
 * Everything below the entry is shared: `createApp()` is the same Hono app the
 * Node server serves, and it is not aware of which one is running it. That is
 * the whole finding of this spike -- the port is an entry point, a session
 * store, and two rewrites (see README.md), not a second server.
 */
export interface Env {
  SESSIONS: KVLike;
  APP_SECRET: string;
  SESSION_TTL?: string;
  SESSION_REMEMBER_TTL?: string;
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

/**
 * Built once per isolate, not once per request.
 *
 * `createApp()` compiles routes, and an isolate serves many requests. The
 * bindings arrive with the first one, which is why this is lazy rather than
 * module-level -- the KV namespace does not exist until then.
 */
let app: ReturnType<typeof createApp> | null = null;

function boot(env: Env) {
  if (app) return app;
  setSessionBackend(
    new KVSessionStore(env.SESSIONS, {
      appSecret: env.APP_SECRET,
      sessionTtl: Number(env.SESSION_TTL ?? 60 * 60 * 24),
      sessionRememberTtl: Number(env.SESSION_REMEMBER_TTL ?? 60 * 60 * 24 * 30),
    }),
  );
  app = createApp();
  return app;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The built SPA is served by the platform, not by the app: `static.ts`
    // reads from a filesystem this runtime does not have. Anything that is not
    // the API belongs to the asset binding.
    if (!url.pathname.startsWith("/api/") && env.ASSETS) return env.ASSETS.fetch(request);
    return boot(env).fetch(request);
  },
};
