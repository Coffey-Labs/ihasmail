import { checkOtp } from "./auth.js";
import { cardChanges, cardLog, emailChanges, recordCardChange, recordEmailChange, broadcast } from "./events.js";
import { randomUUID } from "node:crypto";
import { eventGetView, expandOccurrences, occurrenceAt, occurrenceView, parseSyntheticId, splitOccurrencePatch, syntheticId, type Occurrence } from "./recurrence.js";
import { holdUntilOf, undoStatusOf } from "./futurerelease.js";
import { ACCOUNT, MASKED, MAX_DELAYED_SEND, MOCK_LOCALE, NO_FUTURE_RELEASE, Obj, PUSH_TTL_MS, SHARED_ACCOUNT, account, nextState, state } from "./config.js";
import { NO_KEYWORD_SORT, abRights, blobs, booksFor, calendarsFor, cards, compareBy, emails, eventsFor, fileNodes, fr, identities, mailboxes, mb, nodesFor, participantIdentities, principals, pushSubscriptions, putBlob, recount, rightsCal, seq, sharedCards, sieveScripts, vacationBox } from "./data.js";
import { Handler, MethodError, applyPatch, calendarEventParse, calendarEventSet, directory, genericGet, genericSet, hideShareWithUnlessAsked, matchFilter, matchSubmissionFilter, pick, resolveEvent, setResp, submissionView, submissions } from "./engine.js";

/** Stalwart's limit per account (0.16.22). */
const MAX_PUSH_SUBSCRIPTIONS = 15;
/** What an empty or missing `types` list is taken to mean: everything. */
const ALL_PUSH_TYPES = ["Email", "EmailDelivery", "Mailbox", "Thread", "Identity", "EmailSubmission", "VacationResponse", "CalendarEvent", "Calendar", "ContactCard", "AddressBook", "FileNode", "Quota", "SieveScript", "PushSubscription"];

export const handlers: Record<string, Handler> = {
  // 0.16 exposes the account locale here, under a permission ordinary users
  // actually have (unlike x:Account below, which needs sysAccountGet).
  "x:AccountSettings/get": (a) => {
    const ids = (a.ids as string[] | null) ?? ["singleton"];
    const list = ids.filter((id) => id === "singleton").map((id) => ({ id, locale: MOCK_LOCALE, timeZone: null, description: null }));
    return { accountId: ACCOUNT, state: String(state.n), list: list.map((x) => pick(x, a.properties as string[] | null)), notFound: ids.filter((id) => id !== "singleton") };
  },
  // Stalwart's directory registry: accounts, domains and roles, behind the
  // same permissions as the real thing. The locale fallback reads x:Account
  // too, and is refused here exactly when a real server would refuse it.
  ...directory.handlers,
  "Mailbox/get": (a) => hideShareWithUnlessAsked(a, genericGet(mailboxes)(a) as { list: Obj[] }) as never,
  "Mailbox/set": (a) => { const r = genericSet(mailboxes, "m", (o) => Object.assign(o, { ...mb(o.id as string, o.name as string, null, (o.parentId as string) ?? null), ...o }))(a); recount(); return r; },
  "Mailbox/changes": () => ({ accountId: ACCOUNT, oldState: "1", newState: String(state.n), hasMoreChanges: false, created: [], updated: [], destroyed: [] }),
  "Email/query": (a) => {
    let list = emails.filter((e) => matchFilter(e, a.filter as Obj));
    /*
     * Honor the sort rather than always answering newest-first. This used to
     * ignore it entirely, which reproduced a server that silently returns a
     * different order from the one asked for -- the one shape of wrongness a
     * client cannot detect.
     */
    const sort = (a.sort as Obj[] | undefined) ?? [{ property: "receivedAt", isAscending: false }];
    if (NO_KEYWORD_SORT && sort.some((c) => String(c.property) === "hasKeyword")) {
      // A method-level failure, the way a real server refuses an optional sort:
      // the whole call fails rather than the sort being quietly dropped.
      throw new MethodError("unsupportedSort", "Sorting on hasKeyword is not supported.");
    }
    list.sort((x, y) => {
      for (const c of sort) {
        const asc = c.isAscending !== false;
        const cmp = compareBy(x, y, String(c.property), c.keyword as string | undefined);
        if (cmp !== 0) return asc ? cmp : -cmp;
      }
      return 0;
    });
    if (a.collapseThreads) {
      const seen = new Set<string>();
      list = list.filter((e) => { const t = e.threadId as string; if (seen.has(t)) return false; seen.add(t); return true; });
    }
    const pos = Number(a.position ?? 0);
    const limit = Number(a.limit ?? 50);
    return { accountId: ACCOUNT, queryState: String(state.n), canCalculateChanges: false, position: pos, ids: list.slice(pos, pos + limit).map((e) => e.id), total: list.length, limit };
  },
  "Email/get": (a) => genericGet(emails)(a),
  /*
   * Real changes, not an empty answer.
   *
   * This used to return three empty arrays whatever had happened, so the
   * client's whole reconciliation path -- `Email/changes`, then deciding what
   * to do with what came back -- never ran against the mock. A bug living in
   * that path could not be reproduced here at all, which is how one reached
   * production and survived being "fixed" once (#100). The log below is what
   * the real server can answer from.
   */
  "Email/changes": (a) => {
    const since = Number(a.sinceState ?? 0);
    const relevant = emailChanges.filter((c) => c.state > since);
    const pick = (k: "created" | "updated" | "destroyed") => [...new Set(relevant.flatMap((c) => c[k]))];
    return { accountId: ACCOUNT, oldState: String(a.sinceState ?? "1"), newState: String(state.n), hasMoreChanges: false, created: pick("created"), updated: pick("updated"), destroyed: pick("destroyed") };
  },
  "Email/set": (a) => {
    const r = genericSet(emails, "e", (o) => {
      const bv = (o.bodyValues as Record<string, { value: string }>) ?? {};
      const walk = (p: Obj | undefined, acc: Obj[]) => { if (!p) return; if (p.partId && bv[p.partId as string]) acc.push({ ...p, blobId: putBlob(bv[p.partId as string]!.value, p.type as string), size: bv[p.partId as string]!.value.length }); (p.subParts as Obj[] | undefined)?.forEach((s) => walk(s, acc)); };
      const parts: Obj[] = [];
      walk(o.bodyStructure as Obj, parts);
      o.textBody = parts.filter((p) => p.type === "text/plain");
      o.htmlBody = parts.filter((p) => p.type === "text/html");
      o.attachments = [];
      const collect = (p: Obj | undefined) => { if (!p) return; if (p.blobId && !p.partId && p.type !== "multipart/mixed") (o.attachments as Obj[]).push({ ...p, size: p.size ?? 0 }); (p.subParts as Obj[] | undefined)?.forEach(collect); };
      collect(o.bodyStructure as Obj);
      o.hasAttachment = (o.attachments as Obj[]).length > 0;
      o.threadId = o.inReplyTo ? (emails.find((e) => (e.messageId as string[] | null)?.[0] === (o.inReplyTo as string[])[0])?.threadId ?? `t${o.id}`) : `t${o.id}`;
      o.receivedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      o.size = 2000;
      o.preview = (bv.text?.value ?? "").slice(0, 100);
      o.messageId = [`${o.id}@mock`];
      o.blobId = putBlob(`Subject: ${o.subject}\r\n\r\n${bv.text?.value ?? ""}`, "message/rfc822");
    })(a);
    recount();
    nextState();
    recordEmailChange({
      created: Object.values((r.created ?? {}) as Record<string, { id: string }>).map((x) => x.id),
      updated: Object.keys((a.update as Obj) ?? {}),
      destroyed: (r.destroyed as string[] | undefined) ?? [],
    });
    /* A real server pushes a state change after a set, and the client acts on
       it -- `Email/changes` runs and the store reconciles what came back. The
       mock stayed silent, so that whole path never ran here and a bug living
       in it could not be reproduced: marking a message read went round the
       server and back on the live instance, and did nothing at all on the mock
       (#100). Announced now, the way Stalwart does. */
    broadcast(["Email", "Mailbox", "Thread"]);
    return r;
  },
  "Email/import": (a) => { const created: Obj = {}; for (const [cid, spec] of Object.entries((a.emails as Obj) ?? {})) { const id = `e${seq.counter++}`; emails.push({ id, blobId: (spec as Obj).blobId, threadId: `t${id}`, mailboxIds: (spec as Obj).mailboxIds, keywords: (spec as Obj).keywords ?? {}, size: 100, receivedAt: new Date().toISOString(), subject: "(imported message)", from: [{ name: null, email: "import@example" }], to: null, preview: "", hasAttachment: false, textBody: [], htmlBody: [], attachments: [], bodyValues: {} }); created[cid] = { id }; } recount(); return setResp({ created }); },
  "Thread/get": (a) => { const ids = a.ids as string[]; const list = ids.map((id) => ({ id, emailIds: emails.filter((e) => e.threadId === id).sort((x, y) => String(x.receivedAt).localeCompare(String(y.receivedAt))).map((e) => e.id) })).filter((t) => t.emailIds.length); return { accountId: ACCOUNT, state: String(state.n), list, notFound: ids.filter((id) => !list.some((t) => t.id === id)) }; },
  // Stalwart 0.16 registry objects backing self-service credentials.
  "x:AccountPassword/get": () => ({
    accountId: ACCOUNT,
    state: String(state.n),
    list: [{ id: "singleton", otpAuth: { otpUrl: account.otpUrl ? MASKED : null, otpCode: null } }],
    notFound: [],
  }),
  "x:AccountPassword/set": (a) => {
    const patch = ((a.update as Obj) ?? {})["singleton"] as Obj | undefined;
    if (!patch) return setResp({ updated: {} });
    const current = patch.currentSecret as string | undefined;
    const code = (patch["otpAuth/otpCode"] ?? (patch.otpAuth as Obj | undefined)?.otpCode) as string | undefined;
    if (!current) {
      return setResp({ notUpdated: { singleton: { type: "forbidden", description: "Current secret must be provided to change the password or OTP auth." } } });
    }
    if (current !== account.password) {
      return setResp({ notUpdated: { singleton: { type: "forbidden", description: "Current secret is incorrect." } } });
    }
    if (account.otpUrl && !code) {
      return setResp({ notUpdated: { singleton: { type: "forbidden", description: "Current OTP code is required to change the password or OTP auth." } } });
    }
    if (account.otpUrl && !checkOtp(code!)) {
      return setResp({ notUpdated: { singleton: { type: "forbidden", description: "Current secret is incorrect." } } });
    }
    const secret = patch.secret as string | undefined;
    if (secret !== undefined && secret !== MASKED) {
      if (secret.length < 8) {
        return setResp({ notUpdated: { singleton: { type: "invalidProperties", properties: ["secret"], description: "Password must be at least 8 characters long." } } });
      }
      account.password = secret;
    }
    if ("otpAuth/otpUrl" in patch) {
      const url = patch["otpAuth/otpUrl"] as string | null;
      if (url !== MASKED) account.otpUrl = url;
    }
    state.n++;
    return setResp({ updated: { singleton: null } });
  },
  /*
   * Push subscriptions. The JMAP half can be modeled; delivery cannot -- that
   * runs through the browser vendor's real push service, so nothing local will
   * ever make a notification appear.
   *
   * What is worth reproducing is the handshake, because it is the part that
   * fails quietly: a subscription is created unverified and stays silent until
   * the client echoes back a code the server pushed. A mock that marked one
   * verified on creation would let a client ship without ever implementing
   * that, and the symptom in production is "registered, and no notifications".
   */
  "PushSubscription/get": (a) => {
    const ids = (a.ids as string[] | null) ?? pushSubscriptions.map((s) => s.id as string);
    const list = pushSubscriptions.filter((s) => ids.includes(s.id as string));
    // `keys` is write-only in JMAP: the server never hands it back.
    return { accountId: ACCOUNT, state: String(state.n), list: list.map((s) => { const { keys: _drop, ...rest } = s; return rest; }), notFound: ids.filter((i) => !list.some((s) => s.id === i)) };
  },
  "PushSubscription/set": (a) => {
    const created: Obj = {};
    const notCreated: Obj = {};
    const updated: Obj = {};
    const notUpdated: Obj = {};
    const destroyed: string[] = [];
    for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
      const o = obj as Obj;
      const keys = (o.keys ?? {}) as Obj;
      // Stalwart 0.16 was fixed to accept the unpadded base64url the W3C Push
      // API produces; padding it would be the client inventing a shape.
      for (const k of ["p256dh", "auth"]) {
        const v = String(keys[k] ?? "");
        if (!v) { notCreated[cid] = { type: "invalidProperties", properties: ["keys"], description: `Missing ${k}.` }; break; }
        if (v.includes("=") || v.includes("+") || v.includes("/")) {
          notCreated[cid] = { type: "invalidProperties", properties: ["keys"], description: `${k} must be unpadded base64url.` };
          break;
        }
      }
      if (notCreated[cid]) continue;
      if (!String(o.url ?? "").startsWith("https://")) {
        notCreated[cid] = { type: "invalidProperties", properties: ["url"], description: "Push endpoint must be https." };
        continue;
      }
      // A filter condition with a null value is not a filter -- the real server
      // answers "Invalid filter" and refuses the whole subscription. ihasmail
      // shipped `inMailbox: null` meaning "the inbox", which meant nothing at
      // all here, and the mock accepted it happily. It does not any more.
      const badFilter = Object.entries((o.emailPush ?? {}) as Obj).find(([, cfg]) => {
        const f = ((cfg as Obj)?.filter ?? {}) as Obj;
        return Object.values(f).some((v) => v === null || v === undefined);
      });
      if (badFilter) {
        notCreated[cid] = { type: "invalidArguments", properties: ["emailPush"], description: "Invalid filter." };
        continue;
      }
      /*
       * As Stalwart does (checked live on 0.16.22, 2026-09-16): a repeated
       * deviceClientId is a second subscription, not a replacement -- this mock
       * used to replace, which is how the client's pile-up never showed here
       * (#375) -- and an account holds at most fifteen.
       */
      const deviceId = String(o.deviceClientId ?? "");
      if (pushSubscriptions.length >= MAX_PUSH_SUBSCRIPTIONS) {
        notCreated[cid] = { type: "overQuota", description: "There are too many subscriptions, please delete some before adding a new one." };
        continue;
      }
      const id = `ps${randomUUID().slice(0, 6)}`;
      /*
       * A subscription expires, and this used to hand back `expires: null`.
       * That is the one shape that makes the client's real problem invisible in
       * development: JMAP puts a ceiling of seven days on a push subscription
       * and expects the client to re-register before it lapses, so a client
       * that never renews works perfectly against a mock that never expires
       * anything and goes silent a week after being deployed. Seven days here,
       * so "does this client renew?" is a question the mock can answer.
       */
      const expires = new Date(Date.now() + PUSH_TTL_MS).toISOString();
      // An empty or missing list means every type, not none.
      const types = Array.isArray(o.types) && o.types.length ? o.types : ALL_PUSH_TYPES;
      pushSubscriptions.push({ id, deviceClientId: deviceId, url: o.url, types, emailPush: o.emailPush ?? null, expires, keys, verified: false, code: `v${randomUUID().slice(0, 8)}` });
      created[cid] = { id, expires };
      state.n++;
    }
    for (const [id, patch] of Object.entries((a.update as Obj) ?? {})) {
      const s = pushSubscriptions.find((x) => x.id === id);
      if (!s) { notUpdated[id] = { type: "notFound" }; continue; }
      const code = (patch as Obj).verificationCode;
      if (code !== undefined) {
        if (code !== s.code) { notUpdated[id] = { type: "invalidProperties", properties: ["verificationCode"], description: "Verification code does not match." }; continue; }
        s.verified = true;
      }
      // An expiry can be extended, up to the same seven days a new one gets.
      const wanted = (patch as Obj).expires;
      if (typeof wanted === "string") {
        const at = Math.min(Date.parse(wanted), Date.now() + PUSH_TTL_MS);
        if (Number.isNaN(at)) { notUpdated[id] = { type: "invalidProperties", properties: ["expires"] }; continue; }
        s.expires = new Date(at).toISOString();
      }
      updated[id] = null;
      state.n++;
    }
    for (const id of (a.destroy as string[]) ?? []) {
      const i = pushSubscriptions.findIndex((x) => x.id === id);
      if (i >= 0) { pushSubscriptions.splice(i, 1); destroyed.push(id); state.n++; }
    }
    return setResp({ created, notCreated, updated, notUpdated, destroyed });
  },
  "x:AppPassword/get": (a) => genericGet(account.appPasswords)(a),
  "x:AppPassword/set": (a) => {
    const created: Obj = {};
    const destroyed: string[] = [];
    for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
      const id = `ap${randomUUID().slice(0, 6)}`;
      // Real app passwords carry their credential id, so the server can spot
      // one by its shape alone. Mirror that.
      const secret = `$app$${id}$${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const row: Obj = { id, description: (obj as Obj).description ?? "App password", createdAt: new Date().toISOString(), expiresAt: null, secret };
      account.appPasswords.push(row);
      created[cid] = { id, secret, createdAt: row.createdAt };
    }
    for (const id of (a.destroy as string[]) ?? []) {
      const i = account.appPasswords.findIndex((x) => x.id === id);
      if (i >= 0) { account.appPasswords.splice(i, 1); destroyed.push(id); }
    }
    state.n++;
    return setResp({ created, destroyed });
  },
  "Identity/get": genericGet(identities),
  "Identity/set": (a) => {
    // Stalwart's cap is `value.len() < 2048` on a Rust string: 2047 bytes of
    // UTF-8, not characters. Anything longer is refused by name.
    for (const [where, entries] of [["notCreated", (a.create as Obj) ?? {}], ["notUpdated", (a.update as Obj) ?? {}]] as const) {
      for (const [key, obj] of Object.entries(entries)) {
        const over = ["htmlSignature", "textSignature"].find((prop) => {
          const v = (obj as Obj)[prop];
          return typeof v === "string" && Buffer.byteLength(v, "utf8") > 2047;
        });
        if (over) return setResp({ [where]: { [key]: { type: "invalidProperties", properties: [over], description: "Invalid property." } } });
      }
    }
    return genericSet(identities, "i", (o) => Object.assign(o, { replyTo: null, bcc: null, textSignature: "", htmlSignature: "", mayDelete: true, ...o }))(a);
  },
  "EmailSubmission/get": (a) => {
    const ids = a.ids as string[] | null | undefined;
    const found = ids ? ids.map((id) => submissions.find((x) => x.id === id)).filter(Boolean) as Obj[] : submissions;
    return { accountId: ACCOUNT, state: String(state.n), list: found.map((x) => pick(submissionView(x), a.properties as string[] | null)), notFound: ids ? ids.filter((id) => !submissions.some((x) => x.id === id)) : [] };
  },
  "EmailSubmission/query": (a) => {
    const list = submissions.filter((s) => matchSubmissionFilter(s, a.filter as Obj | undefined));
    list.sort((x, y) => String(x.sendAt).localeCompare(String(y.sendAt)));
    const pos = Number(a.position ?? 0);
    const limit = Number(a.limit ?? 50);
    return { accountId: ACCOUNT, queryState: String(state.n), canCalculateChanges: false, position: pos, ids: list.slice(pos, pos + limit).map((s) => s.id), total: list.length, limit };
  },
  "EmailSubmission/set": (a) => {
    const created: Obj = {};
    const notCreated: Obj = {};
    const updated: Obj = {};
    const notUpdated: Obj = {};
    for (const [cid, raw] of Object.entries((a.create as Obj) ?? {})) {
      const sub = raw as Obj;
      const emailId = sub.emailId as string;
      const e = emails.find((x) => x.id === emailId);
      if (!e) {
        notCreated[cid] = { type: "invalidProperties", properties: ["emailId"], description: "Blob for email not found." };
        continue;
      }
      const hold = holdUntilOf(sub.envelope as Obj | undefined, Date.now());
      if (Number.isNaN(hold)) {
        notCreated[cid] = { type: "invalidProperties", properties: ["envelope"], description: "Failed to parse mailFrom parameters." };
        continue;
      }
      // Stalwart rejects MAIL FROM outright past its own limit.
      if (hold !== null && hold > Date.now() + MAX_DELAYED_SEND * 1000) {
        notCreated[cid] = { type: "forbiddenMailFrom", description: `Server rejected MAIL-FROM: 501 5.5.4 Requested release time exceeds maximum of ${new Date(Date.now() + MAX_DELAYED_SEND * 1000).toISOString()}.` };
        continue;
      }
      // With the MTA extension off, the hold is dropped in silence.
      const sendAt = hold !== null && !NO_FUTURE_RELEASE ? hold : Date.now();
      const rec: Obj = {
        id: `s${randomUUID().slice(0, 6)}`,
        identityId: sub.identityId ?? null,
        emailId,
        threadId: e.threadId ?? null,
        envelope: sub.envelope ?? null,
        sendAt: new Date(sendAt).toISOString(),
        undoStatus: null,
        deliveryStatus: null,
      };
      submissions.push(rec);
      created[cid] = { id: rec.id, sendAt: rec.sendAt, undoStatus: undoStatusOf(rec, Date.now()) };
      const patch = ((a.onSuccessUpdateEmail as Obj) ?? {})[`#${cid}`] as Obj | undefined;
      if (patch) applyPatch(e, patch);
    }
    for (const [id, raw] of Object.entries((a.update as Obj) ?? {})) {
      const patch = raw as Obj;
      const sub = submissions.find((x) => x.id === id);
      if (!sub) { notUpdated[id] = { type: "notFound" }; continue; }
      if (patch.undoStatus !== "canceled") {
        notUpdated[id] = { type: "invalidProperties", properties: ["undoStatus"], description: "Only cancellation is supported." };
        continue;
      }
      const status = undoStatusOf(sub, Date.now());
      if (status !== "pending") {
        notUpdated[id] = { type: "cannotUnsend", description: status === "canceled" ? "The message was already canceled." : "The message has already been sent." };
        continue;
      }
      sub.undoStatus = "canceled";
      updated[id] = null;
    }
    recount();
    return setResp({
      created,
      updated,
      ...(Object.keys(notCreated).length ? { notCreated } : {}),
      ...(Object.keys(notUpdated).length ? { notUpdated } : {}),
    });
  },
  "VacationResponse/get": () => ({ accountId: ACCOUNT, state: "1", list: [vacationBox.current], notFound: [] }),
  "VacationResponse/set": (a) => { const p = ((a.update as Obj) ?? {}).singleton as Obj | undefined; if (p) vacationBox.current = { ...vacationBox.current, ...p }; return setResp({ updated: { singleton: null } }); },
  "Quota/get": () => ({ accountId: ACCOUNT, state: "1", list: [{ id: "q1", resourceType: "octets", used: 734003200, hardLimit: 2147483648, scope: "account", name: "Storage", types: ["Email"] }], notFound: [] }),
  "SieveScript/get": genericGet(sieveScripts),
  "SieveScript/set": (a) => { const r = genericSet(sieveScripts, "sv", (o) => Object.assign(o, { isActive: false, ...o }))(a); const act = (a.onSuccessActivateScript as string | undefined); if (act) { const id = act.startsWith("#") ? ((r.created as Obj)[act.slice(1)] as Obj)?.id : act; for (const s of sieveScripts) s.isActive = s.id === id; } if (a.onSuccessDeactivateScript) for (const s of sieveScripts) s.isActive = false; return r; },
  "SieveScript/validate": () => ({ accountId: ACCOUNT, error: null }),
  "Calendar/get": (a) => genericGet(calendarsFor(a.accountId))(a),
  "Calendar/set": (a) => genericSet(calendarsFor(a.accountId), "c", (o) => Object.assign(o, { color: "#0f766e", isSubscribed: true, isVisible: true, isDefault: false, includeInAvailability: "all", timeZone: null, shareWith: null, myRights: rightsCal(), description: null, sortOrder: 0, ...o }))(a),
  /*
   * With `expandRecurrences` every id that comes back is synthetic — a one-off
   * included, which is what a live 0.16.19 does and what makes `baseEventId`
   * useless as a test for a series. Without it (the `findByUid` path) the
   * stored ids come back untouched, because callers hand those straight to a
   * destroy and mean the whole event.
   */
  "CalendarEvent/query": (a) => {
    const list = eventsFor(a.accountId);
    const filter = (a.filter as Obj) ?? {};
    const matching = list.filter((e) => !filter.uid || e.uid === filter.uid);
    if (!a.expandRecurrences) {
      return { accountId: a.accountId ?? ACCOUNT, queryState: "1", canCalculateChanges: false, position: 0, ids: matching.map((e) => e.id), total: matching.length };
    }
    const from = filter.after ? new Date(filter.after as string) : new Date(-8640000000000);
    const to = filter.before ? new Date(filter.before as string) : new Date(8640000000000);
    const ids: string[] = [];
    for (const e of matching) for (const occ of expandOccurrences(e, from, to)) ids.push(syntheticId(e.id as string, occ.recurrenceId));
    return { accountId: a.accountId ?? ACCOUNT, queryState: "1", canCalculateChanges: false, position: 0, ids, total: ids.length };
  },
  "CalendarEvent/get": (a) => {
    const list = eventsFor(a.accountId);
    const ids = a.ids as string[] | null | undefined;
    const properties = a.properties as string[] | null | undefined;
    // With no ids every event comes back under its stored id, none synthetic.
    if (!ids) return { accountId: ACCOUNT, state: String(state.n), list: list.map((x) => eventGetView(x, false, properties)), notFound: [] };
    const found: Obj[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const resolved = resolveEvent(list, id);
      if (!resolved) { notFound.push(id); continue; }
      found.push(resolved.occ ? eventGetView(occurrenceView(resolved.base, resolved.occ), true, properties) : eventGetView(resolved.base, false, properties));
    }
    return { accountId: ACCOUNT, state: String(state.n), list: found, notFound };
  },
  // Stalwart 0.16 rejects the RFC 8984 array outright and silently discards
  // participants addressed the RFC 8984 way. The mock did neither, which is how
  // #26 and #30 reached a live server unnoticed — so it now does both.
  "CalendarEvent/set": (a) => calendarEventSet(a),
  "CalendarEvent/parse": (a) => calendarEventParse(a),
  "ParticipantIdentity/get": genericGet(participantIdentities),
  "Principal/query": () => ({ accountId: ACCOUNT, queryState: "1", canCalculateChanges: false, position: 0, ids: principals.map((p) => p.id) }),
  "Principal/get": genericGet(principals),
  // One busy block a day across whatever range was asked for. It used to answer
  // with a single block on the first day whatever the range, which was all an
  // availability bar a day wide could show -- and left a bar covering several
  // days looking as though everyone were free for all but the first of them.
  "Principal/getAvailability": (a) => {
    const from = new Date(String(a.utcStart));
    const to = new Date(String(a.utcEnd));
    const list: Obj[] = [];
    for (let day = new Date(from); day < to && list.length < 31; day.setUTCDate(day.getUTCDate() + 1)) {
      const date = day.toISOString().slice(0, 11);
      list.push({ utcStart: `${date}13:00:00Z`, utcEnd: `${date}14:30:00Z`, busyStatus: "confirmed", event: null });
    }
    return { accountId: ACCOUNT, list };
  },
  "AddressBook/get": (a) => genericGet(booksFor(a.accountId))(a),
  "AddressBook/set": (a) => {
    /* Stalwart refuses any update to a book shared read-only, `isSubscribed`
       included -- "You are not allowed to modify this address book", confirmed
       live on 0.16.19 (2026-08-27) from the account holding the share. A mock
       that accepted it would have agreed that subscribing works, which is
       exactly the belief that shipped. Calendars accept the same write; the
       difference is the server's, not ours. */
    if (a.accountId === SHARED_ACCOUNT && a.update) {
      const notUpdated: Obj = {};
      for (const id of Object.keys(a.update as Obj)) notUpdated[id] = { type: "forbidden", description: "You are not allowed to modify this address book." };
      return { accountId: a.accountId, oldState: String(state.n), newState: String(state.n), updated: null, notUpdated };
    }
    return genericSet(booksFor(a.accountId), "ab", (o) => Object.assign(o, { description: null, sortOrder: 0, isDefault: false, isSubscribed: true, shareWith: {}, myRights: abRights(), ...o }))(a);
  },
  "ContactCard/query": (a) => { const list = a.accountId === SHARED_ACCOUNT ? sharedCards : cards; return { accountId: a.accountId ?? ACCOUNT, queryState: "1", canCalculateChanges: false, position: 0, ids: list.map((c) => c.id), total: list.length }; },
  // An empty `properties` list returns `id` alone, which `pick` already does.
  // 0.16.22 made Stalwart agree; through 0.16.21 it returned every property.
  "ContactCard/get": (a) => genericGet(a.accountId === SHARED_ACCOUNT ? sharedCards : cards)(a),
  /*
   * Recorded and announced like Email/set, so the client's incremental sync
   * (`ContactCard/changes`, then fetching what it names) runs here too. A
   * state older than the log's window cannot be answered, as on a real server.
   */
  "ContactCard/set": (a) => {
    /*
     * Stalwart refuses a `blobId` inside `media` (0.16.22, checked live on
     * 2026-09-16), and takes the whole call down for it. The mock took
     * anything, which is how ihasmail shipped a photo upload that never
     * worked against the real server (#376).
     */
    const withBlobMedia = (o: unknown) => Object.values(((o as Obj)?.media as Record<string, Obj> | null) ?? {}).some((m) => m && "blobId" in m);
    const refuse = { type: "invalidProperties", description: "blobIds in media is not supported.", properties: ["media"] };
    const create = { ...((a.create as Obj) ?? {}) };
    const update = { ...((a.update as Obj) ?? {}) };
    const notCreated: Obj = {};
    const notUpdated: Obj = {};
    for (const [k, v] of Object.entries(create)) if (withBlobMedia(v)) { notCreated[k] = refuse; delete create[k]; }
    for (const [k, v] of Object.entries(update)) if (withBlobMedia(v)) { notUpdated[k] = refuse; delete update[k]; }
    const r = genericSet(cards, "cc")({ ...a, create, update });
    if (Object.keys(notCreated).length) r.notCreated = { ...((r.notCreated as Obj) ?? {}), ...notCreated };
    if (Object.keys(notUpdated).length) r.notUpdated = notUpdated;
    nextState();
    recordCardChange({
      created: Object.values((r.created ?? {}) as Record<string, { id: string }>).map((x) => x.id),
      updated: Object.keys((r.updated ?? {}) as Obj),
      destroyed: (r.destroyed as string[] | undefined) ?? [],
    });
    broadcast(["ContactCard"]);
    return r;
  },
  "ContactCard/changes": (a) => {
    const since = Number(a.sinceState ?? 0);
    if (since < cardLog.floor) throw new MethodError("cannotCalculateChanges", "That state is too old to answer from.");
    const relevant = cardChanges.filter((c) => c.state > since);
    const pick = (k: "created" | "updated" | "destroyed") => [...new Set(relevant.flatMap((c) => c[k]))];
    return { accountId: a.accountId ?? ACCOUNT, oldState: String(a.sinceState ?? "1"), newState: String(state.n), hasMoreChanges: false, created: pick("created"), updated: pick("updated"), destroyed: pick("destroyed") };
  },
  "ContactCard/parse": (a) => { const parsed: Obj = {}; for (const b of a.blobIds as string[]) { const t = blobs.get(b)?.data.toString() ?? ""; const fn = /^FN:(.*)$/m.exec(t)?.[1]?.trim() ?? "Imported"; const em = /^EMAIL[^:]*:(.*)$/m.exec(t)?.[1]?.trim(); parsed[b] = [{ "@type": "Card", version: "1.0", uid: randomUUID(), kind: "individual", name: { full: fn }, emails: em ? { e1: { address: em } } : undefined }]; } return { accountId: ACCOUNT, parsed, notParsable: [] }; },
  "FileNode/query": (a) => {
    const f = (a.filter as Obj) ?? {};
    const fileNodes = nodesFor(a.accountId);
    // `nodeType` is a filter 0.16.19 really applies -- checked live on
    // 2026-08-27, where it returned the two directories out of seven nodes. The
    // mock ignoring it was worse than not having it: the sidebar tree asks for
    // directories and was handed files, which it then drew as folders.
    const list = fileNodes.filter((n) => {
      if (f.isTopLevel ? n.parentId != null : f.parentId ? n.parentId !== f.parentId : false) return false;
      if (f.nodeType && n.nodeType !== f.nodeType) return false;
      return true;
    });
    return { accountId: ACCOUNT, queryState: "1", canCalculateChanges: false, position: 0, ids: list.map((n) => n.id), total: list.length };
  },
  "FileNode/get": (a) => genericGet(nodesFor(a.accountId))(a),
  "FileNode/set": (a) => {
    return genericSet(nodesFor(a.accountId), "f", (o) => {
      Object.assign(o, { created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {}, size: o.blobId ? (blobs.get(o.blobId as string)?.data.length ?? 0) : null, type: o.type ?? null, blobId: o.blobId ?? null, ...o });
      // Without nodeType, a node is a directory precisely when it carries no
      // file properties. Keep it internally so query and get stay consistent.
      if (!o.nodeType) o.nodeType = o.blobId || o.size != null || o.type ? "file" : "directory";
    })(a);
  },
};

