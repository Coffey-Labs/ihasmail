import { randomUUID } from "node:crypto";
import { signedMessage, type SIGNED_MESSAGES } from "./signedMessages.js";
import { Obj, SHARED_ACCOUNT, USER, account } from "./config.js";

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
export const pushSubscriptions: Obj[] = [];

export const mailboxes: Obj[] = [
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
export function mb(id: string, name: string, role: string | null, parentId: string | null = null): Obj {
  return { id, name, parentId, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true } };
}

export const blobs = new Map<string, { type: string; data: Buffer }>();
export function putBlob(data: Buffer | string, type: string): string {
  const id = `b${randomUUID().slice(0, 8)}`;
  blobs.set(id, { type, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  return id;
}

export const people = [
  ["Ada Lovelace", "ada@example.org"], ["Grace Hopper", "grace@example.org"], ["Linus Torvalds", "linus@kernel.example"],
  ["Margaret Hamilton", "margaret@nasa.example"], ["Alan Turing", "alan@bletchley.example"], ["GitHub", "noreply@github.example"],
  ["Stalwart Labs", "hello@stalw.art"], ["Weekly Digest", "digest@newsletter.example"], ["Finance Team", "finance@example.org"],
];
export const subjects = [
  "Re: Q3 planning document", "Your invoice #4821 is ready", "Welcome to Stalwart!", "Lunch on Thursday?", "[PR] Fix push reconnect backoff",
  "Weekly digest: 12 new articles", "Photos from the hike", "Deployment window this weekend", "Contract draft v3 attached", "Can you review my slides?",
  "Reminder: dentist appointment", "Flight confirmation – BOS → SFO", "Team offsite agenda", "Re: Re: budget approval", "Security notice: new sign-in",
];
export const emails: Obj[] = [];
export const seq = { counter: 1 };
/**
 * A real TNEF blob, built to the format description, so the winmail.dat
 * decoder has something to open that is not a hand-made fixture in its own
 * test file. Two files inside, one of them carrying a long name in the MAPI
 * stream behind an 8.3 title -- which is the case the decoder exists for.
 */
export function winmailDat(): Buffer {
  const u16 = (v: number) => Buffer.from([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) => Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const sum = (b: Buffer) => { let n = 0; for (const x of b) n = (n + x) & 0xffff; return n; };
  const attr = (level: number, id: number, data: Buffer) => Buffer.concat([Buffer.from([level]), u32(id), u32(data.length), data, u16(sum(data))]);
  const asciiProp = (id: number, value: string) => {
    const bytes = Buffer.concat([Buffer.from(value, "latin1"), Buffer.from([0])]);
    const pad = Buffer.alloc((4 - (bytes.length % 4)) % 4);
    return Buffer.concat([u32(((id & 0xffff) << 16) | 0x001e), u32(bytes.length), bytes, pad]);
  };
  const mapi = (props: Buffer[]) => Buffer.concat([u32(props.length), ...props]);

  const renddata = Buffer.alloc(14);
  const title = (n: string) => Buffer.concat([Buffer.from(n, "latin1"), Buffer.from([0])]);
  const notes = Buffer.from("Numbers pulled from the mock, not from anywhere real.\n", "latin1");
  const csv = Buffer.from("quarter,revenue\nQ1,120\nQ2,145\n", "latin1");

  return Buffer.concat([
    u32(0x223e9f78), u16(0x1234),
    attr(1, 0x00089006, u32(0x00010000)), // attTnefVersion
    attr(2, 0x00069002, renddata),
    attr(2, 0x00018010, title("QUARTE~1.CSV")),
    attr(2, 0x00069005, mapi([asciiProp(0x3707, "Quarterly Revenue Final.csv"), asciiProp(0x370e, "text/csv")])),
    attr(2, 0x0006800f, csv),
    attr(2, 0x00069002, renddata),
    attr(2, 0x00018010, title("notes.txt")),
    attr(2, 0x0006800f, notes),
  ]);
}

/**
 * A really signed message, served as the raw blob a client verifies against.
 *
 * The signature is over exact bytes, so this deliberately does not go through
 * addEmail: that builds a message out of parts and would hand back a body it
 * had assembled rather than the one that was signed. Here the blob *is* the
 * fixture, byte for byte, and the JMAP metadata is arranged around it.
 *
 * `bodyStructure` says multipart/signed because that is what the client checks
 * before deciding to download anything -- a mock that omitted it would leave
 * the whole path unreachable while every stored byte was still correct.
 */
export function addSignedEmail(o: { which: keyof typeof SIGNED_MESSAGES; from: [string, string]; subject: string; daysAgo: number; mailbox: string; unread?: boolean }) {
  const id = `e${seq.counter++}`;
  const raw = signedMessage(o.which);
  const received = new Date(Date.now() - o.daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const body = "The Analytical Engine has no pretensions whatever to originate anything.";
  const textBlob = putBlob(body, "text/plain");
  const e: Obj = {
    id,
    blobId: putBlob(raw, "message/rfc822"),
    threadId: `t${id}`,
    mailboxIds: { [o.mailbox]: true },
    keywords: o.unread ? {} : { $seen: true },
    size: raw.length,
    receivedAt: received,
    sentAt: received,
    messageId: [`${id}@mock`],
    inReplyTo: null,
    references: null,
    from: [{ name: o.from[0], email: o.from[1] }],
    to: [{ name: "Demo User", email: USER }],
    cc: null, bcc: null, replyTo: null, sender: null,
    subject: o.subject,
    hasAttachment: false,
    preview: body.slice(0, 120),
    textBody: [{ partId: "1", blobId: textBlob, size: body.length, name: null, type: "text/plain", charset: "utf-8", disposition: null, cid: null }],
    htmlBody: [],
    attachments: [],
    bodyValues: { "1": { value: body, isEncodingProblem: false, isTruncated: false } },
    bodyStructure: {
      partId: null, blobId: null, size: raw.length, type: "multipart/signed", name: null, charset: null, disposition: null, cid: null,
      subParts: [
        { partId: "1", blobId: textBlob, size: body.length, type: "text/plain", name: null, charset: "utf-8", disposition: null, cid: null },
        { partId: "2", blobId: null, size: 0, type: "application/x-pkcs7-signature", name: "smime.p7s", charset: null, disposition: "attachment", cid: null },
      ],
    },
  };
  emails.push(e);
  return e;
}

/*
 * A marketing template of the shape #290 was reported against.
 *
 * Nothing in it is unusual — an outer 600px wrapper on `bgcolor="#ffffff"`, a
 * `<style>` block, a colored call to action, a gray footer — and that is the
 * point. Every one of those is enough to make `htmlDeclaresColors` true, so a
 * mock without one could not show what "apply the theme to messages too" does
 * to the mail people actually receive: nothing at all.
 */
export const STYLED_MARKETING_HTML = `<html><head><style>
  a { color:#1155CC; text-decoration:underline }
  .h { font-size:20px; color:#111111 }
</style></head><body style="margin:0;background-color:#f4f4f4">
<table width="100%" bgcolor="#f4f4f4" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table width="600" bgcolor="#ffffff" cellpadding="0" cellspacing="0" style="background-color:#ffffff">
    <tr><td style="padding:24px"><p class="h">Your order is on its way</p>
      <p style="color:#333333">Thanks for shopping with us. Your parcel left the warehouse this morning.</p>
      <table cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="#1155CC" style="border-radius:4px;padding:12px 20px">
          <a href="https://example.com/track" style="color:#FFFFFF;text-decoration:none">Track your parcel</a>
        </td></tr></table>
      <p style="color:#666666;font-size:12px">Order #4471 &middot; placed 2 September</p>
    </td></tr>
    <tr><td bgcolor="#222222" style="padding:16px;color:#dddddd;font-size:12px">
      You are receiving this because you bought something. <a href="https://example.com/x" style="color:#88bbff">Unsubscribe</a>
    </td></tr>
  </table>
</td></tr></table></body></html>`;

export function addEmail(o: { from: [string, string]; to?: string; subject: string; daysAgo: number; mailbox: string; threadId?: string; unread?: boolean; flagged?: boolean; html?: boolean; styled?: boolean; attach?: boolean; winmail?: boolean; inReplyTo?: string }) {
  const id = `e${seq.counter++}`;
  const received = new Date(Date.now() - o.daysAgo * 86400_000 - Math.random() * 3600_000 * 5).toISOString().replace(/\.\d{3}Z$/, "Z");
  const text = `Hi,\n\nThis is a sample message about "${o.subject}". It was generated by the ihasmail mock server so you can try the interface without a real mailbox.\n\nSome highlights:\n- Keyboard shortcuts (press ? )\n- Conversation view\n- Drag & drop to folders\n\nCheers,\n${o.from[0]}\n\n> On Monday, someone wrote:\n> This is the quoted part of an earlier message.\n> It should be collapsed by default.`;
  const html = `<html><body style="font-family:Arial"><p>Hi,</p><p>This is a <b>sample HTML message</b> about “${o.subject}”. It was generated by the ihasmail mock server.</p><ul><li>Keyboard shortcuts (press ?)</li><li>Conversation view</li><li><a href="https://stalw.art">Drag &amp; drop</a> to folders</li></ul><p><img src="https://example.com/tracker.gif" width="1" height="1" alt=""> <img src="cid:logo@mock" width="120" alt="logo"></p><p>Cheers,<br>${o.from[0]}</p><div class="gmail_quote">On Monday, someone wrote:<blockquote>This is the quoted part of an earlier message. It should be collapsed by default.</blockquote></div></body></html>`;
  const textBlob = putBlob(text, "text/plain");
  const htmlBlob = putBlob(o.styled ? STYLED_MARKETING_HTML : html, "text/html");
  const attachments: Obj[] = [];
  if (o.attach) {
    attachments.push({ partId: "3", blobId: putBlob("%PDF-1.4 mock", "application/pdf"), size: 48213, name: "contract-v3.pdf", type: "application/pdf", charset: null, disposition: "attachment", cid: null });
    attachments.push({ partId: "4", blobId: putBlob(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), "image/png"), size: 68, name: "pixel.png", type: "image/png", charset: null, disposition: "attachment", cid: null });
  }
  if (o.winmail) {
    const dat = winmailDat();
    attachments.push({ partId: "6", blobId: putBlob(dat, "application/ms-tnef"), size: dat.length, name: "winmail.dat", type: "application/ms-tnef", charset: null, disposition: "attachment", cid: null });
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
    htmlBody: o.html ? [{ partId: "2", blobId: htmlBlob, size: (o.styled ? STYLED_MARKETING_HTML : html).length, name: null, type: "text/html", charset: "utf-8", disposition: null, cid: null }] : [],
    attachments,
    bodyValues: { "1": { value: text, isEncodingProblem: false, isTruncated: false }, ...(o.html ? { "2": { value: o.styled ? STYLED_MARKETING_HTML : html, isEncodingProblem: false, isTruncated: false } } : {}) },
    bodyStructure: { partId: null, blobId: null, size: 0, type: "multipart/mixed", name: null, charset: null, disposition: null, cid: null, subParts: [{ partId: "1", blobId: textBlob, size: text.length, type: "text/plain", name: null, charset: "utf-8", disposition: null, cid: null }, ...(o.html ? [{ partId: "2", blobId: htmlBlob, size: (o.styled ? STYLED_MARKETING_HTML : html).length, type: "text/html", name: null, charset: "utf-8", disposition: null, cid: null }] : []), ...attachments] },
    "header:List-Unsubscribe:asText": o.from[1].includes("newsletter") ? "<mailto:unsub@newsletter.example?subject=unsubscribe>, <https://newsletter.example/unsub>" : null,
    "header:X-Priority:asText": o.subject.startsWith("Security") ? "1 (Highest)" : null,
    // Stalwart's spam filter writes the SpamAssassin-shaped set at delivery, so
    // delivered mail carries it and mail this account wrote does not.
    "header:X-Spam-Status:asText":
      o.mailbox === "junk"
        ? "Yes, score=14.2 required=5.0 tests=[BAYES_99=3.5, URIBL_BLOCKED=2.7, HTML_IMAGE_ONLY=1.4, SUBJ_ALL_CAPS=1.2, FROM_FREEMAIL=0.4] autolearn=no"
        : o.mailbox === "inbox"
          ? "No, score=-1.8 required=5.0 tests=[BAYES_00=-1.9, DKIM_VALID=-0.7, SPF_PASS=-0.1, HTML_MESSAGE=0.9]"
          : null,
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
addEmail({ from: ["Shop Updates", "orders@example.com"], subject: "Your order is on its way", daysAgo: 0.3, mailbox: "inbox", html: true, styled: true });
addEmail({ from: ["Demo User", USER], to: "ada@example.org", subject: "Draft: ideas for the retreat", daysAgo: 0.1, mailbox: "drafts", html: true }).keywords = { $draft: true, $seen: true };

/*
 * Three signed messages, so every branch of the signature banner can be seen
 * without staging a certificate authority. Read "A note" first: that pins Ada's
 * certificate, after which the other two have something to disagree with.
 */
addSignedEmail({ which: "good", from: ["Ada Lovelace", "ada@example.com"], subject: "A note", daysAgo: 0.2, mailbox: "inbox", unread: true });
addSignedEmail({ which: "tampered", from: ["Ada Lovelace", "ada@example.com"], subject: "A note (altered in transit)", daysAgo: 0.25, mailbox: "inbox", unread: true });
addSignedEmail({ which: "imposter", from: ["Ada Lovelace", "ada@example.com"], subject: "A note (signed by somebody else)", daysAgo: 0.3, mailbox: "inbox", unread: true });
addEmail({ from: ["Spammy", "win@lottery.example"], subject: "You have WON!!!", daysAgo: 2, mailbox: "junk", unread: true });
addEmail({ from: ["Outlook User", "sales@partner.example"], subject: "Q3 figures (sent from Outlook)", daysAgo: 1, mailbox: "inbox", unread: true, winmail: true });
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

export const identities: Obj[] = [
  { id: "i1", name: "Demo User", email: USER, replyTo: null, bcc: null, textSignature: "-- \nDemo User\nihasmail", htmlSignature: "<div>-- <br><b>Demo User</b><br>ihasmail</div>", mayDelete: false },
  { id: "i2", name: "Demo (alias)", email: "alias@example.com", replyTo: null, bcc: null, textSignature: "", htmlSignature: "", mayDelete: true },
];
export const vacationBox: { current: Obj } = { current: { id: "singleton", isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null } };
export const sieveScripts: Obj[] = [];
/* A calendar in the shared account, so "Shared with me" and a colleague's
   events appearing in the grid can be exercised. Read-only, as a share is. */
export const sharedCalendars: Obj[] = [{ id: "c9", name: "Grace — Work", description: null, color: "#c084fc", sortOrder: 0, isSubscribed: false, isVisible: true, isDefault: true, includeInAvailability: "all", defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: "UTC", shareWith: {}, myRights: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false } }];
export const sharedEvents: Obj[] = [];
export const eventsFor = (accountId: unknown): Obj[] => (accountId === SHARED_ACCOUNT ? sharedEvents : events);
export const calendarsFor = (accountId: unknown): Obj[] => (accountId === SHARED_ACCOUNT ? sharedCalendars : calendars);
export const calendars: Obj[] = [{ id: "c1", name: "Personal", description: null, color: "#0f766e", sortOrder: 0, isSubscribed: true, isVisible: true, isDefault: true, includeInAvailability: "all", defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: "UTC", shareWith: null, myRights: rightsCal() }, { id: "c2", name: "Work", description: null, color: "#2563eb", sortOrder: 1, isSubscribed: true, isVisible: true, isDefault: false, includeInAvailability: "all", defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: "UTC", shareWith: null, myRights: rightsCal() }];
export function rightsCal() { return { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true }; }
export const events: Obj[] = [];
{
  const now = new Date();
  const d = (dayOff: number, h: number) => { const x = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOff, h, 0, 0); return x; };
  const local = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}T${String(x.getHours()).padStart(2, "0")}:00:00`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  events.push({ id: "ev1", calendarIds: { c1: true }, "@type": "Event", uid: "ev1", title: "Standup", start: local(d(0, 9)), timeZone: tz, duration: "PT30M", recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ day: "mo" }, { day: "tu" }, { day: "we" }, { day: "th" }, { day: "fr" }] }, showWithoutTime: false, status: "confirmed", freeBusyStatus: "busy", privacy: "public" });
  events.push({ id: "ev2", calendarIds: { c2: true }, "@type": "Event", uid: "ev2", title: "Design review", start: local(d(1, 14)), timeZone: tz, duration: "PT1H30M", showWithoutTime: false, locations: { l: { "@type": "Location", name: "Room 2" } }, participants: { me: { "@type": "Participant", name: "Demo User", calendarAddress: `mailto:${USER}`, roles: { owner: true, attendee: true }, participationStatus: "accepted" }, p2: { "@type": "Participant", name: "Ada Lovelace", calendarAddress: "mailto:ada@example.org", roles: { attendee: true, required: true }, participationStatus: "needs-action", expectReply: true } }, organizerCalendarAddress: `mailto:${USER}` });
  events.push({ id: "ev3", calendarIds: { c1: true }, "@type": "Event", uid: "ev3", title: "Conference", start: local(d(3, 0)).slice(0, 10) + "T00:00:00", duration: "P2D", showWithoutTime: true, timeZone: null });
  /*
   * One event in a zone that is not the reader's, because every other fixture
   * here uses the machine's own and so cannot tell a correct conversion from
   * no conversion at all. Dragging this one is what proves a move keeps the
   * time the event says it happens at.
   */
  events.push({ id: "ev9", calendarIds: { c1: true }, "@type": "Event", uid: "ev9", title: "Tokyo sync", start: local(d(2, 15)), timeZone: "Asia/Tokyo", duration: "PT1H", showWithoutTime: false, color: "#7c3aed" });
  events.push({ id: "ev4", calendarIds: { c1: true }, "@type": "Event", uid: "ev4", title: "Lunch with Grace", start: local(d(2, 12)), timeZone: tz, duration: "PT1H", showWithoutTime: false, color: "#db2777" });
  // Two in the shared account, so a colleague's calendar has something in it.
  sharedEvents.push({ id: "sv1", calendarIds: { c9: true }, "@type": "Event", uid: "sv1", title: "Grace: release planning", start: local(d(1, 10)), timeZone: tz, duration: "PT1H", showWithoutTime: false, status: "confirmed", freeBusyStatus: "busy", privacy: "public" });
  sharedEvents.push({ id: "sv2", calendarIds: { c9: true }, "@type": "Event", uid: "sv2", title: "Grace: on leave", start: local(d(4, 0)).slice(0, 10) + "T00:00:00", duration: "P1D", showWithoutTime: true, timeZone: null });
}
export const participantIdentities: Obj[] = [{ id: "pi1", name: "Demo User", calendarAddress: `mailto:${USER}`, sendTo: { imip: `mailto:${USER}` }, isDefault: true }];
export const abRights = (write = true) => ({ mayRead: true, mayWrite: write, mayShare: write, mayDelete: write });
export const addressBooks: Obj[] = [{ id: "ab1", name: "Personal", description: null, sortOrder: 0, isDefault: true, isSubscribed: true, shareWith: {}, myRights: abRights() }];
/* A book in the shared account, so "Shared with me" and addressing a message
   from somebody else's contacts can be exercised at all. Read-only, which is
   what a share usually is. */
export const sharedAddressBooks: Obj[] = [{ id: "ab9", name: "Team contacts", description: null, sortOrder: 0, isDefault: true, isSubscribed: false, shareWith: {}, myRights: abRights(false) }];
export const sharedCards: Obj[] = [
  { id: "sc1", addressBookIds: { ab9: true }, name: { full: "Katherine Johnson" }, emails: { e1: { address: "katherine@example.org", contexts: {} } }, phones: {}, organizations: {}, nicknames: {}, addresses: {}, notes: {}, updated: new Date().toISOString() },
  { id: "sc2", addressBookIds: { ab9: true }, name: { full: "Dorothy Vaughan" }, emails: { e1: { address: "dorothy@example.org", contexts: {} } }, phones: {}, organizations: {}, nicknames: {}, addresses: {}, notes: {}, updated: new Date().toISOString() },
];
/**
 * One sort property, as Email/query defines them. `hasKeyword` sorts a
 * boolean, and false comes before true -- which is what makes "unread first"
 * an *ascending* sort on $seen.
 */
export function compareBy(x: Obj, y: Obj, property: string, keyword?: string): number {
  const addr = (v: unknown) => String(((v as Obj[] | undefined)?.[0] as Obj | undefined)?.email ?? "");
  switch (property) {
    case "receivedAt": return String(x.receivedAt).localeCompare(String(y.receivedAt));
    case "sentAt": return String(x.sentAt ?? x.receivedAt).localeCompare(String(y.sentAt ?? y.receivedAt));
    case "size": return Number(x.size ?? 0) - Number(y.size ?? 0);
    case "subject": return String(x.subject ?? "").localeCompare(String(y.subject ?? ""));
    case "from": return addr(x.from).localeCompare(addr(y.from));
    case "to": return addr(x.to).localeCompare(addr(y.to));
    case "hasKeyword": {
      const has = (e: Obj) => (keyword && (e.keywords as Obj | undefined)?.[keyword] ? 1 : 0);
      return has(x) - has(y);
    }
    default: return 0;
  }
}

/** A server that does not implement sorting on keywords, so the fallback can be developed against. */
export const NO_KEYWORD_SORT = process.env.MOCK_NO_KEYWORD_SORT === "1";

/** The floor Stalwart puts under a requested EventSource ping interval. */
export const PING_FLOOR_SECONDS = 30;

/*
 * An account that may not send calendar invitations.
 *
 * 0.16.21 rejects a `CalendarEvent/set` that asks for scheduling messages when
 * the account lacks the `calendarSchedulingSend` permission, rather than
 * accepting the write and quietly sending nothing. **Confirmed live on 0.16.21
 * (2026-09-06)** against an account holding a role with that permission
 * disabled: `sendSchedulingMessages: true` came back `notCreated` with
 * `forbidden` and the text below, while the identical request with the flag
 * false was created normally. Set MOCK_NO_SCHEDULING_SEND=1 to develop against
 * that account.
 */
export const NO_SCHEDULING_SEND = process.env.MOCK_NO_SCHEDULING_SEND === "1";
export const SCHEDULING_FORBIDDEN = "This account is not allowed to send calendar scheduling messages.";

export const booksFor = (accountId: unknown): Obj[] => (accountId === SHARED_ACCOUNT ? sharedAddressBooks : addressBooks);
/** One per contact, by index; a gap means that card has no birthday. */
export const BIRTHDAYS: Array<{ year?: number; month: number; day: number } | null> = [
  { year: 1815, month: 12, day: 10 },
  { month: 6, day: 9 }, // no year: the common case
  { year: 1912, month: 6, day: 23 },
  null,
  { year: 2000, month: 2, day: 29 }, // lands on the 28th in a non-leap year
  { year: 1918, month: 8, day: 26 },
];

export const cards: Obj[] = people.slice(0, 6).map((p, i) => {
  const [given, surname] = p[0]!.split(" ");
  return { id: `cc${i}`, addressBookIds: { ab1: true }, "@type": "Card", version: "1.0", uid: `uid-cc${i}`, kind: "individual", name: { components: [{ kind: "given", value: given }, { kind: "surname", value: surname ?? "" }], isOrdered: true }, emails: { e1: { address: p[1], contexts: { work: true } } }, phones: i % 2 ? { p1: { number: `+1 555 010${i}`, features: { mobile: true } } } : undefined, organizations: i % 3 ? { o1: { name: "Example Corp" } } : undefined,
    /*
     * Birthdays on most but not all of them, and one with no year, because a
     * card that records only a day and month is the common case rather than
     * the exceptional one.
     */
    anniversaries: BIRTHDAYS[i] ? { a1: { "@type": "Anniversary", kind: "birth", date: { "@type": "PartialDate", ...BIRTHDAYS[i] } } } : undefined };
});
export const principals: Obj[] = people.slice(0, 5).map((p, i) => ({ id: `pr${i}`, type: "individual", name: p[0], description: null, email: p[1], timeZone: "UTC" }));
export const fileNodes: Obj[] = [
  { id: "f1", parentId: null, nodeType: "directory", blobId: null, size: null, name: "Documents", type: null, created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {}, role: "documents" },
  { id: "f2", parentId: "f1", nodeType: "file", blobId: putBlob("hello world", "text/plain"), size: 11, name: "notes.txt", type: "text/plain", created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {} },
  { id: "f3", parentId: null, nodeType: "file", blobId: putBlob("%PDF-1.4 mock", "application/pdf"), size: 14, name: "report.pdf", type: "application/pdf", created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {} },
];

/* What the shared account holds. Its own nodes, so opening the share in Files
   shows something different from the reader's own folders rather than the same
   list under another name. */
export const sharedFileNodes: Obj[] = [
  { id: "s1", parentId: null, nodeType: "directory", blobId: null, size: null, name: "Team plans", type: null, created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {} },
  { id: "s2", parentId: "s1", nodeType: "file", blobId: putBlob("shared notes", "text/plain"), size: 12, name: "roadmap.txt", type: "text/plain", created: new Date().toISOString(), modified: new Date().toISOString(), myRights: fr(), shareWith: {} },
];
/** The node list an account owns. */
export const nodesFor = (accountId: unknown): Obj[] => (accountId === SHARED_ACCOUNT ? sharedFileNodes : fileNodes);

export function fr() {
  return { mayRead: true, mayAddChildren: true, mayRename: true, mayDelete: true, mayModifyContent: true, mayShare: true };
}

export function recount() {
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

