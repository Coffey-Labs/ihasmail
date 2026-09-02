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

self.addEventListener("fetch", (event) => {
  const req = event.request;
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
 * nothing here talks to ihasmail's server. The payload is an EmailPush object
 * (draft-ietf-jmap-emailpush) carrying enough of the message to show a useful
 * notification without a round-trip — which matters, because when this fires
 * there may be no session to make one with.
 *
 * A JMAP subscription also delivers a PushVerification first, and stays silent
 * until the client echoes its code back. That cannot be done from here (no
 * credentials), so it is stashed for a tab to collect and confirm.
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

function textOf(email) {
  const from = email?.from?.[0];
  const who = from?.name || from?.email || "New message";
  const what = email?.subject || "(no subject)";
  return { title: who, body: what, preview: email?.preview || "" };
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
    if (!emails.length) {
      // A StateChange, or a payload too large to carry the message. Say
      // something true rather than inventing a sender.
      await self.registration.showNotification("New mail", {
        icon: `${BASE}/img/icon-192.png`, badge: `${BASE}/img/favicon-64.png`, tag: "ihasmail-mail", data: { url: `${BASE}/mail` },
      });
      return;
    }
    // One notification per message, collapsing repeats of the same message by
    // tag so a re-push does not stack.
    for (const email of emails.slice(0, 5)) {
      const { title, body, preview } = textOf(email);
      await self.registration.showNotification(title, {
        body: preview ? `${body}\n${preview}` : body,
        icon: `${BASE}/img/icon-192.png`,
        badge: `${BASE}/img/favicon-64.png`,
        tag: `ihasmail-${email.id || body}`,
        data: { url: email.id ? `${BASE}/mail/inbox/${email.id}` : `${BASE}/mail` },
      });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || `${BASE}/mail`;
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
