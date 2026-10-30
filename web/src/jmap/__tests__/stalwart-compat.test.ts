// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { CAP, STALWART_CAP, usingFor } from "@/jmap/client";
import { BODY_PROPS, FULL_PROPS, LIST_PROPS, MAILBOX_PROPS } from "@/store/mail/props";
import { CALENDAR_PROPS, EVENT_PROPS, SERIES_PROPS } from "@/store/calendar";
import { ADDRESS_BOOK_PROPS } from "@/store/contacts";
import { argsToServer, resultFromServer, shapeFromProbe, shapeProbe } from "@/jmap/fileNodeShape";
import { APP_FOLDER, folderProps, isAppFolder } from "@/lib/appFolder";
import { directoryCreate, fileCreate, fileNodeProps } from "@/lib/filenode";
import type { FileNode } from "@/jmap/types";

/**
 * Runs against a real, empty Stalwart, not a mock. Skipped unless
 * STALWART_COMPAT_URL is set; CI sets it once per supported Stalwart version,
 * with the server's recovery administrator in STALWART_COMPAT_ADMIN
 * (user:password). Start the server with a config.json naming its data store:
 * without one it stays in bootstrap mode, which only a restart ends.
 *
 * The property lists and the `using` of each call come from the app itself,
 * so a server that tightens its parsing fails here rather than in a reader's
 * inbox. Stalwart 1.0 refusing `header:List-Unsubscribe:asText`, which 0.16
 * had answered, left every message unopenable, and a probe with its own copy
 * of the requests did not notice.
 */

const BASE = process.env.STALWART_COMPAT_URL?.replace(/\/$/, "");
const ADMIN = process.env.STALWART_COMPAT_ADMIN ?? "";
const PASSWORD = "Compat-Pass-1234!";
const DOMAIN = "compat.test";

type Call = [string, Record<string, unknown>, string];
type Response = [string, Record<string, unknown>, string];

function auth(cred: string): string {
  return "Basic " + Buffer.from(cred).toString("base64");
}

async function jmap(cred: string, calls: Call[], extra: string[] = []): Promise<Response[]> {
  const using = new Set<string>([CAP.core, ...extra]);
  for (const [method] of calls) for (const u of usingFor(method)) using.add(u);
  const res = await fetch(`${BASE}/jmap/`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth(cred) },
    body: JSON.stringify({ using: [...using], methodCalls: calls }),
  });
  expect(res.status, `${calls.map((c) => c[0]).join(", ")}: HTTP ${res.status}`).toBe(200);
  return ((await res.json()) as { methodResponses: Response[] }).methodResponses;
}

/**
 * Refusals that are the server's policy rather than a mismatch, and which the
 * app already handles: directory queries are off by default, and metrics need
 * an Enterprise licence. Any other error, `unknownMethod` and
 * `invalidArguments` above all, fails.
 */
const POLICY_REFUSALS: Record<string, string> = {
  "Principal/query": "forbidden",
  "x:Metric/query": "forbidden",
};

/**
 * Each call in a request of its own, as the app never batches this many: the
 * server caps the calls in one request. Every answer must be the method asked
 * for, or a refusal listed above.
 */
async function expectAnswered(cred: string, calls: Call[], extra: string[] = []): Promise<void> {
  for (const call of calls) {
    const [method] = call;
    const r = (await jmap(cred, [call], extra))[0]!;
    if (r[0] === "error" && r[1].type === POLICY_REFUSALS[method]) continue;
    expect(r[0], `${method}: ${JSON.stringify(r[1]).slice(0, 300)}`).toBe(method);
  }
}

async function accountId(cred: string): Promise<string> {
  const res = await fetch(`${BASE}/jmap/session`, { headers: { authorization: auth(cred) } });
  expect(res.status).toBe(200);
  const session = (await res.json()) as { primaryAccounts: Record<string, string> };
  return session.primaryAccounts[CAP.mail]!;
}

const alice = `alice@${DOMAIN}:${PASSWORD}`;
const bob = `bob@${DOMAIN}:${PASSWORD}`;

const LIST_MESSAGE = [
  `From: news@list.example`,
  `To: alice@${DOMAIN}`,
  `Subject: Compat newsletter`,
  `Message-ID: <compat-1@list.example>`,
  `List-Id: Compat <compat.list.example>`,
  `List-Unsubscribe: <mailto:unsub@list.example?subject=unsubscribe>,`,
  ` <https://list.example/u/1>`,
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
  `MIME-Version: 1.0`,
  `Content-Type: multipart/mixed; boundary="b1"`,
  ``,
  `--b1`,
  `Content-Type: text/plain; charset=utf-8`,
  ``,
  `Hello from the compatibility test.`,
  `--b1`,
  `Content-Type: application/pdf; name="report.pdf"`,
  `Content-Transfer-Encoding: base64`,
  `Content-Disposition: attachment; filename="report.pdf"`,
  ``,
  `JVBERi0xLjQKJSBjb21wYXQK`,
  `--b1--`,
  ``,
].join("\r\n");

describe.skipIf(!BASE)("a real Stalwart server", () => {
  let aid = "";

  beforeAll(async () => {
    // Found rather than assumed, so a rerun against the same server works.
    const domains = await jmap(ADMIN, [
      ["x:Domain/query", {}, "q"],
      ["x:Domain/get", { "#ids": { resultOf: "q", name: "x:Domain/query", path: "/ids" }, properties: ["name"] }, "g"],
    ]);
    let domainId = (domains[1]![1].list as { id: string; name: string }[]).find((d) => d.name === DOMAIN)?.id;
    if (!domainId) {
      // What the administration pages do to add a domain.
      const created = await jmap(ADMIN, [["x:Domain/set", { create: { d: { name: DOMAIN } } }, "d"]]);
      domainId = (created[0]![1].created as Record<string, { id: string }>).d!.id;
    }
    const user = (name: string) => ({
      "@type": "User",
      name,
      domainId,
      credentials: { "0": { "@type": "Password", secret: PASSWORD } },
      roles: { "@type": "User" },
      permissions: { "@type": "Inherit" },
      quotas: {},
      aliases: {},
      memberGroupIds: {},
      encryptionAtRest: { "@type": "Disabled" },
    });
    const accounts = await jmap(ADMIN, [["x:Account/set", { create: { a: user("alice"), b: user("bob") } }, "a"]]);
    expect(Object.keys(accounts[0]![1].created ?? {}).sort(), JSON.stringify(accounts[0]![1])).toEqual(["a", "b"]);
    aid = await accountId(alice);
  }, 60_000);

  it("opens a message with every property the reader asks for", async () => {
    const inbox = (await jmap(alice, [["Mailbox/get", { accountId: aid, properties: MAILBOX_PROPS }, "m"]]))[0]![1].list as { id: string; role: string | null }[];
    const inboxId = inbox.find((m) => m.role === "inbox")!.id;
    const imported = await jmap(
      alice,
      [
        ["Blob/upload", { accountId: aid, create: { b: { data: [{ "data:asText": LIST_MESSAGE }] } } }, "u"],
        ["Email/import", { accountId: aid, emails: { e: { blobId: "#b", mailboxIds: { [inboxId]: true }, keywords: {} } } }, "i"],
      ],
    );
    const emailId = (imported[1]![1].created as Record<string, { id: string }>).e!.id;

    const calls: Call[] = [
      ["Email/query", { accountId: aid, filter: { inMailbox: inboxId }, sort: [{ property: "receivedAt", isAscending: false }], collapseThreads: true }, "q"],
      ["Email/get", { accountId: aid, ids: [emailId], properties: LIST_PROPS }, "l"],
      ["Email/get", { accountId: aid, ids: [emailId], properties: FULL_PROPS, bodyProperties: BODY_PROPS, fetchHTMLBodyValues: true, fetchTextBodyValues: true }, "f"],
      ["Thread/get", { accountId: aid, ids: [] }, "t"],
    ];
    const responses = await jmap(alice, calls);
    calls.forEach(([method], i) => expect(responses[i]![0], `${method}: ${JSON.stringify(responses[i]![1]).slice(0, 300)}`).toBe(method));
    const full = (responses[2]![1].list as Record<string, unknown>[])[0]!;
    expect(full["header:List-Unsubscribe:asURLs"]).toEqual(["mailto:unsub@list.example?subject=unsubscribe", "https://list.example/u/1"]);
    expect((full.attachments as { name: string }[]).map((a) => a.name)).toEqual(["report.pdf"]);
  });

  it("answers every read the app makes for a signed-in user", async () => {
    const calls: Call[] = [
      ["Mailbox/get", { accountId: aid, properties: MAILBOX_PROPS }, "1"],
      ["Identity/get", { accountId: aid }, "3"],
      ["EmailSubmission/query", { accountId: aid }, "4"],
      ["VacationResponse/get", { accountId: aid }, "5"],
      ["SieveScript/get", { accountId: aid }, "6"],
      ["Quota/get", { accountId: aid }, "7"],
      ["Calendar/get", { accountId: aid, properties: CALENDAR_PROPS }, "8"],
      ["CalendarEvent/query", { accountId: aid }, "9"],
      ["ParticipantIdentity/get", { accountId: aid }, "10"],
      ["AddressBook/get", { accountId: aid, properties: ADDRESS_BOOK_PROPS }, "11"],
      ["ContactCard/query", { accountId: aid }, "12"],
      ["Principal/query", { accountId: aid }, "13"],
      ["FileNode/query", { accountId: aid }, "14"],
      ["PushSubscription/get", {}, "15"],
      ["x:AccountSettings/get", { accountId: aid }, "16"],
      ["x:AppPassword/get", { accountId: aid }, "17"],
      ["x:ApiKey/get", { accountId: aid }, "18"],
      ["x:PublicKey/get", { accountId: aid }, "19"],
      ["x:AccountPassword/get", { accountId: aid }, "20"],
    ];
    await expectAnswered(alice, calls);
  });

  it("reads events with every property list the calendar asks for", async () => {
    // Stalwart 1.0 refuses recurrenceOverrides together with utcStart/utcEnd
    // for the whole call, even with no ids (Gitea issue #66), so the empty
    // gets matter as much as the ones that find something.
    await expectAnswered(alice, [
      ["CalendarEvent/get", { accountId: aid, ids: [], properties: EVENT_PROPS }, "e"],
      ["CalendarEvent/get", { accountId: aid, ids: [], properties: SERIES_PROPS }, "s"],
    ]);

    const calendars = (await jmap(alice, [["Calendar/get", { accountId: aid, properties: CALENDAR_PROPS }, "c"]]))[0]![1].list as { id: string }[];
    let calendarId = calendars[0]?.id;
    if (!calendarId) {
      const made = await jmap(alice, [["Calendar/set", { accountId: aid, create: { c: { name: "Compat" } } }, "c"]]);
      calendarId = (made[0]![1].created as Record<string, { id: string }>).c!.id;
    }
    const event = {
      "@type": "Event",
      uid: crypto.randomUUID(),
      calendarIds: { [calendarId]: true },
      title: "Compat weekly",
      start: "2026-11-02T09:00:00",
      timeZone: "Etc/UTC",
      duration: "PT1H",
      // The singular the editor writes: 0.16 refuses the RFC's list, and 1.0
      // takes the list but drops it, leaving one event.
      recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly", count: 3 },
    };
    const made = await jmap(alice, [["CalendarEvent/set", { accountId: aid, create: { e: event } }, "e"]]);
    const masterId = (made[0]![1].created as Record<string, { id: string }>)?.e?.id;
    expect(masterId, JSON.stringify(made[0]![1])).toBeTruthy();

    // What the grid does: a window, expanded, read with EVENT_PROPS.
    const grid = await jmap(alice, [
      ["CalendarEvent/query", { accountId: aid, filter: { after: "2026-11-01T00:00:00", before: "2026-11-30T00:00:00" }, timeZone: "Etc/UTC", sort: [{ property: "start", isAscending: true }], expandRecurrences: true, limit: 2000 }, "q"],
      ["CalendarEvent/get", { accountId: aid, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: EVENT_PROPS, timeZone: "Etc/UTC" }, "g"],
    ]);
    expect(grid[1]![0], JSON.stringify(grid[1]![1]).slice(0, 300)).toBe("CalendarEvent/get");
    const occurrences = grid[1]![1].list as { utcStart?: string }[];
    expect(occurrences, JSON.stringify(occurrences.map((o) => o.utcStart))).toHaveLength(3);
    expect(occurrences.every((o) => typeof o.utcStart === "string")).toBe(true);

    // What the export does: the master, read with SERIES_PROPS.
    const series = await jmap(alice, [["CalendarEvent/get", { accountId: aid, ids: [masterId], properties: SERIES_PROPS }, "g"]]);
    expect(series[0]![0], JSON.stringify(series[0]![1]).slice(0, 300)).toBe("CalendarEvent/get");
    expect((series[0]![1].list as Record<string, unknown>[])[0]!.recurrenceRule).toBeTruthy();
  });

  it("keeps the settings file the way the app does", async () => {
    // The client's own translation, against whichever shape this server wants
    // (fileNodeShape.ts). Stalwart 1.0 renamed nodeType and type, and refused
    // the old names on every create, so the settings were never written
    // (Gitea issue #66).
    const shape = shapeFromProbe((await jmap(alice, [shapeProbe(aid) as Call]))[0]);
    expect(shape, "the probe decided nothing").not.toBeNull();
    const files = async (calls: Call[]): Promise<Response[]> =>
      (await jmap(alice, calls.map(([m, a, id]) => [m, argsToServer(shape!, m, a), id] as Call))).map(([m, a, id]) => [m, resultFromServer(shape!, m, a), id] as Response);
    const topLevel = async () =>
      ((await files([
        ["FileNode/query", { accountId: aid, filter: { isTopLevel: true }, limit: 1000 }, "q"],
        ["FileNode/get", { accountId: aid, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: folderProps() }, "g"],
      ]))[1]![1].list as FileNode[]);

    // ensureFolder: found, or made and then found by the same test.
    let folderId = (await topLevel()).find(isAppFolder)?.id;
    if (!folderId) {
      const made = await files([["FileNode/set", { accountId: aid, create: { d: directoryCreate(null, APP_FOLDER) } }, "s"]]);
      expect(made[0]![1].notCreated, JSON.stringify(made[0]![1])).toBeFalsy();
      folderId = (await topLevel()).find(isAppFolder)?.id;
    }
    expect(folderId).toBeTruthy();

    // The Files tree asks for folders by kind and sorts them out itself.
    const tree = await files([
      ["FileNode/query", { accountId: aid, filter: { nodeType: "directory" }, sort: [{ property: "name", isAscending: true }], limit: 1000 }, "q"],
      ["FileNode/get", { accountId: aid, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: fileNodeProps() }, "g"],
    ]);
    expect((tree[1]![1].list as FileNode[]).filter((n) => n.nodeType === "directory").map((n) => n.id)).toContain(folderId);

    // writeSettings: upload, then create the file or update the one there.
    const upload = async (text: string) => {
      const res = await fetch(`${BASE}/jmap/upload/${aid}/`, { method: "POST", headers: { "content-type": "application/json", authorization: auth(alice) }, body: text });
      expect(res.ok, `upload: HTTP ${res.status}`).toBe(true);
      return ((await res.json()) as { blobId: string }).blobId;
    };
    const inFolder = async () =>
      ((await files([
        ["FileNode/query", { accountId: aid, filter: { parentId: folderId }, limit: 1000 }, "q"],
        ["FileNode/get", { accountId: aid, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: ["id", "name", "parentId", "blobId", "size", "type", "nodeType"] }, "g"],
      ]))[1]![1].list as FileNode[]).find((n) => n.name === "settings.json");

    const first = '{"theme":"dark"}';
    let existing = await inFolder();
    if (!existing) {
      const made = await files([["FileNode/set", { accountId: aid, create: { s: fileCreate(folderId!, "settings.json", await upload(first), "application/json") } }, "s"]]);
      expect(made[0]![1].notCreated, JSON.stringify(made[0]![1])).toBeFalsy();
      existing = await inFolder();
    }
    expect(existing).toMatchObject({ nodeType: "file", type: "application/json" });

    const second = '{"theme":"light"}';
    const updated = await files([["FileNode/set", { accountId: aid, update: { [existing!.id]: { blobId: await upload(second), type: "application/json", size: second.length } } }, "s"]]);
    expect(updated[0]![1].notUpdated, JSON.stringify(updated[0]![1])).toBeFalsy();
    // A stored blob has an id of its own, so the content is what is compared.
    const stored = (await inFolder())!.blobId!;
    const read = await fetch(`${BASE}/jmap/download/${aid}/${stored}/settings.json?accept=application/json`, { headers: { authorization: auth(alice) } });
    expect(await read.text()).toBe(second);
  });

  it("answers every read the administration pages make", async () => {
    const calls: Call[] = [
      "x:Account/query",
      "x:Domain/query",
      "x:Role/query",
      "x:Tenant/query",
      "x:MailingList/query",
      "x:DkimSignature/query",
      "x:Application/query",
      "x:Metric/query",
    ].map((m, i) => [m, {}, String(i)]);
    calls.push(["x:Authentication/get", { ids: ["singleton"] }, "auth"]);
    await expectAnswered(ADMIN, calls, [STALWART_CAP]);
  });

  it("sends, and the recipient receives", async () => {
    const identity = ((await jmap(alice, [["Identity/get", { accountId: aid }, "i"]]))[0]![1].list as { id: string }[])[0]!.id;
    const calls: Call[] = [
      ["Email/set", { accountId: aid, create: { d: { from: [{ email: `alice@${DOMAIN}` }], to: [{ email: `bob@${DOMAIN}` }], subject: "Compat send", keywords: { $seen: true }, mailboxIds: {}, bodyValues: { b: { value: "hello" } }, textBody: [{ partId: "b", type: "text/plain" }] } } }, "e"],
      ["EmailSubmission/set", { accountId: aid, create: { s: { emailId: "#d", identityId: identity } } }, "s"],
    ];
    // An email needs a mailbox; the drafts folder is where the composer saves one.
    const mailboxes = (await jmap(alice, [["Mailbox/get", { accountId: aid }, "m"]]))[0]![1].list as { id: string; role: string | null }[];
    (calls[0]![1].create as Record<string, Record<string, unknown>>).d!.mailboxIds = { [mailboxes.find((m) => m.role === "drafts")!.id]: true };
    const sent = await jmap(alice, calls);
    expect(Object.keys(sent[1]![1].created ?? {}), JSON.stringify(sent)).toEqual(["s"]);

    const bobId = await accountId(bob);
    let ids: string[] = [];
    for (let i = 0; i < 30 && ids.length === 0; i++) {
      ids = (await jmap(bob, [["Email/query", { accountId: bobId, filter: { subject: "Compat send" } }, "q"]]))[0]![1].ids as string[];
      if (ids.length === 0) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ids).toHaveLength(1);
  }, 60_000);
});
