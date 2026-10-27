// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { CAP, STALWART_CAP, usingFor } from "@/jmap/client";
import { BODY_PROPS, FULL_PROPS, LIST_PROPS, MAILBOX_PROPS } from "@/store/mail/props";
import { CALENDAR_PROPS } from "@/store/calendar";
import { ADDRESS_BOOK_PROPS } from "@/store/contacts";

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
