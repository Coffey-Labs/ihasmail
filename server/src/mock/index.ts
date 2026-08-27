/**
 * A tiny in-memory JMAP server that mimics the subset of Stalwart that ihasmail
 * uses. For local development and demos only:  `npm run mock` then point the
 * server at it with STALWART_URL=http://127.0.0.1:8788 (user: demo / pass: demo).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseOtpauthUrl, verifyTotp } from "../totp.js";
import { holdUntilOf, undoStatusOf } from "./futurerelease.js";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
/**
 * Omit `urn:stalwart:jmap` from the session, so a sign-in can be tested
 * against a server ihasmail does not support. This is only that: the rest of
 * the mock still behaves like 0.16. Emulating 0.15 properly went with the
 * support for it.
 */
const NO_REGISTRY = process.env.MOCK_NO_REGISTRY === "1";
/**
 * Stalwart advertises FUTURERELEASE in the session but only honours it when
 * the MTA's own `futureRelease` setting is on -- and that setting defaults to
 * off, in which case the hold is dropped without a word and the message goes
 * out at once. Set MOCK_NO_FUTURE_RELEASE=1 to reproduce that trap.
 */
const NO_FUTURE_RELEASE = process.env.MOCK_NO_FUTURE_RELEASE === "1";
/** What the session advertises, matching Stalwart's own 30 days. */
const MAX_DELAYED_SEND = 86400 * 30;
const ACCOUNT = "a1";
/** An account somebody has shared with the demo user. See the session below. */
const SHARED_ACCOUNT = "a2";
const SHARED_CAPS: Obj = {
  "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {}, "urn:ietf:params:jmap:vacationresponse": {},
  "urn:ietf:params:jmap:sieve": {}, "urn:ietf:params:jmap:calendars": {}, "urn:ietf:params:jmap:contacts": {},
  "urn:ietf:params:jmap:principals": {}, "urn:ietf:params:jmap:quota": {}, "urn:ietf:params:jmap:filenode": {},
};
const USER = process.env.MOCK_USER ?? "demo@example.com";
/** Locale the fake directory reports for the account (POSIX style, as Stalwart does). */
const MOCK_LOCALE = process.env.MOCK_LOCALE ?? "en_US";
const PASS = process.env.MOCK_PASS ?? "demo";
/**
 * Credential state, mutable so the self-service flows can be exercised against
 * the mock the way they run against a real 0.16 server: the password changes,
 * 2FA starts demanding a code on every request, and app passwords keep working
 * without one.
 */
export const account = { password: PASS, otpUrl: null as string | null, appPasswords: [] as Obj[] };
const MASKED = "[********]";

type Obj = Record<string, unknown>;
const state = { n: 1 };
const nextState = () => String(state.n++);

/* ---------- data ---------- */
/*
 * The names are Stalwart's own defaults, which follow the Exchange convention:
 * "Deleted Items" and "Sent Items", not "Trash" and "Sent". The mock used the
 * short forms, so anything built from a folder's name read differently here
 * than in production -- "Empty Trash" against the mock, "Empty Deleted Items"
 * against a real server -- and every screenshot in the README showed a folder
 * list no user has. The role is what the client branches on; the name is only
 * ever displayed, which is exactly why it has to look right.
 */
/** Push subscriptions, as a fresh account has none. */
const pushSubscriptions: Obj[] = [];

const mailboxes: Obj[] = [
  mb("inbox", "Inbox", "inbox"),
  mb("drafts", "Drafts", "drafts"),
  mb("sent", "Sent Items", "sent"),
  mb("junk", "Junk Mail", "junk"),
  mb("trash", "Deleted Items", "trash"),
  mb("archive", "Archive", "archive"),
  mb("work", "Work", null),
  mb("work-inv", "Invoices", null, "work"),
  mb("news", "Newsletters", null),
];
function mb(id: string, name: string, role: string | null, parentId: string | null = null): Obj {
  return { id, name, parentId, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true } };
}

const blobs = new Map<string, { type: string; data: Buffer }>();
function putBlob(data: Buffer | string, type: string): string {
  const id = `b${randomUUID().slice(0, 8)}`;
  blobs.set(id, { type, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  return id;
}

const people = [
  ["Ada Lovelace", "ada@example.org"], ["Grace Hopper", "grace@example.org"], ["Linus Torvalds", "linus@kernel.example"],
  ["Margaret Hamilton", "margaret@nasa.example"], ["Alan Turing", "alan@bletchley.example"], ["GitHub", "noreply@github.example"],
  ["Stalwart Labs", "hello@stalw.art"], ["Weekly Digest", "digest@newsletter.example"], ["Finance Team", "finance@example.org"],
];
const subjects = [
  "Re: Q3 planning document", "Your invoice #4821 is ready", "Welcome to Stalwart!", "Lunch on Thursday?", "[PR] Fix push reconnect backoff",
  "Weekly digest: 12 new articles", "Photos from the hike", "Deployment window this weekend", "Contract draft v3 attached", "Can you review my slides?",
  "Reminder: dentist appointment", "Flight confirmation – BOS → SFO", "Team offsite agenda", "Re: Re: budget approval", "Security notice: new sign-in",
];
const emails: Obj[] = [];
let counter = 1;
function addEmail(o: { from: [string, string]; to?: string; subject: string; daysAgo: number; mailbox: string; threadId?: string; unread?: boolean; flagged?: boolean; html?: boolean; attach?: boolean; inReplyTo?: string }) {
  const id = `e${counter++}`;
  const received = new Date(Date.now() - o.daysAgo * 86400_000 - Math.random() * 3600_000 * 5).toISOString().replace(/\.\d{3}Z$/, "Z");
  const text = `Hi,\n\nThis is a sample message about "${o.subject}". It was generated by the ihasmail mock server so you can try the interface without a real mailbox.\n\nSome highlights:\n- Keyboard shortcuts (press ? )\n- Conversation view\n- Drag & drop to folders\n\nCheers,\n${o.from[0]}\n\n> On Monday, someone wrote:\n> This is the quoted part of an earlier message.\n> It should be collapsed by default.`;
  const html = `<html><body style="font-family:Arial"><p>Hi,</p><p>This is a <b>sample HTML message</b> about “${o.subject}”. It was generated by the ihasmail mock server.</p><ul><li>Keyboard shortcuts (press ?)</li><li>Conversation view</li><li><a href="https://stalw.art">Drag &amp; drop</a> to folders</li></ul><p><img src="https://example.com/tracker.gif" width="1" height="1" alt=""> <img src="cid:logo@mock" width="120" alt="logo"></p><p>Cheers,<br>${o.from[0]}</p><div class="gmail_quote">On Monday, someone wrote:<blockquote>This is the quoted part of an earlier message. It should be collapsed by default.</blockquote></div></body></html>`;
  const textBlob = putBlob(text, "text/plain");
  const htmlBlob = putBlob(html, "text/html");
  const attachments: Obj[] = [];
  if (o.attach) {
    attachments.push({ partId: "3", blobId: putBlob("%PDF-1.4 mock", "application/pdf"), size: 48213, name: "contract-v3.pdf", type: "application/pdf", charset: null, disposition: "attachment", cid: null });
    attachments.push({ partId: "4", blobId: putBlob(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), "image/png"), size: 68, name: "pixel.png", type: "image/png", charset: null, disposition: "attachment", cid: null });
  }
  if (o.html) attachments.push({ partId: "5", blobId: putBlob(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"), "image/png"), size: 68, name: "logo.png", type: "image/png", charset: null, disposition: "inline", cid: "logo@mock" });
  const e: Obj = {
    id, blobId: putBlob(`From: ${o.from[0]} <${o.from[1]}>\r\nTo: ${USER}\r\nSubject: ${o.subject}\r\nDate: ${received}\r\nMessage-ID: <${id}@mock>\r\n\r\n${text}`, "message/rfc822"),
    threadId: o.threadId ?? `t${id}`, mailboxIds: { [o.mailbox]: true },
    keywords: { ...(o.unread ? {} : { $seen: true }), ...(o.flagged ? { $flagged: true } : {}) },
    size: 4000 + Math.floor(Math.random() * 20000), receivedAt: received, sentAt: received,
    messageId: [`${id}@mock`], inReplyTo: o.inReplyTo ? [o.inReplyTo] : null, references: o.inReplyTo ? [o.inReplyTo] : null,
    from: [{ name: o.from[0], email: o.from[1] }], to: [{ name: "Demo User", email: o.to ?? USER }], cc: null, bcc: null, replyTo: null, sender: null,
    subject: o.subject, hasAttachment: Boolean(o.attach), preview: text.slice(0, 120).replace(/\n/g, " "),
    textBody: [{ partId: "1", blobId: textBlob, size: text.length, name: null, type: "text/plain", charset: "utf-8", disposition: null, cid: null }],
    htmlBody: o.html ? [{ partId: "2", blobId: htmlBlob, size: html.length, name: null, type: "text/html", charset: "utf-8", disposition: null, cid: null }] : [],
    attachments,
    bodyValues: { "1": { value: text, isEncodingProblem: false, isTruncated: false }, ...(o.html ? { "2": { value: html, isEncodingProblem: false, isTruncated: false } } : {}) },
    bodyStructure: { partId: null, blobId: null, size: 0, type: "multipart/mixed", name: null, charset: null, disposition: null, cid: null, subParts: [{ partId: "1", blobId: textBlob, size: text.length, type: "text/plain", name: null, charset: "utf-8", disposition: null, cid: null }, ...(o.html ? [{ partId: "2", blobId: htmlBlob, size: html.length, type: "text/html", name: null, charset: "utf-8", disposition: null, cid: null }] : []), ...attachments] },
    "header:List-Unsubscribe:asText": o.from[1].includes("newsletter") ? "<mailto:unsub@newsletter.example?subject=unsubscribe>, <https://newsletter.example/unsub>" : null,
    "header:X-Priority:asText": o.subject.startsWith("Security") ? "1 (Highest)" : null,
  };
  emails.push(e);
  return e;
}
// Seed
for (let i = 0; i < 45; i++) {
  const p = people[i % people.length]!;
  const subj = subjects[i % subjects.length]!;
  const e = addEmail({ from: [p[0]!, p[1]!], subject: subj, daysAgo: i * 0.7, mailbox: i % 9 === 8 ? "news" : i % 11 === 10 ? "work" : "inbox", unread: i % 3 === 0, flagged: i % 7 === 0, html: i % 2 === 0, attach: i % 5 === 0 });
  if (i % 4 === 0) {
    // thread replies
    addEmail({ from: ["Demo User", USER], to: p[1]!, subject: `Re: ${subj}`, daysAgo: i * 0.7 - 0.2, mailbox: "sent", threadId: e.threadId as string, inReplyTo: `${e.id}@mock`, html: true });
    addEmail({ from: [p[0]!, p[1]!], subject: `Re: ${subj}`, daysAgo: i * 0.7 - 0.4, mailbox: "inbox", threadId: e.threadId as string, unread: i % 8 === 0, inReplyTo: `${e.id}@mock`, html: i % 3 === 0 });
  }
}
addEmail({ from: ["Demo User", USER], to: "ada@example.org", subject: "Draft: ideas for the retreat", daysAgo: 0.1, mailbox: "drafts", html: true }).keywords = { $draft: true, $seen: true };
addEmail({ from: ["Spammy", "win@lottery.example"], subject: "You have WON!!!", daysAgo: 2, mailbox: "junk", unread: true });
addEmail({ from: ["Finance Team", "finance@example.org"], subject: "Invoice 2201 approved", daysAgo: 1, mailbox: "work-inv", unread: true });
addEmail({ from: ["Finance Team", "finance@example.org"], subject: "Invoice 2202 pending", daysAgo: 2, mailbox: "work-inv", unread: true });
// A thread whose unread message is not the last one: someone's server queued
// their reply for hours, so it landed after messages that answer it and sits in
// the middle of the conversation. Opening this thread at the newest message
// left that reply above the fold until the mark-read timer swept it (#87).
{
  const subj = "Compiler timings for the release";
  const t = addEmail({ from: ["Grace Hopper", "grace@example.org"], subject: subj, daysAgo: 6, mailbox: "inbox", html: true });
  const tid = t.threadId as string;
  const reply = (o: { from: [string, string]; daysAgo: number; mailbox: string; to?: string; unread?: boolean; html?: boolean }) =>
    addEmail({ ...o, subject: `Re: ${subj}`, threadId: tid, inReplyTo: `${t.id}@mock` });
  reply({ from: ["Alan Turing", "alan@example.org"], daysAgo: 5.5, mailbox: "inbox", unread: true });
  // Long enough after the unread one that the thread scrolls: opening at the
  // bottom put four messages between the reader and the mail they had not read.
  reply({ from: ["Demo User", USER], to: "grace@example.org", daysAgo: 5, mailbox: "sent", html: true });
  reply({ from: ["Grace Hopper", "grace@example.org"], daysAgo: 4.5, mailbox: "inbox" });
  reply({ from: ["Margaret Hamilton", "margaret@example.org"], daysAgo: 4, mailbox: "inbox", html: true });
  reply({ from: ["Demo User", USER], to: "margaret@example.org", daysAgo: 3.5, mailbox: "sent" });
  reply({ from: ["Grace Hopper", "grace@example.org"], daysAgo: 3, mailbox: "inbox", html: true });
}
// Invitation email
{
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//mock//EN\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:inv-1@mock\r\nDTSTAMP:20260820T100000Z\r\nDTSTART:20260825T140000Z\r\nDTEND:20260825T150000Z\r\nSUMMARY:Project kickoff\r\nORGANIZER;CN=Ada Lovelace:mailto:ada@example.org\r\nATTENDEE;CN=Demo User;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${USER}\r\nLOCATION:Room 4B\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const e = addEmail({ from: ["Ada Lovelace", "ada@example.org"], subject: "Invitation: Project kickoff", daysAgo: 0.3, mailbox: "inbox", unread: true });
  const b = putBlob(ics, "text/calendar");
  (e.bodyStructure as Obj).subParts = [...((e.bodyStructure as Obj).subParts as Obj[]), { partId: "9", blobId: b, size: ics.length, type: "text/calendar", name: "invite.ics", charset: "utf-8", disposition: "attachment", cid: null }];
  (e.attachments as Obj[]).push({ partId: "9", blobId: b, size: ics.length, type: "text/calendar", name: "invite.ics", charset: "utf-8", disposition: "attachment", cid: null });
  e.hasAttachment = true;
}

const identities: Obj[] = [
  { id: "i1", name: "Demo User", email: USER, replyTo: null, bcc: null, textSignature: "-- \nDemo User\nihasmail", htmlSignature: "<div>-- <br><b>Demo User</b><br>ihasmail</div>", mayDelete: false },
  { id: "i2", name: "Demo (alias)", email: "alias@example.com", replyTo: null, bcc: null, textSignature: "", htmlSignature: "", mayDelete: true },
];
let vacation: Obj = { id: "singleton", isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null };
const sieveScripts: Obj[] = [];
/* A calendar in the shared account, so "Shared with me" and a colleague's
   events appearing in the grid can be exercised. Read-only, as a share is. */
const sharedCalendars: Obj[] = [{ id: "c9", name: "Grace — Work", description: null, color: "#c084fc", sortOrder: 0, isSubscribed: true, isVisible: true, isDefault: true, includeInAvailability: "all", defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: "UTC", shareWith: {}, myRights: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false } }];
const sharedEvents: Obj[] = [];
const eventsFor = (accountId: unknown): Obj[] => (accountId === SHARED_ACCOUNT ? sharedEvents : events);
const calendarsFor = (accountId: unknown): Obj[] => (accountId === SHARED_ACCOUNT ? sharedCalendars : calendars);
const calendars: Obj[] = [{ id: "c1", name: "Personal", description: null, color: "#0f766e", sortOrder: 0, isSubscribed: true, isVisible: true, isDefault: true, includeInAvailability: "all", defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: "UTC", shareWith: null, myRights: rightsCal() }, { id: "c2", name: "Work", description: null, color: "#2563eb", sortOrder: 1, isSubscribed: true, isVisible: true, isDefault: false, includeInAvailability: "all", defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: "UTC", shareWith: null, myRights: rightsCal() }];
function rightsCal() { return { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true }; }
const events: Obj[] = [];
{
  const now = new Date();
  const d = (dayOff: number, h: number) => { const x = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOff, h, 0, 0); return x; };
  const local = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}T${String(x.getHours()).padStart(2, "0")}:00:00`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  events.push({ id: "ev1", calendarIds: { c1: true }, "@type": "Event", uid: "ev1", title: "Standup", start: local(d(0, 9)), timeZone: tz, duration: "PT30M", recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ day: "mo" }, { day: "tu" }, { day: "we" }, { day: "th" }, { day: "fr" }] }, showWithoutTime: false, status: "confirmed", freeBusyStatus: "busy", privacy: "public" });
  events.push({ id: "ev2", calendarIds: { c2: true }, "@type": "Event", uid: "ev2", title: "Design review", start: local(d(1, 14)), timeZone: tz, duration: "PT1H30M", showWithoutTime: false, locations: { l: { "@type": "Location", name: "Room 2" } }, participants: { me: { "@type": "Participant", name: "Demo User", calendarAddress: `mailto:${USER}`, roles: { owner: true, attendee: true }, participationStatus: "accepted" }, p2: { "@type": "Participant", name: "Ada Lovelace", calendarAddress: "mailto:ada@example.org", roles: { attendee: true, required: true }, participationStatus: "needs-action", expectReply: true } }, organizerCalendarAddress: `mailto:${USER}` });
  events.push({ id: "ev3", calendarIds: { c1: true }, "@type": "Event", uid: "ev3", title: "Conference", start: local(d(3, 0)).slice(0, 10) + "T00:00:00", duration: "P2D", showWithoutTime: true, timeZone: null });
  events.push({ id: "ev4", calendarIds: { c1: true }, "@type": "Event", uid: "ev4", title: "Lunch with Grace", start: local(d(2, 12)), timeZone: tz, duration: "PT1H", showWithoutTime: false, color: "#db2777" });
  // Two in the shared account, so a colleague's calendar has something in it.
  sharedEvents.push({ id: "sv1", calendarIds: { c9: true }, "@type": "Event", uid: "sv1", title: "Grace: release planning", start: local(d(1, 10)), timeZone: tz, duration: "PT1H", showWithoutTime: false, status: "confirmed", freeBusyStatus: "busy", privacy: "public" });
  sharedEvents.push({ id: "sv2", calendarIds: { c9: true }, "@type": "Event", uid: "sv2", title: "Grace: on leave", start: local(d(4, 0)).slice(0, 10) + "T00:00:00", duration: "P1D", showWithoutTime: true, timeZone: null });
}
const participantIdentities: Obj[] = [{ id: "pi1", name: "Demo User", calendarAddress: `mailto:${USER}`, sendTo: { imip: `mailto:${USER}` }, isDefault: true }];
const abRights = (write = true) => ({ mayRead: true, mayWrite: write, mayShare: write, mayDelete: write });
const addressBooks: Obj[] = [{ id: "ab1", name: "Personal", description: null, sortOrder: 0, isDefault: true, isSubscribed: true, shareWith: {}, myRights: abRights() }];
/* A book in the shared account, so "Shared with me" and addressing a message
   from somebody else's contacts can be exercised at all. Read-only, which is
   what a share usually is. */
const sharedAddressBooks: Obj[] = [{ id: "ab9", name: "Team contacts", description: null, sortOrder: 0, isDefault: true, isSubscribed: true, shareWith: {}, myRights: abRights(false) }];
const sharedCards: Obj[] = [
  { id: "sc1", addressBookIds: { ab9: true }, name: { full: "Katherine Johnson" }, emails: { e1: { address: "katherine@example.org", contexts: {} } }, phones: {}, organizations: {}, nicknames: {}, addresses: {}, notes: {}, updated: new Date().toISOString() },
  { id: "sc2", addressBookIds: { ab9: true }, name: { full: "Dorothy Vaughan" }, emails: { e1: { address: "dorothy@example.org", contexts: {} } }, phones: {}, organizations: {}, nicknames: {}, addresses: {}, notes: {}, updated: new Date().toISOString() },
];
const booksFor = (accountId: unknown): Obj[] => (accountId === SHARED_ACCOUNT ? sharedAddressBooks : addressBooks);
const cards: Obj[] = people.slice(0, 6).map((p, i) => {
  const [given, surname] = p[0]!.split(" ");
  return { id: `cc${i}`, addressBookIds: { ab1: true }, "@type": "Card", version: "1.0", uid: `uid-cc${i}`, kind: "individual", name: { components: [{ kind: "given", value: given }, { kind: "surname", value: surname ?? "" }], isOrdered: true }, emails: { e1: { address: p[1], contexts: { work: true } } }, phones: i % 2 ? { p1: { number: `+1 555 010${i}`, features: { mobile: true } } } : undefined, organizations: i % 3 ? { o1: { name: "Example Corp" } } : undefined };
});
const principals: Obj[] = people.slice(0, 5).map((p, i) => ({ id: `pr${i}`, type: "individual", name: p[0], description: null, email: p[1], timeZone: "UTC" }));
const fileNodes: Obj[] = [
  { id: "f1", parentId: null, nodeType: "directory", blobId: null, size: null, name: "Documents", type: null, created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {}, role: "documents" },
  { id: "f2", parentId: "f1", nodeType: "file", blobId: putBlob("hello world", "text/plain"), size: 11, name: "notes.txt", type: "text/plain", created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {} },
  { id: "f3", parentId: null, nodeType: "file", blobId: putBlob("%PDF-1.4 mock", "application/pdf"), size: 14, name: "report.pdf", type: "application/pdf", created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {} },
];

/* What the shared account holds. Its own nodes, so opening the share in Files
   shows something different from the reader's own folders rather than the same
   list under another name. */
const sharedFileNodes: Obj[] = [
  { id: "s1", parentId: null, nodeType: "directory", blobId: null, size: null, name: "Team plans", type: null, created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {} },
  { id: "s2", parentId: "s1", nodeType: "file", blobId: putBlob("shared notes", "text/plain"), size: 12, name: "roadmap.txt", type: "text/plain", created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {} },
];
/** The node list an account owns. */
const nodesFor = (accountId: unknown): Obj[] => (accountId === SHARED_ACCOUNT ? sharedFileNodes : fileNodes);

function fr() {
  return { mayRead: true, mayAddChildren: true, mayRename: true, mayDelete: true, mayModifyContent: true, mayShare: true };
}

function recount() {
  for (const m of mailboxes) {
    const inBox = emails.filter((e) => (e.mailboxIds as Obj)[m.id as string]);
    m.totalEmails = inBox.length;
    m.unreadEmails = inBox.filter((e) => !(e.keywords as Obj).$seen).length;
    const threads = new Set(inBox.map((e) => e.threadId));
    m.totalThreads = threads.size;
    m.unreadThreads = new Set(inBox.filter((e) => !(e.keywords as Obj).$seen).map((e) => e.threadId)).size;
  }
}
recount();

/* ---------- helpers ---------- */
function pick(o: Obj, props?: string[] | null): Obj {
  if (!props) return o;
  const out: Obj = { id: o.id };
  for (const p of props) if (p in o) out[p] = o[p];
  else if (p.startsWith("header:")) out[p] = null;
  return out;
}
function resolveRefs(args: Obj, responses: [string, Obj, string][], creations: Record<string, string>): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith("#")) {
      const r = v as { resultOf: string; name: string; path: string };
      const resp = responses.find((x) => x[2] === r.resultOf && x[0] === r.name);
      out[k.slice(1)] = resp ? jsonPointer(resp[1], r.path) : [];
    } else out[k] = resolveCreationIds(v, creations, k);
  }
  return out;
}

/**
 * Creation references (RFC 8620 5.3): a `#creationId` anywhere a real id would
 * go, pointing at something created earlier in the same request. Sending a
 * message uses one -- `EmailSubmission/set` names the email as `#m` -- so
 * without this the mock quietly declines to create any submission at all.
 *
 * `onSuccessUpdateEmail` is left alone: its keys are creation ids by design and
 * the method that receives them resolves them itself.
 */
function resolveCreationIds(value: unknown, creations: Record<string, string>, key?: string): unknown {
  if (key === "onSuccessUpdateEmail") return value;
  if (typeof value === "string") {
    return value.startsWith("#") && creations[value.slice(1)] ? creations[value.slice(1)]! : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveCreationIds(v, creations));
  if (value && typeof value === "object") {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) {
      const nk = k.startsWith("#") && creations[k.slice(1)] ? creations[k.slice(1)]! : k;
      out[nk] = resolveCreationIds(v, creations, k);
    }
    return out;
  }
  return value;
}
function jsonPointer(obj: unknown, path: string): unknown {
  const parts = path.split("/").filter(Boolean);
  let cur: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "*") {
      const rest = parts.slice(i + 1).join("/");
      const arr = (cur as unknown[]).flatMap((x) => { const v = jsonPointer(x, "/" + rest); return Array.isArray(v) ? v : [v]; });
      return arr;
    }
    cur = (cur as Obj)?.[p];
  }
  return cur;
}
function matchFilter(e: Obj, f: Obj | undefined): boolean {
  if (!f) return true;
  if (f.operator) {
    const conds = (f.conditions as Obj[]).map((c) => matchFilter(e, c));
    return f.operator === "AND" ? conds.every(Boolean) : f.operator === "OR" ? conds.some(Boolean) : !conds.some(Boolean);
  }
  const kw = e.keywords as Obj;
  if (f.inMailbox && !(e.mailboxIds as Obj)[f.inMailbox as string]) return false;
  if (f.hasKeyword && !kw[f.hasKeyword as string]) return false;
  if (f.notKeyword && kw[f.notKeyword as string]) return false;
  if (f.hasAttachment !== undefined && Boolean(e.hasAttachment) !== f.hasAttachment) return false;
  const hay = `${e.subject} ${JSON.stringify(e.from)} ${JSON.stringify(e.to)} ${e.preview}`.toLowerCase();
  for (const k of ["text", "subject", "from", "to", "body"]) if (f[k] && !hay.includes(String(f[k]).toLowerCase())) return false;
  if (f.before && String(e.receivedAt) >= String(f.before)) return false;
  if (f.after && String(e.receivedAt) < String(f.after)) return false;
  if (f.minSize && Number(e.size) < Number(f.minSize)) return false;
  if (f.maxSize && Number(e.size) > Number(f.maxSize)) return false;
  return true;
}
function applyPatch(obj: Obj, patch: Obj) {
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes("/")) {
      const [root, ...rest] = k.split("/");
      const key = rest.join("/");
      const target = (obj[root!] as Obj) ?? {};
      if (v === null) delete target[key];
      else target[key] = v;
      obj[root!] = target;
    } else obj[k] = v;
  }
}

/* ---------- method handlers ---------- */
type Handler = (args: Obj) => Obj | [string, Obj][];
/** A method-level failure, surfaced as ["error", {type, description}, id]. */
class MethodError extends Error {
  constructor(
    public readonly type: string,
    description?: string,
  ) {
    super(description ?? type);
  }
}

const MAX_OBJECTS = 500;

/**
 * Stalwart refuses a whole method call that carries more objects than it will
 * process at once - it does not quietly handle the first 500. Enforce the same
 * ceiling the session advertises, so an unbatched client fails here too.
 */
function enforceLimits(name: string, args: Obj): void {
  const tooLarge = () => {
    throw new MethodError("requestTooLarge", "The number of ids requested by the client exceeds the maximum number the server is willing to process in a single method call.");
  };
  if (name.endsWith("/get")) {
    const ids = args.ids as unknown[] | null | undefined;
    if (Array.isArray(ids) && ids.length > MAX_OBJECTS) tooLarge();
  }
  if (name.endsWith("/set")) {
    const n =
      Object.keys((args.create as Obj) ?? {}).length +
      Object.keys((args.update as Obj) ?? {}).length +
      ((args.destroy as unknown[] | undefined)?.length ?? 0);
    if (n > MAX_OBJECTS) tooLarge();
  }
}

const setResp = (extra: Obj = {}): Obj => ({ accountId: ACCOUNT, oldState: "1", newState: nextState(), created: {}, updated: {}, destroyed: [], ...extra });

function genericGet(list: Obj[]) {
  return (a: Obj) => {
    const ids = a.ids as string[] | null | undefined;
    const found = ids ? ids.map((id) => list.find((x) => x.id === id)).filter(Boolean) as Obj[] : list;
    return { accountId: ACCOUNT, state: String(state.n), list: found.map((x) => pick(x, a.properties as string[] | null)), notFound: ids ? ids.filter((id) => !list.some((x) => x.id === id)) : [] };
  };
}
/** Thrown from an onCreate hook to refuse a create the way a real server would. */
class SetError extends Error {
  constructor(readonly type: string, readonly description: string, readonly properties?: string[]) { super(description); }
  toJSON(): Obj { return { type: this.type, description: this.description, ...(this.properties ? { properties: this.properties } : {}) }; }
}

function genericSet(list: Obj[], prefix: string, onCreate?: (o: Obj) => void) {
  return (a: Obj) => {
    const created: Obj = {};
    const updated: Obj = {};
    const destroyed: string[] = [];
    const notCreated: Obj = {};
    for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
      const id = `${prefix}${randomUUID().slice(0, 6)}`;
      const o = { ...(obj as Obj), id };
      try {
        onCreate?.(o);
      } catch (err) {
        if (!(err instanceof SetError)) throw err;
        notCreated[cid] = err.toJSON();
        continue;
      }
      list.push(o);
      created[cid] = { id };
    }
    for (const [id, patch] of Object.entries((a.update as Obj) ?? {})) {
      const o = list.find((x) => x.id === id);
      if (o) { applyPatch(o, patch as Obj); updated[id] = null; }
    }
    for (const id of (a.destroy as string[]) ?? []) {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) { list.splice(i, 1); destroyed.push(id); }
    }
    return setResp({ created, updated, destroyed, ...(Object.keys(notCreated).length ? { notCreated } : {}) });
  };
}

/* ---------- submissions ---------- */
/**
 * Held messages, the way Stalwart models them: `sendAt` is derived from the
 * envelope's FUTURERELEASE parameter rather than set by the client, and
 * `undoStatus` reports whether the message is still in the queue.
 */
const submissions: Obj[] = [];

function submissionView(sub: Obj): Obj {
  return { ...sub, undoStatus: undoStatusOf(sub, Date.now()) };
}

function matchSubmissionFilter(sub: Obj, f: Obj | undefined): boolean {
  if (!f) return true;
  if (f.undoStatus && undoStatusOf(sub, Date.now()) !== f.undoStatus) return false;
  if (Array.isArray(f.emailIds) && !(f.emailIds as string[]).includes(sub.emailId as string)) return false;
  if (Array.isArray(f.identityIds) && !(f.identityIds as string[]).includes(sub.identityId as string)) return false;
  return true;
}

const handlers: Record<string, Handler> = {
  // 0.16 exposes the account locale here, under a permission ordinary users
  // actually have (unlike x:Account below, which needs sysAccountGet).
  "x:AccountSettings/get": (a) => {
    const ids = (a.ids as string[] | null) ?? ["singleton"];
    const list = ids.filter((id) => id === "singleton").map((id) => ({ id, locale: MOCK_LOCALE, timeZone: null, description: null }));
    return { accountId: ACCOUNT, state: String(state.n), list: list.map((x) => pick(x, a.properties as string[] | null)), notFound: ids.filter((id) => id !== "singleton") };
  },
  // Stalwart's directory extension - the client reads the account locale from here.
  "x:Account/get": (a) => {
    const ids = (a.ids as string[] | null) ?? [ACCOUNT];
    const list = ids.filter((id) => id === ACCOUNT).map((id) => ({ id, name: USER, locale: MOCK_LOCALE, timeZone: null }));
    return { accountId: ACCOUNT, state: String(state.n), list, notFound: ids.filter((id) => id !== ACCOUNT) };
  },
  "Mailbox/get": genericGet(mailboxes),
  "Mailbox/set": (a) => { const r = genericSet(mailboxes, "m", (o) => Object.assign(o, { ...mb(o.id as string, o.name as string, null, (o.parentId as string) ?? null), ...o }))(a); recount(); return r; },
  "Mailbox/changes": () => ({ accountId: ACCOUNT, oldState: "1", newState: String(state.n), hasMoreChanges: false, created: [], updated: [], destroyed: [] }),
  "Email/query": (a) => {
    let list = emails.filter((e) => matchFilter(e, a.filter as Obj));
    list.sort((x, y) => String(y.receivedAt).localeCompare(String(x.receivedAt)));
    if (a.collapseThreads) {
      const seen = new Set<string>();
      list = list.filter((e) => { const t = e.threadId as string; if (seen.has(t)) return false; seen.add(t); return true; });
    }
    const pos = Number(a.position ?? 0);
    const limit = Number(a.limit ?? 50);
    return { accountId: ACCOUNT, queryState: String(state.n), canCalculateChanges: false, position: pos, ids: list.slice(pos, pos + limit).map((e) => e.id), total: list.length, limit };
  },
  "Email/get": (a) => genericGet(emails)(a),
  "Email/changes": () => ({ accountId: ACCOUNT, oldState: "1", newState: String(state.n), hasMoreChanges: false, created: [], updated: [], destroyed: [] }),
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
    return r;
  },
  "Email/import": (a) => { const created: Obj = {}; for (const [cid, spec] of Object.entries((a.emails as Obj) ?? {})) { const id = `e${counter++}`; emails.push({ id, blobId: (spec as Obj).blobId, threadId: `t${id}`, mailboxIds: (spec as Obj).mailboxIds, keywords: (spec as Obj).keywords ?? {}, size: 100, receivedAt: new Date().toISOString(), subject: "(imported message)", from: [{ name: null, email: "import@example" }], to: null, preview: "", hasAttachment: false, textBody: [], htmlBody: [], attachments: [], bodyValues: {} }); created[cid] = { id }; } recount(); return setResp({ created }); },
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
   * Push subscriptions. The JMAP half can be modelled; delivery cannot -- that
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
      // One per device: re-subscribing replaces rather than accumulates.
      const deviceId = String(o.deviceClientId ?? "");
      const clash = pushSubscriptions.findIndex((s) => s.deviceClientId === deviceId);
      if (clash >= 0) pushSubscriptions.splice(clash, 1);
      const id = `ps${randomUUID().slice(0, 6)}`;
      pushSubscriptions.push({ id, deviceClientId: deviceId, url: o.url, types: o.types ?? null, emailPush: o.emailPush ?? null, expires: null, keys, verified: false, code: `v${randomUUID().slice(0, 8)}` });
      created[cid] = { id, expires: null };
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
        notUpdated[id] = { type: "cannotUnsend", description: status === "canceled" ? "The message was already cancelled." : "The message has already been sent." };
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
  "VacationResponse/get": () => ({ accountId: ACCOUNT, state: "1", list: [vacation], notFound: [] }),
  "VacationResponse/set": (a) => { const p = ((a.update as Obj) ?? {}).singleton as Obj | undefined; if (p) vacation = { ...vacation, ...p }; return setResp({ updated: { singleton: null } }); },
  "Quota/get": () => ({ accountId: ACCOUNT, state: "1", list: [{ id: "q1", resourceType: "octets", used: 734003200, hardLimit: 2147483648, scope: "account", name: "Storage", types: ["Email"] }], notFound: [] }),
  "SieveScript/get": genericGet(sieveScripts),
  "SieveScript/set": (a) => { const r = genericSet(sieveScripts, "sv", (o) => Object.assign(o, { isActive: false, ...o }))(a); const act = (a.onSuccessActivateScript as string | undefined); if (act) { const id = act.startsWith("#") ? ((r.created as Obj)[act.slice(1)] as Obj)?.id : act; for (const s of sieveScripts) s.isActive = s.id === id; } if (a.onSuccessDeactivateScript) for (const s of sieveScripts) s.isActive = false; return r; },
  "SieveScript/validate": () => ({ accountId: ACCOUNT, error: null }),
  "Calendar/get": (a) => genericGet(calendarsFor(a.accountId))(a),
  "Calendar/set": genericSet(calendars, "c", (o) => Object.assign(o, { color: "#0f766e", isSubscribed: true, isVisible: true, isDefault: false, includeInAvailability: "all", timeZone: null, shareWith: null, myRights: rightsCal(), description: null, sortOrder: 0, ...o })),
  "CalendarEvent/query": (a) => { const list = eventsFor(a.accountId); return { accountId: a.accountId ?? ACCOUNT, queryState: "1", canCalculateChanges: false, position: 0, ids: list.filter((e) => !(a.filter as Obj)?.uid || e.uid === (a.filter as Obj).uid).map((e) => e.id), total: list.length }; },
  "CalendarEvent/get": (a) => genericGet(eventsFor(a.accountId))(a),
  // Stalwart 0.16 rejects the RFC 8984 array outright and silently discards
  // participants addressed the RFC 8984 way. The mock did neither, which is how
  // #26 and #30 reached a live server unnoticed — so it now does both.
  "CalendarEvent/set": genericSet(events, "ev", (o) => {
    if (o.recurrenceRules) throw new SetError("invalidProperties", "Invalid property.", ["recurrenceRules"]);
    const parts = o.participants as Record<string, Obj> | undefined;
    if (parts && Object.values(parts).some((p) => !p.calendarAddress)) delete o.participants;
    if (o.replyTo && !o.organizerCalendarAddress) delete o.replyTo;
    return Object.assign(o, { uid: o.uid ?? randomUUID() });
  }),
  "CalendarEvent/parse": (a) => { const parsed: Obj = {}; for (const b of a.blobIds as string[]) { const blob = blobs.get(b); if (!blob) continue; const t = blob.data.toString(); const g = (k: string) => new RegExp(`^${k}[^:]*:(.*)$`, "m").exec(t)?.[1]?.trim(); const ds = g("DTSTART") ?? "20260101T000000Z"; const de = g("DTEND") ?? ds; const toLocal = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00`; const start = new Date(`${toLocal(ds)}Z`); const end = new Date(`${toLocal(de)}Z`); parsed[b] = { "@type": "Event", uid: g("UID"), title: g("SUMMARY"), start: toLocal(ds), timeZone: "Etc/UTC", duration: `PT${Math.round((end.getTime() - start.getTime()) / 60000)}M`, method: g("METHOD"), locations: g("LOCATION") ? { l: { name: g("LOCATION") } } : undefined, participants: { org: { name: "Ada Lovelace", calendarAddress: "mailto:ada@example.org", roles: { owner: true } }, me: { name: "Demo User", calendarAddress: `mailto:${USER}`, roles: { attendee: true, required: true }, participationStatus: "needs-action" } } }; } return { accountId: ACCOUNT, parsed, notParsable: [] }; },
  "ParticipantIdentity/get": genericGet(participantIdentities),
  "Principal/query": () => ({ accountId: ACCOUNT, queryState: "1", canCalculateChanges: false, position: 0, ids: principals.map((p) => p.id) }),
  "Principal/get": genericGet(principals),
  "Principal/getAvailability": (a) => ({ accountId: ACCOUNT, list: [{ utcStart: String(a.utcStart).slice(0, 11) + "13:00:00Z", utcEnd: String(a.utcStart).slice(0, 11) + "14:30:00Z", busyStatus: "confirmed", event: null }] }),
  "AddressBook/get": (a) => genericGet(booksFor(a.accountId))(a),
  "AddressBook/set": genericSet(addressBooks, "ab", (o) => Object.assign(o, { description: null, sortOrder: 0, isDefault: false, isSubscribed: true, shareWith: null, myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true }, ...o })),
  "ContactCard/query": (a) => { const list = a.accountId === SHARED_ACCOUNT ? sharedCards : cards; return { accountId: a.accountId ?? ACCOUNT, queryState: "1", canCalculateChanges: false, position: 0, ids: list.map((c) => c.id), total: list.length }; },
  "ContactCard/get": (a) => genericGet(a.accountId === SHARED_ACCOUNT ? sharedCards : cards)(a),
  "ContactCard/set": genericSet(cards, "cc"),
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

/* ---------- http ---------- */
function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="mock"' });
  res.end(JSON.stringify({ type: "about:blank", status: 401, title: "Unauthorized" }));
}
function checkOtp(code: string | undefined): boolean {
  if (!account.otpUrl) return true;
  const params = parseOtpauthUrl(account.otpUrl);
  return Boolean(code && params && verifyTotp(params, code));
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
  // App passwords are recognised by shape and skip the second factor, which is
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

const sseClients = new Set<ServerResponse>();
function broadcast(types: string[]) {
  const payload = `event: state\ndata: ${JSON.stringify({ "@type": "StateChange", changed: { [ACCOUNT]: Object.fromEntries(types.map((t) => [t, String(state.n)])) } })}\n\n`;
  for (const c of sseClients) c.write(payload);
}

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
    return res.end(JSON.stringify({ permissions: ["jmapEmailGet", "sysAccountSettingsGet"], edition: "oss", locale: MOCK_LOCALE }));
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
  if (url.pathname.startsWith("/jmap/eventsource")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`event: ping\ndata: {}\n\n`);
    sseClients.add(res);
    const t = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 25000);
    req.on("close", () => { clearInterval(t); sseClients.delete(res); });
    // Simulate a new message every 90s
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
