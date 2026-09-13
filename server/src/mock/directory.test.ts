import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectory, permissionsFor, type MockRole } from "./directory.js";

class Refused extends Error {
  constructor(readonly type: string, description?: string) { super(description ?? type); }
}

const make = (role: MockRole) => createDirectory({ accountId: "a1", user: "demo@example.com", locale: "en_US", role, fail: (t, d) => new Refused(t, d) });

/**
 * The mock stands in for a server that decides what each account may do, so
 * the client's administration can be developed against refusals as well as
 * successes. These pin the refusals.
 */
test("an ordinary user is refused the directory outright", () => {
  const dir = make("user");
  assert.throws(() => dir.handlers["x:Account/query"]!({}), (e: Refused) => e.type === "forbidden");
  assert.ok(!permissionsFor("user").some((p) => p.startsWith("sysAccountQuery")));
});

test("helpdesk may read and edit but not create or delete", () => {
  const dir = make("helpdesk");
  const { ids } = dir.handlers["x:Account/query"]!({ filter: { type: "User" } }) as { ids: string[] };
  assert.ok(ids.length > 20);
  assert.throws(() => dir.handlers["x:Account/set"]!({ create: { n: { name: "x", domainId: "d1" } } }), (e: Refused) => e.type === "forbidden");
  assert.throws(() => dir.handlers["x:Account/set"]!({ destroy: [ids[0]] }), (e: Refused) => e.type === "forbidden");
});

test("queries page, count and match text the way the client asks", () => {
  const dir = make("admin");
  const all = dir.handlers["x:Account/query"]!({ filter: { type: "User" }, calculateTotal: true }) as { ids: string[]; total: number };
  const page = dir.handlers["x:Account/query"]!({ filter: { type: "User" }, position: 10, limit: 5, calculateTotal: true }) as { ids: string[]; total: number };
  assert.equal(page.total, all.total);
  assert.deepEqual(page.ids, all.ids.slice(10, 15));
  const ada = dir.handlers["x:Account/query"]!({ filter: { type: "User", text: "lovelace" } }) as { ids: string[] };
  assert.equal(ada.ids.length, 1);
  assert.throws(() => dir.handlers["x:Account/query"]!({ filter: { operator: "OR", conditions: [] } }), (e: Refused) => e.type === "unsupportedFilter");
});

test("an address already used as an alias cannot be taken", () => {
  const dir = make("admin");
  const res = dir.handlers["x:Account/set"]!({ create: { n: { "@type": "User", name: "postmaster", domainId: "d1", credentials: { "0": { "@type": "Password", secret: "long enough secret" } }, roles: { "@type": "User" } } } }) as { notCreated?: Record<string, { type: string }> };
  assert.equal(res.notCreated?.n?.type, "primaryKeyViolation");
});

test("a password is set through its credential's pointer, and a weak one is refused", () => {
  const dir = make("admin");
  const set = dir.handlers["x:Account/set"]!;
  assert.equal((set({ update: { a1: { "credentials/0/secret": "short" } } }) as { notUpdated?: Record<string, { properties: string[] }> }).notUpdated?.a1?.properties[0], "secret");
  assert.deepEqual((set({ update: { a1: { "credentials/0/secret": "a much longer secret" } } }) as { updated: object }).updated, { a1: null });
  const got = dir.handlers["x:Account/get"]!({ ids: ["a1"], properties: ["credentials"] }) as { list: Array<{ credentials: Record<string, { secret: string }> }> };
  assert.equal(got.list[0]!.credentials["0"]!.secret, "[********]", "never echoed back");
});

test("a grant the caller does not hold is refused", () => {
  const dir = make("helpdesk");
  const res = dir.handlers["x:Account/set"]!({ update: { u101: { roles: { "@type": "Admin" } } } }) as { notUpdated?: Record<string, { type: string }> };
  assert.equal(res.notUpdated?.u101?.type, "forbidden");
});

test("an administrator can delete an account, and a group with members is kept", () => {
  const dir = make("admin");
  const set = dir.handlers["x:Account/set"]!;
  assert.deepEqual((set({ destroy: ["u101"] }) as { destroyed: string[] }).destroyed, ["u101"]);
  assert.equal((set({ destroy: ["g1"] }) as { notDestroyed?: Record<string, { type: string }> }).notDestroyed?.g1?.type, "objectIsLinked");
});

test("a domain in use is kept, and names what uses it", () => {
  const dir = make("admin");
  const set = dir.handlers["x:Domain/set"]!;
  const res = set({ destroy: ["d1"] }) as { notDestroyed?: Record<string, { type: string; linkedObjects: Array<{ object: string }> }> };
  assert.equal(res.notDestroyed?.d1?.type, "objectIsLinked");
  const kinds = new Set(res.notDestroyed?.d1?.linkedObjects.map((o) => o.object));
  assert.deepEqual([...kinds].sort(), ["Account", "DkimSignature"]);
});

test("an unused domain goes once its keys do", () => {
  const dir = make("admin");
  const created = dir.handlers["x:Domain/set"]!({ create: { n: { name: "fresh.example" } } }) as { created: Record<string, { id: string }> };
  const id = created.created.n!.id;
  const keys = dir.handlers["x:DkimSignature/query"]!({ filter: { domainId: id } }) as { ids: string[] };
  assert.equal(keys.ids.length, 1, "automatic DKIM makes a key straight away");
  assert.equal((dir.handlers["x:Domain/set"]!({ destroy: [id] }) as { notDestroyed?: object }).notDestroyed !== undefined, true);
  dir.handlers["x:DkimSignature/set"]!({ destroy: keys.ids });
  assert.deepEqual((dir.handlers["x:Domain/set"]!({ destroy: [id] }) as { destroyed: string[] }).destroyed, [id]);
});

test("a domain's zone file is computed on read, with long keys split as the server splits them", () => {
  const dir = make("admin");
  const got = dir.handlers["x:Domain/get"]!({ ids: ["d1"], properties: ["name", "dnsZoneFile"] }) as { list: Array<{ dnsZoneFile: string }> };
  const zone = got.list[0]!.dnsZoneFile;
  assert.match(zone, /IN MX 10 /);
  assert.match(zone, /_domainkey\.example\.com\. IN TXT \(\n {4}"/);
});
