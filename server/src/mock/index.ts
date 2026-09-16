/**
 * A tiny in-memory JMAP server that mimics the subset of Stalwart that ihasmail
 * uses. For local development and demos only:  `npm run mock` then point the
 * server at it with STALWART_URL=http://127.0.0.1:8788 (user: demo / pass: demo).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseOtpauthUrl, verifyTotp } from "../totp.js";
import { gzipSync } from "node:zlib";
import { ACCOUNT, MAX_DELAYED_SEND, MOCK_EDITION, MOCK_LOCALE, NO_REGISTRY, Obj, PASS, PERMISSION_SNAPSHOT, PORT, SHARED_ACCOUNT, SHARED_CAPS, USER, account, nextState, state } from "./config.js";
import { PING_FLOOR_SECONDS, addEmail, blobs, calendars, people, principals, putBlob, recount } from "./data.js";
import { MAX_OBJECTS, MethodError, directory, enforceLimits, resolveRefs } from "./engine.js";
import { handlers } from "./handlers.js";
export { account } from "./config.js";
import { checkOtp } from "./auth.js";
import { sseClients, broadcast } from "./events.js";

/* ---------- http ---------- */
function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="mock"' });
  res.end(JSON.stringify({ type: "about:blank", status: 401, title: "Unauthorized" }));
}

function checkAuth(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return false;
  const raw = Buffer.from(h.slice(6), "base64").toString();
  const sep = raw.indexOf(":");
  if (sep < 0) return false;
  const u = raw.slice(0, sep);
  const p = raw.slice(sep + 1);
  if (u !== USER) return false;
  // App passwords are recognized by shape and skip the second factor, which is
  // exactly what lets a webmail session survive 2FA being switched on.
  if (account.appPasswords.some((a) => a.secret === p)) return true;
  if (!account.otpUrl) return p === account.password;
  const at = p.lastIndexOf("$");
  if (at < 0) return false;
  return p.slice(0, at) === account.password && checkOtp(p.slice(at + 1));
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => { const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
}

const session = () => ({
  capabilities: { "urn:ietf:params:jmap:core": { maxSizeUpload: 50000000, maxConcurrentUpload: 4, maxSizeRequest: 10000000, maxConcurrentRequests: 4, maxCallsInRequest: 16, maxObjectsInGet: MAX_OBJECTS, maxObjectsInSet: MAX_OBJECTS, collationAlgorithms: ["i;ascii-casemap"] }, "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {}, "urn:ietf:params:jmap:vacationresponse": {}, "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: "BBvig2GPmqohMJJHMzp6bTKviHibYiVCyAY8gdq2fPhS-9YfO9_0TnhMyZ0a0JxTsbCqd3zm1rEiXsXsL3jveJY" },
  "urn:ietf:params:jmap:emailpush": {},
  "urn:ietf:params:jmap:sieve": { implementation: "mock" }, "urn:ietf:params:jmap:calendars": {}, "urn:ietf:params:jmap:calendars:parse": {}, "urn:ietf:params:jmap:contacts": {}, "urn:ietf:params:jmap:contacts:parse": {}, "urn:ietf:params:jmap:principals": {}, "urn:ietf:params:jmap:principals:availability": {}, "urn:ietf:params:jmap:quota": {}, "urn:ietf:params:jmap:blob": {}, "urn:ietf:params:jmap:filenode": {} },
  /*
   * Two accounts: the demo user's own, and one somebody has shared.
   *
   * The shared one carries the *same* capability list, because that is what
   * Stalwart does -- checked on 0.16.19 (2026-08-27), where a shared account
   * advertised mail, calendars, contacts and the rest, identical to a personal
   * one, whatever had actually been shared. Giving the mock a truthful shared
   * account is the only way to exercise the Files "Shared with me" list, and
   * the only way this stays honest about what can be inferred from a
   * capability, which is nothing.
   */
  accounts: { [SHARED_ACCOUNT]: { name: "grace@example.org", isPersonal: false, isReadOnly: false, accountCapabilities: SHARED_CAPS }, [ACCOUNT]: { name: USER, isPersonal: true, isReadOnly: false, accountCapabilities: { "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": { maxDelayedSend: MAX_DELAYED_SEND, submissionExtensions: { FUTURERELEASE: [], SIZE: [], DSN: [], DELIVERYBY: [], "MT-PRIORITY": ["MIXER"], REQUIRETLS: [] } }, "urn:ietf:params:jmap:vacationresponse": {}, "urn:ietf:params:jmap:sieve": {}, "urn:ietf:params:jmap:calendars": {}, "urn:ietf:params:jmap:contacts": {}, "urn:ietf:params:jmap:principals": {}, "urn:ietf:params:jmap:quota": {}, "urn:ietf:params:jmap:filenode": {}, ...(NO_REGISTRY ? {} : { "urn:stalwart:jmap": {} }) } } },
  primaryAccounts: { ...Object.fromEntries(["mail", "submission", "vacationresponse", "sieve", "calendars", "contacts", "principals", "quota", "filenode", "blob"].map((c) => [`urn:ietf:params:jmap:${c}`, ACCOUNT])), ...(NO_REGISTRY ? {} : { "urn:stalwart:jmap": ACCOUNT }) },
  username: USER,
  apiUrl: `http://127.0.0.1:${PORT}/jmap/`,
  downloadUrl: `http://127.0.0.1:${PORT}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `http://127.0.0.1:${PORT}/jmap/upload/{accountId}/`,
  eventSourceUrl: `http://127.0.0.1:${PORT}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
  state: String(state.n),
});


/** Exported so tests can drive the mock in-process and shut it down. */
export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (!checkAuth(req)) return unauthorized(res);
  if (url.pathname === "/.well-known/jmap" || url.pathname === "/jmap/session") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(session()));
  }
  // The account info endpoint; the only place a server reports its edition.
  if (url.pathname === "/api/account" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ permissions: directory.permissions, edition: MOCK_EDITION, locale: MOCK_LOCALE }));
  }
  // The registry schema, cut down to the permission list the Roles picker
  // reads. Gzipped as the real file is, from the 0.16.22 snapshot the
  // translations are checked against.
  if (url.pathname === "/api/schema" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    return res.end(gzipSync(JSON.stringify({ enums: { Permission: PERMISSION_SNAPSHOT } })));
  }
  if (url.pathname === "/jmap/" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString()) as { methodCalls: [string, Obj, string][]; using?: string[] };
    // A capability the server cannot parse fails the whole request, not the one
    // call that wanted it - which is why an over-eager `using` is so damaging.
    // Stalwart decides this by parsing the urn, not by looking it up in the
    // session, so a capability it hands out per-account is still usable here:
    // `urn:stalwart:jmap` never appears in the session-level capabilities and
    // the registry calls that name it work all the same.
    const known = new Set([...Object.keys(session().capabilities), ...Object.keys(session().accounts[ACCOUNT]?.accountCapabilities ?? {})]);
    const unknown = (body.using ?? []).find((u) => !known.has(u));
    if (unknown) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "urn:ietf:params:jmap:error:unknownCapability", status: 400, detail: `Unknown capability: ${JSON.stringify(unknown)}` }));
    }
    const responses: [string, Obj, string][] = [];
    const touched = new Set<string>();
    const creations: Record<string, string> = {};
    for (const [name, rawArgs, id] of body.methodCalls) {
      const h = handlers[name];
      // The registry, and every x: method with it, arrived in 0.16.
      if (!h) { responses.push(["error", { type: "unknownMethod" }, id]); continue; }
      try {
        const args = resolveRefs(rawArgs, responses, creations);
        enforceLimits(name, args);
        const r = h(args);
        responses.push([name, r as Obj, id]);
        for (const [cid, obj] of Object.entries(((r as Obj).created as Obj) ?? {})) {
          const newId = (obj as Obj)?.id;
          if (typeof newId === "string") creations[cid] = newId;
        }
        if (name.endsWith("/set") || name.endsWith("/import")) touched.add(name.split("/")[0]!);
      } catch (err) {
        if (err instanceof MethodError) responses.push(["error", { type: err.type, description: err.message }, id]);
        else responses.push(["error", { type: "serverFail", description: String(err) }, id]);
      }
    }
    if (touched.size) { nextState(); setTimeout(() => broadcast([...touched, ...(touched.has("Email") ? ["Mailbox", "Thread"] : [])]), 50); }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ methodResponses: responses, sessionState: "1" }));
  }
  if (url.pathname.startsWith("/jmap/upload/") && req.method === "POST") {
    const data = await readBody(req);
    const type = req.headers["content-type"] ?? "application/octet-stream";
    const blobId = putBlob(data, type);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ accountId: ACCOUNT, blobId, type, size: data.length }));
  }
  if (url.pathname.startsWith("/jmap/download/")) {
    const [, , , , blobId] = url.pathname.split("/");
    const b = blobs.get(blobId ?? "");
    if (!b) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": url.searchParams.get("accept") ?? b.type, "content-length": b.data.length });
    return res.end(b.data);
  }
  /*
   * The `ping` query parameter, and what comes back for it.
   *
   * **Confirmed live on 0.16.21 (2026-09-06):** the interval is in **seconds**
   * — `data: {"interval": 30}` — where up to 0.16.20 the same field carried
   * milliseconds. The server floors it at 30 s (asking for 1, 2 or 5 all
   * answered 30 and pinged every 30 s) and honors anything above (45 pinged
   * at 45 s and said 45, 60 at 60 and said 60). `ping=0` disables pings
   * altogether; a value that is not a number at all — `abc`, or empty — is a
   * 400 before the stream opens.
   *
   * The first ping arrives one whole interval in, not on connect, so nothing
   * is written here: `flushHeaders` opens the stream on its own. A mock that
   * pinged immediately would let a client treat the first ping as an
   * connection-established signal and hang forever against the real thing.
   */
  if (url.pathname.startsWith("/jmap/eventsource")) {
    const raw = url.searchParams.get("ping");
    const asked = Number(raw);
    if (raw === null || raw === "" || !Number.isInteger(asked) || asked < 0) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "urn:ietf:params:jmap:error:notRequest", status: 400 }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    sseClients.add(res);
    const interval = asked === 0 ? 0 : Math.max(asked, PING_FLOOR_SECONDS);
    const t = interval
      ? setInterval(() => res.write(`event: ping\ndata: {"interval": ${interval}}\n\n`), interval * 1000)
      : null;
    req.on("close", () => { if (t) clearInterval(t); sseClients.delete(res); });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-stalwart] listening on http://127.0.0.1:${PORT}  (login: ${USER} / ${PASS})`);
  console.log(`[mock-stalwart] run the app with: STALWART_URL=http://127.0.0.1:${PORT} npm run dev`);
});

// Periodically inject a new inbox email to demo push
setInterval(() => {
  const p = people[Math.floor(Math.random() * people.length)]!;
  addEmail({ from: [p[0]!, p[1]!], subject: `Live update ${new Date().toLocaleTimeString()}`, daysAgo: 0, mailbox: "inbox", unread: true, html: true });
  recount();
  nextState();
  broadcast(["Email", "Mailbox", "Thread"]);
}, 120_000).unref();

