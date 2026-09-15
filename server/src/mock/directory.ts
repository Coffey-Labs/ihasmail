/**
 * Enough of Stalwart 0.16's directory registry to develop administration
 * against: `x:Account`, `x:Domain` and `x:Role`, gated by permission names the
 * way the real server gates them.
 *
 * Shapes follow the 0.16.22 source rather than the documentation, which has
 * been wrong about both before:
 *
 * - a `List<T>` (credentials, aliases) is an object keyed by index -- `{"0": …}`
 *   -- and a `Set` (memberGroupIds, enabledPermissions) is `{"id": true}`;
 * - an account's `name` is the local part only, and it lives on a domain by id;
 * - secrets come back masked, and a new one is written through the password
 *   credential's own pointer, `credentials/<index>/secret`;
 * - `x:Account/query` understands AND and nothing else.
 *
 * It also answers the two feeds Administration's dashboard reads: a short
 * outbound queue (`x:QueuedMessage`) and a day and a bit of hourly metric
 * history (`x:Metric`), dated from when the mock started. MOCK_METRICS=off
 * refuses the history the way a Community server does.
 *
 * What it does not reproduce is tenancy: every caller sees every record. The
 * real server scopes a tenant administrator's queries, and nothing in the client
 * relies on seeing more or less than it is given.
 *
 * MOCK_ROLE picks who the demo user is: `admin` (the default), `tenant-admin`,
 * `helpdesk` (a custom role that may view and edit accounts but not create or
 * delete them) or `user`.
 */

type Obj = Record<string, unknown>;

export type MockRole = "admin" | "tenant-admin" | "helpdesk" | "user";

const OPS = ["Get", "Query", "Create", "Update", "Destroy"] as const;
const all = (...objects: string[]) => objects.flatMap((o) => OPS.map((op) => `sys${o}${op}`));

/** What the dashboard reads beyond the directory. */
const READ_SERVER = ["sysQueuedMessageGet", "sysQueuedMessageQuery", "sysMetricGet", "sysMetricQuery"];

/** A few of the ordinary ones, so the list looks like what a server sends. */
const USER_PERMISSIONS = ["jmapEmailGet", "jmapEmailSet", "jmapMailboxGet", "sysAccountSettingsGet"];

export function permissionsFor(role: MockRole): string[] {
  switch (role) {
    case "admin":
      return [...USER_PERMISSIONS, ...all("Account", "Domain", "Role", "MailingList", "DkimSignature", "DnsServer", "Tenant"), ...READ_SERVER, "impersonate"];
    case "tenant-admin":
      // The queue but not the metric history: Stalwart scopes the one to a
      // tenant's domains, and the other has no tenant to scope it by.
      return [...USER_PERMISSIONS, ...all("Account", "Domain", "Role", "MailingList", "DkimSignature", "DnsServer"), "sysQueuedMessageGet", "sysQueuedMessageQuery"];
    case "helpdesk":
      return [...USER_PERMISSIONS, "sysAccountGet", "sysAccountQuery", "sysAccountUpdate", "sysDomainGet", "sysDomainQuery"];
    default:
      return USER_PERMISSIONS;
  }
}

export function mockRole(raw: string | undefined): MockRole {
  return raw === "tenant-admin" || raw === "helpdesk" || raw === "user" ? raw : "admin";
}

const MASKED = "[********]";
const GIB = 1024 ** 3;

interface Options {
  /** The demo user's JMAP account id, which is also its registry id. */
  accountId: string;
  /** The demo user's address. */
  user: string;
  locale: string;
  role: MockRole;
  /** Build the error a method fails with; the mock server owns the type. */
  fail: (type: string, description?: string) => Error;
  /** Refuse the metric history, as a Community server does. */
  metricsOff?: boolean;
  /** When the history ends; the newest hour is the one this falls in. */
  now?: Date;
}

export function createDirectory(opts: Options) {
  const permissions = new Set(permissionsFor(opts.role));
  const [userLocal, userDomain] = splitAddress(opts.user);
  let counter = 100;

  const managed = (dns: boolean, dkim: boolean, certs: boolean) => ({
    dnsManagement: dns ? { "@type": "Automatic", dnsServerId: "ns1", origin: null, publishRecords: {} } : { "@type": "Manual" },
    dkimManagement: dkim ? { "@type": "Automatic", algorithms: { Dkim1Ed25519Sha256: true, Dkim1RsaSha256: true }, selectorTemplate: "v{version}-{algorithm}-{date-%Y%m%d}" } : { "@type": "Manual" },
    certificateManagement: certs ? { "@type": "Automatic", acmeProviderId: "acme1", subjectAlternativeNames: {} } : { "@type": "Manual" },
  });
  const domain = (id: string, name: string, extra: Obj = {}): Obj => ({
    id, name, aliases: {}, isEnabled: true, createdAt: "2026-06-01T09:00:00Z", description: null, logo: null,
    ...managed(false, true, false), memberTenantId: null, directoryId: null, catchAllAddress: null,
    subAddressing: { "@type": "Enabled" }, allowRelaying: false, reportAddressUri: "mailto:postmaster", allowScimProvisioning: false, ...extra,
  });
  const domains: Obj[] = [
    domain("d1", userDomain, { ...managed(true, true, true), aliases: { [`mail.${userDomain}`]: true }, description: "Main domain" }),
    domain("d2", userDomain === "example.org" ? "example.net" : "example.org", { catchAllAddress: `postmaster@${userDomain}` }),
    domain("d3", "old-brand.example", { ...managed(false, false, false), description: "No longer used", subAddressing: { "@type": "Custom", customRule: "..." } }),
  ];
  const dkimKeys: Obj[] = [
    { id: "k1", "@type": "Dkim1Ed25519Sha256", domainId: "d1", selector: "v1-ed25519-20260601", stage: "active", createdAt: "2026-06-01T09:00:00Z", nextTransitionAt: "2026-08-30T09:00:00Z", memberTenantId: null },
    { id: "k2", "@type": "Dkim1RsaSha256", domainId: "d1", selector: "v1-rsa-20260601", stage: "active", createdAt: "2026-06-01T09:00:00Z", nextTransitionAt: "2026-08-30T09:00:00Z", memberTenantId: null },
    { id: "k3", "@type": "Dkim1Ed25519Sha256", domainId: "d2", selector: "v1-ed25519-20260710", stage: "active", createdAt: "2026-07-10T09:00:00Z", nextTransitionAt: null, memberTenantId: null },
  ];
  /** What Stalwart's BIND serialiser writes, including a TXT long enough to be split. */
  const zoneFile = (d: Obj): string => {
    const n = String(d.name);
    const lines = [
      `${n}. IN MX 10 mail.${userDomain}.`,
      `${n}. IN TXT "v=spf1 mx ra=postmaster -all"`,
    ];
    for (const k of dkimKeys.filter((k) => k.domainId === d.id && k.stage !== "retired")) {
      if (String(k["@type"]).includes("Rsa")) {
        const p = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" + "x".repeat(300) + "IDAQAB";
        const txt = `v=DKIM1; k=rsa; h=sha256; p=${p}`;
        lines.push(`${k.selector}._domainkey.${n}. IN TXT (`, ...(txt.match(/.{1,255}/g) ?? []).map((c) => `    "${c}"`), ")");
      } else {
        lines.push(`${k.selector}._domainkey.${n}. IN TXT "v=DKIM1; k=ed25519; h=sha256; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="`);
      }
    }
    lines.push(
      `_dmarc.${n}. IN TXT "v=DMARC1; p=reject; rua=mailto:postmaster@${n}; ruf=mailto:postmaster@${n}"`,
      `_jmap._tcp.${n}. IN SRV 0 1 443 mail.${userDomain}.`,
      `_submissions._tcp.${n}. IN SRV 0 1 465 mail.${userDomain}.`,
      `_imaps._tcp.${n}. IN SRV 0 1 993 mail.${userDomain}.`,
      `mta-sts.${n}. IN CNAME mail.${userDomain}.`,
      `_mta-sts.${n}. IN TXT "v=STSv1; id=16837364213434767412"`,
      `_smtp._tls.${n}. IN TXT "v=TLSRPTv1; rua=mailto:postmaster@${n}"`,
      `autoconfig.${n}. IN CNAME mail.${userDomain}.`,
      `${n}. IN CAA 0 issue "letsencrypt.org"`,
    );
    return lines.join("\n") + "\n";
  };

  const roles: Obj[] = [
    { id: "r1", description: "User", enabledPermissions: flags(USER_PERMISSIONS), disabledPermissions: {}, roleIds: {} },
    { id: "r2", description: "Helpdesk", enabledPermissions: flags(permissionsFor("helpdesk").filter((p) => p.startsWith("sys"))), disabledPermissions: {}, roleIds: { r1: true } },
    { id: "r3", description: "Directory manager", enabledPermissions: flags(all("Account")), disabledPermissions: {}, roleIds: { r1: true } },
  ];

  const ownRoles = opts.role === "admin" || opts.role === "tenant-admin" ? { "@type": "Admin" } : opts.role === "helpdesk" ? { "@type": "Custom", roleIds: { r2: true } } : { "@type": "User" };

  const accounts: Obj[] = [];
  const user = (o: { id?: string; name: string; domain?: string; description: string; roles?: Obj; used?: number; quota?: number; aliases?: string[]; groups?: string[]; password?: boolean }) => {
    const domainId = o.domain === "d2" ? "d2" : "d1";
    const row: Obj = {
      id: o.id ?? `u${counter++}`,
      "@type": "User",
      name: o.name,
      domainId,
      description: o.description,
      credentials: o.password === false ? {} : { "0": { "@type": "Password", credentialId: "0", secret: MASKED, otpAuth: null, expiresAt: null, allowedIps: {} } },
      createdAt: new Date(Date.now() - counter * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      memberGroupIds: flags(o.groups ?? []),
      memberTenantId: null,
      roles: o.roles ?? { "@type": "User" },
      permissions: { "@type": "Inherit" },
      quotas: o.quota ? { maxDiskQuota: o.quota * GIB } : {},
      usedDiskQuota: Math.round((o.used ?? 0) * GIB),
      aliases: Object.fromEntries((o.aliases ?? []).map((name, i) => [String(i), { enabled: true, name, domainId, description: null }])),
      locale: opts.locale,
      timeZone: null,
    };
    accounts.push(row);
    return row;
  };
  const group = (id: string, name: string, description: string) =>
    accounts.push({ id, "@type": "Group", name, domainId: "d1", description, memberTenantId: null, roles: { "@type": "User" }, permissions: { "@type": "Inherit" }, quotas: {}, usedDiskQuota: 0, aliases: {} });

  group("g1", "support", "Support");
  group("g2", "office", "Office");
  user({ id: opts.accountId, name: userLocal, description: "Demo User", roles: ownRoles, used: 1.4, quota: 10, aliases: ["postmaster"], groups: ["g1"] });
  user({ name: "ada", domain: "d2", description: "Ada Lovelace", used: 3.2, quota: 5, groups: ["g2"] });
  user({ name: "grace", domain: "d2", description: "Grace Hopper", used: 4.7, quota: 5, groups: ["g2"] });
  user({ name: "alan", domain: "d2", description: "Alan Turing", roles: { "@type": "Custom", roleIds: { r2: true } }, used: 0.8, quota: 5, groups: ["g1"] });
  user({ name: "margaret", description: "Margaret Hamilton", roles: { "@type": "Admin" }, used: 2.1, quota: 20 });
  user({ name: "katherine", description: "Katherine Johnson", roles: { "@type": "Custom", roleIds: { r3: true } }, used: 0.4, quota: 5 });
  user({ name: "sso.only", description: "Signs in with SSO", password: false, used: 0.1 });
  const people = ["Edsger Dijkstra", "Barbara Liskov", "Donald Knuth", "Frances Allen", "John Backus", "Radia Perlman", "Ken Thompson", "Hedy Lamarr", "Dennis Ritchie", "Karen Spärck Jones", "Tim Berners-Lee", "Sophie Wilson", "Niklaus Wirth", "Jean Sammet", "Leslie Lamport", "Mary Kenneth Keller", "Tony Hoare", "Evelyn Berezin", "Butler Lampson", "Shafi Goldwasser", "Whitfield Diffie", "Adele Goldberg", "Vint Cerf", "Anita Borg", "Bob Kahn", "Lynn Conway", "Charles Babbage", "Annie Easley"];
  people.forEach((description, i) => {
    const name = description.toLowerCase().split(" ")[0]!.normalize("NFD").replace(/[^a-z]/g, "");
    user({ name, domain: i % 3 === 0 ? "d2" : "d1", description, used: (i % 7) * 0.6, quota: i % 4 === 0 ? 0 : 5 });
  });

  // Nine messages waiting, which is what a small live server had queued on the
  // day this was written: a few retries and the odd report.
  const queue: Obj[] = Array.from({ length: 9 }, (_, i) => ({ id: `q${i + 1}`, createdAt: new Date(Date.UTC(2026, 8, 15, 6 + i)).toISOString(), size: 2400 + i * 310, priority: 0, flags: {} }));

  /**
   * Thirty hours of history ending in the current hour: a Counter per hour for
   * what was queued, and a memory Gauge. Counters that would be zero are left
   * out, as Stalwart leaves them out.
   */
  const metrics: Obj[] = [];
  {
    const hour = 3600_000;
    const end = Math.floor((opts.now ?? new Date()).getTime() / hour) * hour;
    for (let h = 29; h >= 0; h--) {
      const at = end - h * hour;
      const timestamp = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
      const seq = (29 - h) * 10;
      const push = (n: number, type: string, metric: string, count: number) => {
        if (type === "Counter" && !count) return;
        metrics.push({ id: `m${String(seq + n).padStart(4, "0")}`, "@type": type, metric, count, timestamp });
      };
      push(0, "Gauge", "server.memory", 360_000_000 + ((h * 7_919_000) % 40_000_000));
      push(1, "Counter", "queue.message-queued", (h * 5 + 3) % 9);
      push(2, "Counter", "queue.authenticated-message-queued", h % 3);
      push(3, "Counter", "queue.dsn-queued", h % 11 === 0 ? 1 : 0);
      push(4, "Counter", "queue.report-queued", h % 4 === 1 ? 2 : 0);
    }
  }
  const refuseMetrics = () => {
    if (opts.metricsOff) throw opts.fail("forbidden", "This feature is only available in the Enterprise edition of Stalwart.");
  };

  const demand = (perm: string) => {
    if (!permissions.has(perm)) throw opts.fail("forbidden", `You do not have the ${perm} permission.`);
  };
  const domainName = (id: unknown) => domains.find((d) => d.id === id)?.name as string | undefined;
  const addressOf = (o: Obj) => `${o.name}@${domainName(o.domainId) ?? "invalid"}`;
  /** Every address in use, primary and alias, across accounts. */
  const addressTaken = (address: string, except?: string) =>
    accounts.some((a) => a.id !== except && (addressOf(a) === address || Object.values((a.aliases as Obj) ?? {}).some((al) => `${(al as Obj).name}@${domainName((al as Obj).domainId)}` === address)));

  const view = (o: Obj, properties: unknown): Obj => {
    const full: Obj = { ...o };
    if (accounts.includes(o)) full.emailAddress = addressOf(o);
    if (domains.includes(o)) full.dnsZoneFile = zoneFile(o);
    if (full.credentials) {
      full.credentials = Object.fromEntries(Object.entries(full.credentials as Obj).map(([k, c]) => [k, { ...(c as Obj), secret: MASKED }]));
    }
    if (!Array.isArray(properties)) return full;
    const out: Obj = { id: o.id };
    for (const p of properties as string[]) if (p in full) out[p] = full[p];
    return out;
  };

  const get = (list: Obj[], perm: string) => (a: Obj) => {
    demand(perm);
    const ids = a.ids as string[] | null | undefined;
    const found = ids ? list.filter((x) => ids.includes(x.id as string)) : list;
    return { accountId: opts.accountId, state: "1", list: found.map((x) => view(x, a.properties)), notFound: ids ? ids.filter((id) => !list.some((x) => x.id === id)) : [] };
  };

  /**
   * A query, filtered only on what the real server indexes for that object.
   * Any other name is refused the way Stalwart refuses it -- `unsupportedFilter`
   * with the name as the whole description -- because a mock that took
   * `{"type": "User"}` let exactly that ship, and the live server answers it
   * with "unsupportedFilter - type".
   */
  const query = (list: () => Obj[], perm: string, filterable: string[], match: (o: Obj, filter: Obj) => boolean) => (a: Obj) => {
    demand(perm);
    const filter = (a.filter as Obj | undefined) ?? {};
    if ("operator" in filter) throw opts.fail("unsupportedFilter", "Only AND is supported in filters");
    const unknown = Object.keys(filter).find((k) => !filterable.includes(k));
    if (unknown) throw opts.fail("unsupportedFilter", unknown);
    // Stalwart's default order is newest first, by id.
    const rows = list().filter((o) => match(o, filter)).sort((x, y) => String(y.id).localeCompare(String(x.id), undefined, { numeric: true }));
    const position = Math.max(0, Number(a.position ?? 0));
    const limit = a.limit == null ? rows.length : Number(a.limit);
    return {
      accountId: opts.accountId,
      queryState: "1",
      canCalculateChanges: false,
      position,
      ids: rows.slice(position, position + limit).map((o) => o.id),
      ...(a.calculateTotal ? { total: rows.length } : {}),
    };
  };

  const matchText = (o: Obj, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) return true;
    const needle = text.trim().toLowerCase();
    return [o.name, o.description, addressOf(o)].some((v) => typeof v === "string" && v.toLowerCase().includes(needle));
  };

  const setError = (type: string, description: string, properties?: string[]) => ({ type, description, ...(properties ? { properties } : {}) });

  /** The password checks, roughly as strict as a default Stalwart. */
  const weakPassword = (secret: unknown) => (typeof secret !== "string" || secret.length < 8 ? "Password must be at least 8 characters long." : null);

  /** Stalwart checks a grant against the caller's own permissions. */
  const grantRefused = (roles: unknown): string | null => {
    const r = roles as Obj | undefined;
    if (!r) return null;
    if (r["@type"] === "Admin" && opts.role !== "admin" && opts.role !== "tenant-admin") return "You are not authorized to grant permissions: administrator.";
    if (r["@type"] === "Custom") {
      for (const id of Object.keys((r.roleIds as Obj) ?? {})) {
        const role = roles_(id);
        if (!role) return "Role does not exist.";
        const missing = Object.keys((role.enabledPermissions as Obj) ?? {}).filter((p) => !permissions.has(p));
        if (missing.length) return `You are not authorized to grant permissions: ${missing.join(", ")}.`;
      }
    }
    return null;
  };
  const roles_ = (id: string) => roles.find((r) => r.id === id);

  const handlers: Record<string, (a: Obj) => Obj> = {
    "x:Account/get": get(accounts, "sysAccountGet"),
    "x:Account/query": query(() => accounts, "sysAccountQuery", ["text", "@type", "domainId", "externalId", "memberGroupIds", "memberTenantId", "name"], (o, f) =>
      (f["@type"] === undefined || o["@type"] === f["@type"]) && (f.domainId === undefined || o.domainId === f.domainId) && matchText(o, f.text) && matchText(o, f.name)),
    "x:Account/set": (a) => {
      const created: Obj = {};
      const notCreated: Obj = {};
      const updated: Obj = {};
      const notUpdated: Obj = {};
      const destroyed: string[] = [];
      const notDestroyed: Obj = {};
      for (const [cid, raw] of Object.entries((a.create as Obj) ?? {})) {
        demand("sysAccountCreate");
        const o = { ...(raw as Obj) };
        if (typeof o.name !== "string" || !/^[a-z0-9._-]+$/i.test(o.name)) { notCreated[cid] = setError("invalidProperties", "Invalid account name.", ["name"]); continue; }
        if (!domainName(o.domainId)) { notCreated[cid] = setError("invalidForeignKey", "Domain does not exist.", ["domainId"]); continue; }
        if (addressTaken(`${o.name}@${domainName(o.domainId)}`)) { notCreated[cid] = setError("primaryKeyViolation", "An account or alias with this email address already exists."); continue; }
        const refused = grantRefused(o.roles);
        if (refused) { notCreated[cid] = setError("forbidden", refused); continue; }
        const password = Object.values((o.credentials as Obj) ?? {})[0] as Obj | undefined;
        const weak = password ? weakPassword(password.secret) : null;
        if (weak) { notCreated[cid] = setError("invalidProperties", weak, ["secret"]); continue; }
        const id = `u${counter++}`;
        accounts.push({ memberGroupIds: {}, aliases: {}, quotas: {}, permissions: { "@type": "Inherit" }, ...o, id, memberTenantId: null, usedDiskQuota: 0, createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), locale: opts.locale, timeZone: null });
        created[cid] = { id, emailAddress: `${o.name}@${domainName(o.domainId)}` };
      }
      for (const [id, raw] of Object.entries((a.update as Obj) ?? {})) {
        demand("sysAccountUpdate");
        const target = accounts.find((x) => x.id === id);
        if (!target) { notUpdated[id] = setError("notFound", "Account not found."); continue; }
        const patch = raw as Obj;
        const next = structuredClone(target);
        let failure: Obj | null = null;
        for (const [path, value] of Object.entries(patch)) {
          if (path === "id" || path === "@type" || path === "usedDiskQuota" || path === "emailAddress") { failure = setError("invalidProperties", `Property ${path} cannot be changed.`, [path]); break; }
          if (path.endsWith("/secret")) {
            const weak = weakPassword(value);
            if (weak) { failure = setError("invalidProperties", weak, ["secret"]); break; }
          }
          if (path.startsWith("credentials/") && value && typeof value === "object") {
            const weak = weakPassword((value as Obj).secret);
            if (weak) { failure = setError("invalidProperties", weak, ["secret"]); break; }
          }
          setPointer(next, path, value);
        }
        if (!failure && ("roles" in patch || "permissions" in patch)) {
          const refused = grantRefused(next.roles);
          if (refused) failure = setError("forbidden", refused);
        }
        if (!failure) {
          for (const al of Object.values((next.aliases as Obj) ?? {})) {
            const address = `${(al as Obj).name}@${domainName((al as Obj).domainId)}`;
            if (!domainName((al as Obj).domainId)) { failure = setError("invalidForeignKey", "Domain does not exist.", ["aliases"]); break; }
            if (addressTaken(address, id)) { failure = setError("primaryKeyViolation", "An account or alias with this email address already exists."); break; }
          }
        }
        if (failure) { notUpdated[id] = failure; continue; }
        // Secrets are stored hashed; the mock just stops echoing them.
        for (const c of Object.values((next.credentials as Obj) ?? {})) (c as Obj).secret = MASKED;
        Object.assign(target, next);
        updated[id] = null;
      }
      for (const id of (a.destroy as string[]) ?? []) {
        demand("sysAccountDestroy");
        const i = accounts.findIndex((x) => x.id === id);
        if (i < 0) { notDestroyed[id] = setError("notFound", "Account not found."); continue; }
        if (accounts[i]!["@type"] === "Group" && accounts.some((x) => (x.memberGroupIds as Obj | undefined)?.[id])) {
          notDestroyed[id] = { ...setError("objectIsLinked", "Group still has members."), linkedObjects: {} };
          continue;
        }
        accounts.splice(i, 1);
        destroyed.push(id);
      }
      return { accountId: opts.accountId, oldState: "1", newState: "2", created, updated, destroyed, ...(Object.keys(notCreated).length ? { notCreated } : {}), ...(Object.keys(notUpdated).length ? { notUpdated } : {}), ...(Object.keys(notDestroyed).length ? { notDestroyed } : {}) };
    },
    "x:Domain/get": get(domains, "sysDomainGet"),
    "x:Domain/query": query(() => domains, "sysDomainQuery", ["text", "aliases", "memberTenantId", "name"], (o, f) => matchText(o, f.text) && matchText(o, f.name)),
    "x:Domain/set": (a) => {
      const created: Obj = {};
      const notCreated: Obj = {};
      const updated: Obj = {};
      const notUpdated: Obj = {};
      const destroyed: string[] = [];
      const notDestroyed: Obj = {};
      const taken = (name: string, except?: string) => domains.some((d) => d.id !== except && (d.name === name || Object.keys((d.aliases as Obj) ?? {}).includes(name)));
      for (const [cid, raw] of Object.entries((a.create as Obj) ?? {})) {
        demand("sysDomainCreate");
        const o = raw as Obj;
        const name = String(o.name ?? "");
        // Live on 2026-09-13: a reserved TLD is refused by the registry's
        // domain validator, as invalidPatch with the validator's own words.
        if (!/^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(name) || /\.(example|test|invalid|localhost)$/.test(name)) { notCreated[cid] = setError("invalidPatch", "Invalid domain name", ["name"]); continue; }
        if (taken(name)) { notCreated[cid] = setError("primaryKeyViolation", "A domain with this name already exists.", ["name"]); continue; }
        const id = `d${counter++}`;
        domains.push(domain(id, name, { ...o, id, createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }));
        // Automatic DKIM, the default, makes its keys straight away.
        dkimKeys.push({ id: `k${counter++}`, "@type": "Dkim1Ed25519Sha256", domainId: id, selector: "v1-ed25519-20260913", stage: "active", createdAt: new Date().toISOString(), nextTransitionAt: null, memberTenantId: null });
        created[cid] = { id };
      }
      for (const [id, raw] of Object.entries((a.update as Obj) ?? {})) {
        demand("sysDomainUpdate");
        const target = domains.find((d) => d.id === id);
        if (!target) { notUpdated[id] = setError("notFound", "Domain not found."); continue; }
        const next = structuredClone(target);
        for (const [path, value] of Object.entries(raw as Obj)) setPointer(next, path, value);
        // Live on 2026-09-13: a catch-all that is not a whole address.
        if (typeof next.catchAllAddress === "string" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.catchAllAddress)) { notUpdated[id] = setError("invalidPatch", "Invalid email address", ["catchAllAddress"]); continue; }
        const clash = Object.keys((next.aliases as Obj) ?? {}).find((alias) => alias === next.name || taken(alias, id));
        if (clash) { notUpdated[id] = setError("primaryKeyViolation", `The name ${clash} is already in use.`, ["aliases"]); continue; }
        Object.assign(target, next);
        updated[id] = null;
      }
      for (const id of (a.destroy as string[]) ?? []) {
        demand("sysDomainDestroy");
        const i = domains.findIndex((d) => d.id === id);
        if (i < 0) { notDestroyed[id] = setError("notFound", "Domain not found."); continue; }
        const linked = [
          ...accounts.filter((x) => x.domainId === id || Object.values((x.aliases as Obj) ?? {}).some((al) => (al as Obj).domainId === id)).map((x) => ({ object: "Account", id: x.id })),
          ...dkimKeys.filter((k) => k.domainId === id).map((k) => ({ object: "DkimSignature", id: k.id })),
        ];
        if (linked.length) { notDestroyed[id] = { ...setError("objectIsLinked", "Object is linked to other objects."), linkedObjects: linked }; continue; }
        domains.splice(i, 1);
        destroyed.push(id);
      }
      return { accountId: opts.accountId, oldState: "1", newState: "2", created, updated, destroyed, ...(Object.keys(notCreated).length ? { notCreated } : {}), ...(Object.keys(notUpdated).length ? { notUpdated } : {}), ...(Object.keys(notDestroyed).length ? { notDestroyed } : {}) };
    },
    "x:DkimSignature/get": get(dkimKeys, "sysDkimSignatureGet"),
    "x:DkimSignature/query": query(() => dkimKeys, "sysDkimSignatureQuery", ["domainId", "memberTenantId"], (o, f) => f.domainId === undefined || o.domainId === f.domainId),
    "x:DkimSignature/set": (a) => {
      const destroyed: string[] = [];
      for (const id of (a.destroy as string[]) ?? []) {
        demand("sysDkimSignatureDestroy");
        const i = dkimKeys.findIndex((k) => k.id === id);
        if (i >= 0) { dkimKeys.splice(i, 1); destroyed.push(id); }
      }
      if (a.create) throw opts.fail("forbidden", "The mock does not generate DKIM keys; automatic management does that.");
      return { accountId: opts.accountId, oldState: "1", newState: "2", created: {}, updated: {}, destroyed };
    },
    "x:DnsServer/get": (a) => {
      demand("sysDnsServerGet");
      return { accountId: opts.accountId, state: "1", list: ((a.ids as string[]) ?? ["ns1"]).filter((id) => id === "ns1").map((id) => ({ id, "@type": "Cloudflare", description: "Cloudflare (main zone)" })), notFound: [] };
    },
    "x:QueuedMessage/get": get(queue, "sysQueuedMessageGet"),
    "x:QueuedMessage/query": query(() => queue, "sysQueuedMessageQuery", [], () => true),
    "x:Metric/get": (a) => {
      refuseMetrics();
      return get(metrics, "sysMetricGet")(a);
    },
    // Ids sort the way timestamps do, so the helper's newest-first order is the
    // `timestamp` descending the dashboard asks for.
    "x:Metric/query": (a) => {
      refuseMetrics();
      return query(() => metrics, "sysMetricQuery", ["timestampIsGreaterThanOrEqual", "timestampIsLessThanOrEqual", "metric"], (o, f) =>
        (f.timestampIsGreaterThanOrEqual === undefined || String(o.timestamp) >= String(f.timestampIsGreaterThanOrEqual)) &&
        (f.timestampIsLessThanOrEqual === undefined || String(o.timestamp) <= String(f.timestampIsLessThanOrEqual)) &&
        (!Array.isArray(f.metric) || (f.metric as string[]).includes(o.metric as string)))(a);
    },
    "x:Role/get": get(roles, "sysRoleGet"),
    "x:Role/query": query(() => roles, "sysRoleQuery", ["text", "description", "memberTenantId"], (o, f) => matchText(o, f.description)),
  };

  return { handlers, permissions: [...permissions], accounts };
}

function flags(names: string[]): Obj {
  return Object.fromEntries(names.map((n) => [n, true]));
}

function splitAddress(address: string): [string, string] {
  const at = address.lastIndexOf("@");
  return at < 0 ? [address, "example.com"] : [address.slice(0, at), address.slice(at + 1)];
}

/**
 * Apply one JMAP patch entry. A path walks into nested objects; `null` at the
 * end removes the key, which is how an alias or a quota is taken away.
 */
function setPointer(obj: Obj, path: string, value: unknown): void {
  const parts = path.split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== "object") node[part] = {};
    node = node[part] as Obj;
  }
  const last = parts[parts.length - 1]!;
  if (value === null) delete node[last];
  else node[last] = value;
}
