# Cloudflare Workers spike

Not a fork, not a supported target. It exists to answer one question —
**how much of ihasmail would survive being run on Workers?** — with a running
Worker rather than an opinion.

The answer: the app survived, three files did not, and one feature cannot be
ported as written.

Run it:

```bash
npm run mock -w server            # a Stalwart to talk to
cd server/cloudflare && npm i && npm run dev
```

Then sign in against it (the CSRF header is not optional):

```bash
curl -s -c c.txt -X POST localhost:8791/api/auth/login \
  -H 'content-type: application/json' -H 'x-requested-with: ihasmail' \
  -d '{"username":"demo@example.com","password":"demo","remember":false}'
```

## What survived

`createApp()` is untouched in substance. Every route, every middleware, the
JMAP proxy, the blob paths, the CSRF guard, the security headers — all of it
runs in workerd exactly as it runs in Node, because the app was already a Hono
app talking `fetch`, `Request` and `Response`. The Node server is an entry
point, not an architecture, and `src/worker.ts` is the same 40 lines wearing a
different hat.

Verified against the mock through the Worker: sign-in, `Mailbox/get` over the
JMAP proxy, session listing, revoking other sessions, and SSE (a `ping` frame
arrived on `/api/events`). Streaming responses need no special handling —
`return new Response(res.body)` is already the Workers idiom.

## What had to change, and why

Four changes to shared code, all of them things the Node server did not need
but is not harmed by. Together they are ~100 lines, most of it comment.

1. **`SessionBackend` methods became `Awaitable`** (`sessions.ts`), and their
   13 call sites in `app.ts` grew an `await`. KV is over the network; a Map is
   not. The in-process store still answers synchronously and satisfies the
   wider type unchanged.
2. **The session backend became swappable** (`setSessionBackend`), because a
   Worker gets its bindings per request and cannot construct a store at import.
3. **Three module-scope assumptions about being a process on a disk**:
   `loadDotEnv()` and the `staticDir` / immutability paths in `config.ts`, and
   `scripts/version.mjs` resolving the repo root at import. Each one threw
   during startup, before a line of configuration was read, looking for a file
   this runtime cannot have. All three are now guarded or lazy.
4. **The rate limiter's `setInterval` became an amortised sweep**
   (`ratelimit.ts`). Workers forbids timers in global scope. The sweep only
   reclaims keys nobody is asking about, which never needed a clock.

## What does not port

**The image proxy.** `imageproxy.ts` resolves the hostname with `node:dns`,
rejects private ranges, and then connects to *the resolved address* — the gap
it closes is DNS rebinding between the check and the socket. Workers has no
DNS API and no way to pin a connection to an address, so the file returns 502
under workerd (confirmed, not assumed). Cloudflare's own fetch refuses
private-range destinations, so a port would not be defenceless — but the
guarantee would be Cloudflare's rather than ours, and that is a different
security claim, not the same one reimplemented.

**Rate limiting is per-isolate**, which on Workers means close to
unenforced. It needs Cloudflare's rate-limiting binding or a Durable Object
before anyone relies on it. The spike leaves it as-is and says so.

## What KV costs

`KVSessionStore` mirrors `SessionStore` exactly — same record, same sealing, so
KV holds ciphertext and a hash rather than passwords. Two differences worth
knowing:

- **Sliding expiry is a write**, so it is rate-limited to once a minute per
  session rather than free.
- **KV is eventually consistent between colos.** A revocation — including the
  one a password change triggers — has a window where an old cookie still
  resolves somewhere else. That window is the reason to reach for a Durable
  Object instead, and this class is the shape that swap would take.

The username is in a second key (`u:<user>:<id>`) because KV cannot query by
value, and `listForUser` / `destroyAllForUser` are exactly the two operations
`sessions.ts` already says a stateless cookie cannot serve.

## The part that is not code

A Worker can only reach a **publicly resolvable Stalwart**, which rules out the
deployment ihasmail's own README describes: one container beside the mail
server, JMAP over loopback. Anyone running that shape needs Stalwart on a
public hostname or a Cloudflare Tunnel before any of this is available to them,
and that is a product decision rather than a porting problem — the same
"nothing else to run" promise that parked Kubernetes.

It is worth being exact about who that applies to, because it is not everyone
and it was not the first assumption made here. The deployment this was written
against already runs the app and Stalwart in **two different datacentres**,
with `STALWART_URL` a public HTTPS name. Every JMAP call, blob and SSE stream
already crosses the internet; a Worker would not add a hop, it would move the
first one. Today that hop is user → app datacentre → mail datacentre. On
Workers it is user → nearest colo → mail datacentre, which is the same second
leg and a shorter first one for anybody who is not sitting beside the app host.

So for a split deployment the objection in this section is not an objection.
What is left of the case against is the three things above — the image proxy,
rate limiting, and KV's consistency window — and none of them is
architectural.
