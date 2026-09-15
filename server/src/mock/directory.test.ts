import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectory, permissionsFor, type MockRole } from "./directory.js";

class Refused extends Error {
  constructor(readonly type: string, description?: string) { super(description ?? type); }
}

const make = (role: MockRole, extra: { metricsOff?: boolean; now?: Date } = {}) => createDirectory({ accountId: "a1", user: "demo@example.com", locale: "en_US", role, fail: (t, d) => new Refused(t, d), ...extra });

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
  const { ids } = dir.handlers["x:Account/query"]!({ filter: { "@type": "User" } }) as { ids: string[] };
  assert.ok(ids.length > 20);
  assert.throws(() => dir.handlers["x:Account/set"]!({ create: { n: { name: "x", domainId: "d1" } } }), (e: Refused) => e.type === "forbidden");
  assert.throws(() => dir.handlers["x:Account/set"]!({ destroy: [ids[0]] }), (e: Refused) => e.type === "forbidden");
});

test("queries page, count and match text the way the client asks", () => {
  const dir = make("admin");
  const all = dir.handlers["x:Account/query"]!({ filter: { "@type": "User" }, calculateTotal: true }) as { ids: string[]; total: number };
  const page = dir.handlers["x:Account/query"]!({ filter: { "@type": "User" }, position: 10, limit: 5, calculateTotal: true }) as { ids: string[]; total: number };
  assert.equal(page.total, all.total);
  assert.deepEqual(page.ids, all.ids.slice(10, 15));
  const ada = dir.handlers["x:Account/query"]!({ filter: { "@type": "User", text: "lovelace" } }) as { ids: string[] };
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
  const created = dir.handlers["x:Domain/set"]!({ create: { n: { name: "fresh.example.net" } } }) as { created: Record<string, { id: string }> };
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

test("a filter on a name the registry does not index is refused, as the live server refuses it", () => {
  const dir = make("admin");
  // Seen on a live 0.16 server: "x:Account/query: unsupportedFilter - type".
  assert.throws(() => dir.handlers["x:Account/query"]!({ filter: { type: "User" } }), (e: Refused) => e.type === "unsupportedFilter" && e.message === "type");
  assert.doesNotThrow(() => dir.handlers["x:Account/query"]!({ filter: { "@type": "Group", domainId: "d1", text: "x" } }));
});

test("the domain validators refuse what the live server refused, in its words", () => {
  const dir = make("admin");
  const set = dir.handlers["x:Domain/set"]!;
  const created = set({ create: { n: { name: "admin-test.example" } } }) as { notCreated?: Record<string, { type: string; description: string }> };
  assert.deepEqual([created.notCreated?.n?.type, created.notCreated?.n?.description], ["invalidPatch", "Invalid domain name"]);
  const updated = set({ update: { d2: { catchAllAddress: "postmaster" } } }) as { notUpdated?: Record<string, { type: string; description: string }> };
  assert.deepEqual([updated.notUpdated?.d2?.type, updated.notUpdated?.d2?.description], ["invalidPatch", "Invalid email address"]);
});

/** The dashboard's feeds: counts, the queue, and the metric history. */
test("counts come back with no ids when the client asks for a total and no page", () => {
  const dir = make("admin");
  const r = dir.handlers["x:QueuedMessage/query"]!({ limit: 0, calculateTotal: true }) as { ids: string[]; total: number };
  assert.deepEqual(r.ids, []);
  assert.equal(r.total, 9);
});

test("the metric history answers the filter the dashboard sends, newest first", () => {
  const dir = make("admin", { now: new Date("2026-09-15T14:25:00Z") });
  const q = dir.handlers["x:Metric/query"]!({
    filter: { timestampIsGreaterThanOrEqual: "2026-09-14T14:25:00Z", metric: ["server.memory"] },
    sort: [{ property: "timestamp", isAscending: false }],
  }) as { ids: string[] };
  const { list } = dir.handlers["x:Metric/get"]!({ ids: q.ids }) as { list: Array<{ metric: string; timestamp: string }> };
  assert.equal(list.length, 24);
  assert.ok(list.every((m) => m.metric === "server.memory"));
  const newest = (dir.handlers["x:Metric/get"]!({ ids: [q.ids[0]] }) as { list: Array<{ timestamp: string }> }).list[0]!;
  const next = (dir.handlers["x:Metric/get"]!({ ids: [q.ids[1]] }) as { list: Array<{ timestamp: string }> }).list[0]!;
  assert.equal(newest.timestamp, "2026-09-15T14:00:00Z");
  assert.ok(newest.timestamp > next.timestamp);
  // A bare timestamp is what a live server refuses.
  assert.throws(() => dir.handlers["x:Metric/query"]!({ filter: { timestamp: "2026-09-15T00:00:00Z" } }), (e: Refused) => e.type === "unsupportedFilter");
});

test("a tenant administrator gets the queue but not the history, and Community refuses the history", () => {
  const tenant = make("tenant-admin");
  assert.equal((tenant.handlers["x:QueuedMessage/query"]!({ calculateTotal: true }) as { total: number }).total, 9);
  assert.throws(() => tenant.handlers["x:Metric/query"]!({}), (e: Refused) => e.type === "forbidden");
  const community = make("admin", { metricsOff: true });
  assert.throws(() => community.handlers["x:Metric/query"]!({}), (e: Refused) => e.type === "forbidden" && /Enterprise/.test(e.message));
});

test("helpdesk may count domains, which is what the demo's helpdesk may do", () => {
  assert.ok(permissionsFor("helpdesk").includes("sysDomainQuery"));
  assert.ok(!permissionsFor("helpdesk").includes("sysMetricQuery"));
});

/** Groups: accounts of type Group, whose members carry the membership. */
test("a group's members are the users whose memberships name it", () => {
  const dir = make("admin");
  const r = dir.handlers["x:Account/query"]!({ filter: { "@type": "User", memberGroupIds: "g2" }, calculateTotal: true }) as { ids: string[]; total: number };
  assert.ok(r.total >= 2);
  const { list } = dir.handlers["x:Account/get"]!({ ids: r.ids, properties: ["memberGroupIds"] }) as { list: Array<{ memberGroupIds: Record<string, boolean> }> };
  assert.ok(list.every((a) => a.memberGroupIds.g2));
});

test("a membership pointer moves only that membership, and a group cannot join one", () => {
  const dir = make("admin");
  const [ada] = (dir.handlers["x:Account/query"]!({ filter: { "@type": "User", text: "lovelace" } }) as { ids: string[] }).ids;
  dir.handlers["x:Account/set"]!({ update: { [ada!]: { "memberGroupIds/g1": true } } });
  const read = () => ((dir.handlers["x:Account/get"]!({ ids: [ada], properties: ["memberGroupIds"] }) as { list: Array<{ memberGroupIds: Record<string, boolean> }> }).list[0]!.memberGroupIds);
  assert.deepEqual(Object.keys(read()).sort(), ["g1", "g2"]);
  dir.handlers["x:Account/set"]!({ update: { [ada!]: { "memberGroupIds/g2": null } } });
  assert.deepEqual(Object.keys(read()), ["g1"]);
  const nested = dir.handlers["x:Account/set"]!({ update: { g1: { "memberGroupIds/g2": true } } }) as { notUpdated?: Record<string, { type: string }> };
  assert.equal(nested.notUpdated?.g1?.type, "invalidProperties");
  const bogus = dir.handlers["x:Account/set"]!({ update: { [ada!]: { "memberGroupIds/u1": true } } }) as { notUpdated?: Record<string, { type: string }> };
  assert.equal(bogus.notUpdated?.[ada!]?.type, "invalidForeignKey");
});

test("a group is kept while members name it, and goes once they are out", () => {
  const dir = make("admin");
  const refused = dir.handlers["x:Account/set"]!({ destroy: ["g2"] }) as { notDestroyed?: Record<string, { type: string; linkedObjects: Array<{ object: string }> }> };
  assert.equal(refused.notDestroyed?.g2?.type, "objectIsLinked");
  assert.ok(refused.notDestroyed!.g2!.linkedObjects.every((l) => l.object === "Account"));
  const members = (dir.handlers["x:Account/query"]!({ filter: { "@type": "User", memberGroupIds: "g2" } }) as { ids: string[] }).ids;
  dir.handlers["x:Account/set"]!({ update: Object.fromEntries(members.map((id) => [id, { "memberGroupIds/g2": null }])) });
  const done = dir.handlers["x:Account/set"]!({ destroy: ["g2"] }) as { destroyed: string[] };
  assert.deepEqual(done.destroyed, ["g2"]);
});

test("a group is created without a password, with Default roles", () => {
  const dir = make("admin");
  const r = dir.handlers["x:Account/set"]!({ create: { n: { "@type": "Group", name: "sales", domainId: "d1", roles: { "@type": "Default" }, permissions: { "@type": "Inherit" }, quotas: {}, aliases: {} } } }) as { created: Record<string, { id: string }> };
  const id = r.created.n!.id;
  const { list } = dir.handlers["x:Account/get"]!({ ids: [id] }) as { list: Array<Record<string, unknown>> };
  assert.equal(list[0]!["@type"], "Group");
  assert.ok(!("memberGroupIds" in list[0]!));
});

/** Mailing lists: their own object, with a set of recipient addresses. */
test("a list is created, found by text, and read back with its address", () => {
  const dir = make("admin");
  const r = dir.handlers["x:MailingList/set"]!({ create: { n: { name: "team", domainId: "d1", recipients: { "x@elsewhere.test": true }, aliases: {} } } }) as { created: Record<string, { id: string }> };
  const id = r.created.n!.id;
  const q = dir.handlers["x:MailingList/query"]!({ filter: { text: "team" }, calculateTotal: true }) as { ids: string[] };
  assert.deepEqual(q.ids, [id]);
  const { list } = dir.handlers["x:MailingList/get"]!({ ids: [id] }) as { list: Array<{ emailAddress: string; recipients: Record<string, boolean> }> };
  assert.match(list[0]!.emailAddress, /^team@/);
  assert.deepEqual(list[0]!.recipients, { "x@elsewhere.test": true });
});

test("a recipient pointer moves one address, and a bad one is refused", () => {
  const dir = make("admin");
  dir.handlers["x:MailingList/set"]!({ update: { l2: { "recipients/new@elsewhere.test": true, "recipients/ada@example.org": null } } });
  const read = () => (dir.handlers["x:MailingList/get"]!({ ids: ["l2"] }) as { list: Array<{ recipients: Record<string, boolean> }> }).list[0]!.recipients;
  assert.deepEqual(Object.keys(read()).sort(), ["chair@elsewhere.test", "new@elsewhere.test"]);
  const bad = dir.handlers["x:MailingList/set"]!({ update: { l2: { "recipients/not-an-address": true } } }) as { notUpdated?: Record<string, { type: string }> };
  assert.equal(bad.notUpdated?.l2?.type, "invalidPatch");
});

test("a list's address cannot be one an account already has, and a role without the permission is refused", () => {
  const dir = make("admin");
  const clash = dir.handlers["x:MailingList/set"]!({ create: { n: { name: "demo", domainId: "d1" } } }) as { notCreated?: Record<string, { type: string }> };
  assert.equal(clash.notCreated?.n?.type, "primaryKeyViolation");
  assert.throws(() => make("helpdesk").handlers["x:MailingList/query"]!({}), (e: Refused) => e.type === "forbidden");
});

/** Roles: Stalwart's grant check, loops, and a role still in use. */
test("a role is refused a permission the caller does not hold, directly or through a base", () => {
  const helpdesk = make("helpdesk");
  // Helpdesk cannot create roles at all.
  assert.throws(() => helpdesk.handlers["x:Role/set"]!({ create: { n: { description: "x" } } }), (e: Refused) => e.type === "forbidden");
  const tenant = make("tenant-admin");
  const direct = tenant.handlers["x:Role/set"]!({ create: { n: { description: "Too much", enabledPermissions: { sysTenantCreate: true } } } }) as { notCreated?: Record<string, { type: string; description: string }> };
  assert.equal(direct.notCreated?.n?.type, "forbidden");
  assert.match(direct.notCreated!.n!.description, /not authorized to grant/);
  const fine = tenant.handlers["x:Role/set"]!({ create: { n: { description: "Accounts only", enabledPermissions: { sysAccountGet: true }, roleIds: { r1: true } } } }) as { created: Record<string, { id: string }> };
  assert.ok(fine.created.n!.id);
});

test("a role cannot build on itself through another, and one in use is kept", () => {
  const dir = make("admin");
  const loop = dir.handlers["x:Role/set"]!({ update: { r1: { "roleIds/r3": true } } }) as { notUpdated?: Record<string, { type: string }> };
  assert.equal(loop.notUpdated?.r1?.type, "invalidPatch");
  const inUse = dir.handlers["x:Role/set"]!({ destroy: ["r1"] }) as { notDestroyed?: Record<string, { type: string; linkedObjects: Array<{ object: string }> }> };
  assert.equal(inUse.notDestroyed?.r1?.type, "objectIsLinked");
  assert.deepEqual([...new Set(inUse.notDestroyed!.r1!.linkedObjects.map((l) => l.object))].sort(), ["Authentication", "Role"]);
  const free = dir.handlers["x:Role/set"]!({ destroy: ["r4"] }) as { destroyed: string[] };
  assert.deepEqual(free.destroyed, ["r4"]);
});

test("the default roles are read from the authentication settings", () => {
  const { list } = make("admin").handlers["x:Authentication/get"]!({ ids: ["singleton"] }) as { list: Array<{ defaultUserRoleIds: Record<string, boolean> }> };
  assert.deepEqual(list[0]!.defaultUserRoleIds, { r1: true });
  assert.throws(() => make("tenant-admin").handlers["x:Authentication/get"]!({}), (e: Refused) => e.type === "forbidden");
});

test("a permission name Stalwart does not know fails the whole change", () => {
  const dir = make("admin");
  const r = dir.handlers["x:Role/set"]!({ update: { r4: { "enabledPermissions/notARealPermission": true, description: "Renamed" } } }) as { notUpdated?: Record<string, { type: string; properties: string[] }> };
  assert.equal(r.notUpdated?.r4?.type, "invalidPatch");
  assert.deepEqual(r.notUpdated!.r4!.properties, ["enabledPermissions/notARealPermission"]);
});

/** Tenants: what they hold is whatever names them, and only an administrator outside one may move things in. */
test("a tenant's members are found by memberTenantId, and it is kept while it has any", () => {
  const dir = make("admin");
  const accounts = dir.handlers["x:Account/query"]!({ filter: { "@type": "User", memberTenantId: "t1" }, calculateTotal: true, limit: 0 }) as { total: number };
  const domains = dir.handlers["x:Domain/query"]!({ filter: { memberTenantId: "t1" }, calculateTotal: true }) as { ids: string[] };
  assert.equal(accounts.total, 1);
  assert.deepEqual(domains.ids, ["d3"]);
  const refused = dir.handlers["x:Tenant/set"]!({ destroy: ["t1"] }) as { notDestroyed?: Record<string, { type: string; linkedObjects: Array<{ object: string }> }> };
  assert.equal(refused.notDestroyed?.t1?.type, "objectIsLinked");
  assert.deepEqual([...new Set(refused.notDestroyed!.t1!.linkedObjects.map((l) => l.object))].sort(), ["Account", "Domain"]);
});

test("a tenant is created with quotas, a domain moves into it, and an empty one is deleted", () => {
  const dir = make("admin");
  const c = dir.handlers["x:Tenant/set"]!({ create: { n: { name: "Globex", quotas: { maxAccounts: 5, maxDiskQuota: 1024 } } } }) as { created: Record<string, { id: string }> };
  const id = c.created.n!.id;
  const bad = dir.handlers["x:Tenant/set"]!({ update: { [id]: { "quotas/maxWidgets": 3 } } }) as { notUpdated?: Record<string, { type: string }> };
  assert.equal(bad.notUpdated?.[id]?.type, "invalidPatch");
  dir.handlers["x:Domain/set"]!({ update: { d4: { memberTenantId: id } } });
  assert.equal((dir.handlers["x:Domain/query"]!({ filter: { memberTenantId: id }, calculateTotal: true }) as { total: number }).total, 1);
  dir.handlers["x:Domain/set"]!({ update: { d4: { memberTenantId: null } } });
  assert.deepEqual((dir.handlers["x:Tenant/set"]!({ destroy: [id] }) as { destroyed: string[] }).destroyed, [id]);
});

test("a tenant administrator cannot move anything into a tenant", () => {
  const dir = make("tenant-admin");
  const r = dir.handlers["x:Domain/set"]!({ update: { d4: { memberTenantId: "t1" } } }) as { notUpdated?: Record<string, { type: string; description: string }> };
  assert.equal(r.notUpdated?.d4?.type, "invalidPatch");
  assert.match(r.notUpdated!.d4!.description, /memberTenantId/);
});
