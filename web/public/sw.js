/* ihasmail service worker.
   Two jobs: app-shell caching for installability and fast loads (API requests
   are never cached), and Web Push, which is the only part of ihasmail that runs
   when no tab is open. */
const VERSION = "ihasmail-v2";

/*
 * The mount, worked out rather than configured.
 *
 * This file is copied to the build verbatim -- Vite's `base` never touches
 * public/ -- so there is nothing to substitute BASE_PATH into. It does not
 * need one: the worker is served from the mount, so its own address says
 * where that is. `/mail/sw.js` gives `/mail`, `/sw.js` gives `""`, which is
 * the same canonical form the rest of the app uses.
 *
 * Deriving it here also means the worker cannot disagree with the page that
 * registered it, which a second copy of the value in a build-time constant
 * eventually would.
 */
const BASE = new URL("./", self.location).pathname.replace(/\/$/, "");
const SHELL = [`${BASE}/`, `${BASE}/manifest.webmanifest`, `${BASE}/img/logo.png`, `${BASE}/img/icon-192.png`, `${BASE}/favicon.ico`];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

/*
 * Where a share from the operating system is left for a tab to collect.
 *
 * Absolute and anchored to the mount, for the same reason the verification key
 * below is: a relative key is resolved against the URL of whoever asks, and the
 * worker and a tab deep in `/mail/inbox/…` are not at the same place.
 *
 * The files go in one entry each and the rest in a JSON index beside them,
 * because the Cache API stores Responses and a File is already one body.
 */
const SHARE_KEY = `${BASE}/ihasmail-share`;
const SHARE_MAX_FILES = 20;

/*
 * Take delivery of a share.
 *
 * This is a POST that navigates: the operating system submits a form at the
 * app and expects a page back. Nothing in ihasmail can answer it directly --
 * the app is a client-side router with no endpoint at that address, and the
 * server behind it would have to grow one that understood the composer. So the
 * worker takes the body, puts it where a tab can find it, and redirects to the
 * app, which then opens a draft holding it.
 *
 * The redirect happens whatever went wrong. A share that fails to stash costs
 * whatever was being shared, which is bad; a share that fails to *respond*
 * costs that and leaves the reader looking at a browser error page where they
 * expected their mail, which is worse.
 *
 * There is one case this cannot cover, and the server is deliberately not
 * taught to: an app still installed whose worker has been cleared away. The
 * POST then reaches the server, which answers 405, and the share is lost
 * either way -- the payload only ever existed in that request body. A server
 * route would trade a plain error for a silent nothing, and a share that
 * vanishes without saying so is the harder of the two to notice.
 */
async function stashShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(VERSION);
    const meta = {
      at: Date.now(),
      title: String(form.get("title") ?? ""),
      text: String(form.get("text") ?? ""),
      url: String(form.get("url") ?? ""),
      files: [],
    };
    const files = form.getAll("files").filter((f) => f && typeof f === "object" && "name" in f && f.size > 0);
    for (const [i, f] of files.slice(0, SHARE_MAX_FILES).entries()) {
      const key = `${SHARE_KEY}/${i}`;
      await cache.put(key, new Response(f, { headers: { "content-type": f.type || "application/octet-stream" } }));
      meta.files.push({ key, name: f.name || `file-${i + 1}`, type: f.type || "application/octet-stream" });
    }
    await cache.put(SHARE_KEY, new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
  } catch {
    /* nothing to hand on: the app opens on an empty inbox rather than an error */
  }
  // Absolute, because `Response.redirect` rejects a bare path outright rather
  // than resolving it -- so `${BASE}/mail` would throw here and the share
  // would end at a browser error page instead of the inbox.
  return Response.redirect(new URL(`${BASE}/mail?share=1`, self.location.origin).href, 303);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method === "POST" && new URL(req.url).pathname === `${BASE}/share`) {
    event.respondWith(stashShare(req));
    return;
  }
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(`${BASE}/api/`)) return;

  // Hashed build assets: cache-first.
  if (url.pathname.startsWith(`${BASE}/assets/`)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Navigations & everything else: network-first, fall back to cached shell.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(`${BASE}/`)));
    return;
  }
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});


/* ------------------------------------------------------------------ */
/* Web Push                                                            */
/* ------------------------------------------------------------------ */

/*
 * Stalwart signs with VAPID and pushes straight to the browser's push service;
 * nothing here talks to ihasmail's server on the way in. The payload is an
 * EmailPush object (draft-ietf-jmap-emailpush) carrying enough of the message
 * to show a useful notification without a round-trip, which is what lets a
 * notification appear immediately rather than after a request.
 *
 * This file used to say that a round-trip was impossible here, and it was
 * wrong: see the note on `jmap()`. What it can do is ask; what it cannot do is
 * be sure of an answer, since the session may be gone by the time it does. So
 * the payload still carries the message and the request is only made when
 * somebody presses something.
 *
 * A JMAP subscription also delivers a PushVerification first, and stays silent
 * until the client echoes its code back. It is stashed for a tab to confirm
 * rather than answered here — on the same reasoning, and because a
 * verification that failed silently would leave push looking broken with
 * nothing to show for it. Answering it directly is now possible and is worth
 * revisiting.
 */

/*
 * Absolute, and anchored to the mount rather than to whatever page happens to
 * be open.
 *
 * A relative key is resolved against the URL of whoever is asking: the worker
 * lives at `<base>/sw.js`, so it stored this under `<base>/…`, while a tab at
 * `/mail/inbox/abc` looked for it under `/mail/inbox/…`. The two only ever
 * agreed when the open page was the root, so a verification code that arrived
 * with no tab open was written where the next tab would not look -- and the
 * subscription stayed silent, which is the same thing push failing looks like.
 */
const VERIFY_KEY = `${BASE}/ihasmail-push-verification`;

/*
 * What a tab wrote down for this worker: the account, which mailbox is the
 * archive, and the worker's own text in the reader's language. See
 * `lib/swFacts.ts` for why any of that has to be handed over rather than
 * worked out here.
 *
 * Everything that depends on it is skipped when it is missing, which is the
 * state between installing this worker and next opening the app. An action
 * button with no label, or one that files mail into a mailbox guessed by name,
 * is worse than the notification that was here before.
 */
const FACTS_KEY = `${BASE}/ihasmail-worker-facts`;

async function readFacts() {
  try {
    const hit = await (await caches.open(VERSION)).match(FACTS_KEY);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

/*
 * A JMAP call, made as the reader.
 *
 * This worker was written believing it could not do this -- that acting on
 * mail needed a session it had no way to hold. It does not: ihasmail's session
 * is an httpOnly cookie against its own origin, and the only other thing the
 * API asks for is a fixed `x-requested-with` header that is not a secret and
 * is not held anywhere. A same-origin fetch from here carries the cookie like
 * any other, so `Email/set` from a notification is an ordinary request.
 *
 * What is genuinely not available is anything the *tab* holds in memory, and
 * the answer is that the API asks for none of it.
 *
 * The session can still be gone -- expired, signed out, or a cookie that did
 * not survive the browser closing -- which arrives as a 401 and is reported
 * rather than swallowed. A tap that silently does nothing is the failure worth
 * avoiding here: the reader has already put the phone down.
 */
async function jmap(methodCalls) {
  const res = await fetch(`${BASE}/api/jmap`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json", "x-requested-with": "ihasmail" },
    body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  // A JMAP method can fail inside a 200. Treat that as a failure too, rather
  // than reporting success because the transport was fine.
  const first = body?.methodResponses?.[0];
  if (!first || first[0] === "error") throw new Error(first?.[1]?.type || "error");
  const notUpdated = first[1]?.notUpdated;
  if (notUpdated && Object.keys(notUpdated).length) throw new Error("notUpdated");
  return body;
}

function textOf(email, strings) {
  const from = email?.from?.[0];
  const who = from?.name || from?.email || strings.newMessage;
  const what = email?.subject || strings.noSubject;
  return { title: who, body: what, preview: email?.preview || "" };
}

/*
 * Two, because that is what a phone shows. `Notification.maxActions` is 2 on
 * Android Chrome, and anything past it is dropped silently -- so these are the
 * two worth having rather than the two that happened to come first. Both are
 * triage: they are what somebody does to a notification they have read the
 * whole of on the lock screen and does not need to open.
 *
 * Reply is deliberately not among them. It cannot be done from here, so it
 * would have to open the app -- and an action that opens the app is what
 * tapping the notification already does.
 */
function actionsFor(facts) {
  if (!facts) return [];
  const actions = [];
  if (facts.archiveId) actions.push({ action: "archive", title: facts.strings.archive });
  actions.push({ action: "read", title: facts.strings.markRead });
  return actions;
}

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    /* not JSON: fall through to the generic notification below */
  }

  // The verification handshake. No credentials here, so hand it to a tab —
  // an open one now, or the next one to start.
  if (data && data["@type"] === "PushVerification") {
    event.waitUntil((async () => {
      const payload = { id: data.pushSubscriptionId, code: data.verificationCode };
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      if (clients.length) {
        for (const c of clients) c.postMessage({ type: "push-verification", ...payload });
      } else {
        const cache = await caches.open(VERSION);
        await cache.put(VERIFY_KEY, new Response(JSON.stringify(payload)));
      }
    })());
    return;
  }

  const emails = (data && data["@type"] === "EmailPush" && Array.isArray(data.emails)) ? data.emails : [];
  event.waitUntil((async () => {
    const facts = await readFacts();
    const strings = facts?.strings ?? { newMail: "New mail", newMessage: "New message", noSubject: "(no subject)" };
    /*
     * Mark the app icon, without claiming a number.
     *
     * `setAppBadge()` with no count shows a dot rather than a figure, which is
     * the only honest thing to show from here: this worker has no session, so
     * it cannot ask how many messages are unread, and a push carries the new
     * mail rather than a total. Counting the payload would badge "2" over an
     * inbox holding forty. The next time a tab opens, `setUnreadBadge` writes
     * the real count over the dot.
     */
    if ("setAppBadge" in self.navigator) await self.navigator.setAppBadge().catch(() => {});

    if (!emails.length) {
      // A StateChange, or a payload too large to carry the message. Say
      // something true rather than inventing a sender.
      await self.registration.showNotification(strings.newMail, {
        icon: `${BASE}/img/icon-192.png`, badge: `${BASE}/img/favicon-64.png`, tag: "ihasmail-mail", data: { url: `${BASE}/mail` },
      });
      return;
    }
    // One notification per message, collapsing repeats of the same message by
    // tag so a re-push does not stack.
    for (const email of emails.slice(0, 5)) {
      const { title, body, preview } = textOf(email, strings);
      await self.registration.showNotification(title, {
        body: preview ? `${body}\n${preview}` : body,
        icon: `${BASE}/img/icon-192.png`,
        badge: `${BASE}/img/favicon-64.png`,
        tag: `ihasmail-${email.id || body}`,
        // Only where there is a message to act on: a payload without an id can
        // be shown but not archived, and a button that cannot work should not
        // be drawn.
        actions: email.id ? actionsFor(facts) : [],
        data: {
          url: email.id ? `${BASE}/mail/inbox/${email.id}` : `${BASE}/mail`,
          id: email.id || null,
          title,
          accountId: facts?.accountId ?? null,
          archiveId: facts?.archiveId ?? null,
          failed: strings.failed ?? null,
        },
      });
    }
  })());
});

/*
 * Do what the button said, without opening anything.
 *
 * The whole point of an action is that the phone goes back in the pocket, so
 * this must not fall back to opening the app when the call fails -- that is
 * the same interruption the action existed to avoid. It re-notifies instead,
 * saying it did not happen, and leaves opening ihasmail to the reader.
 *
 * Archiving replaces the mailbox set rather than adding to it, which is what
 * archiving is: the message leaves the inbox. Marking read is a keyword and
 * touches nothing else.
 */
async function runAction(action, data) {
  const { id, accountId, archiveId } = data;
  if (!id || !accountId) return;
  const patch = action === "archive"
    ? { mailboxIds: { [archiveId]: true } }
    : { "keywords/$seen": true };
  try {
    if (action === "archive" && !archiveId) throw new Error("no archive mailbox");
    await jmap([["Email/set", { accountId, update: { [id]: patch } }, "0"]]);
  } catch {
    await self.registration.showNotification(data.title || "ihasmail", {
      body: data.failed || "Could not do that — open ihasmail and try again",
      icon: `${BASE}/img/icon-192.png`,
      badge: `${BASE}/img/favicon-64.png`,
      tag: `ihasmail-failed-${id}`,
      data: { url: data.url },
    });
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === "archive" || event.action === "read") {
    event.waitUntil(runAction(event.action, data));
    return;
  }
  const url = data.url || `${BASE}/mail`;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    // Reuse a tab if one is open rather than piling up windows. Same origin is
    // not enough under a prefix: `includeUncontrolled` widens the match to the
    // whole origin, so on a host that also serves something else this would
    // navigate a stranger's tab to our inbox.
    for (const c of clients) {
      const at = new URL(c.url);
      if (at.origin === self.location.origin && (at.pathname === BASE || at.pathname.startsWith(`${BASE}/`))) {
        await c.focus();
        if ("navigate" in c) await c.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
