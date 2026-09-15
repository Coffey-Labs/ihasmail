import { describe, expect, it } from "vitest";
import { ADMIN_BASELINE, adminSections, can, dashboardCards, canGrantRole, generatePassword, hasAdministration, outranks, permissionSet, resolveRoles, type RoleDef } from "@/lib/adminAccess";

const set = (...p: string[]) => permissionSet(p);
const everything = set(...ADMIN_BASELINE, "sysTenantGet", "jmapEmailGet", "impersonate");
const helpdesk = set("sysAccountGet", "sysAccountQuery", "sysAccountUpdate", "jmapEmailGet");
const roles = new Map<string, RoleDef>([
  ["user", { id: "user", enabledPermissions: { jmapEmailGet: true } }],
  ["helpdesk", { id: "helpdesk", enabledPermissions: { sysAccountGet: true, sysAccountQuery: true, sysAccountUpdate: true }, roleIds: { user: true } }],
  ["dns", { id: "dns", enabledPermissions: { sysDnsServerUpdate: true }, roleIds: { user: true } }],
  ["loop", { id: "loop", enabledPermissions: {}, roleIds: { loop: true } }],
]);

describe("who is offered administration", () => {
  it("needs both halves of reading the account list to list accounts", () => {
    expect(adminSections(set("sysAccountQuery", "sysAccountGet"))).toEqual(["dashboard", "accounts"]);
    // A query alone is a count on the dashboard, not a list.
    expect(adminSections(set("sysAccountQuery"))).toEqual(["dashboard"]);
    expect(hasAdministration(set("sysAccountGet"))).toBe(false);
    expect(hasAdministration(permissionSet(undefined))).toBe(false);
  });

  it("offers each section only with both halves of reading it", () => {
    expect(adminSections(set("sysDomainQuery", "sysDomainGet"))).toEqual(["dashboard", "domains"]);
    expect(hasAdministration(set("sysDomainQuery", "sysDomainGet"))).toBe(true);
    expect(adminSections(set("sysAccountQuery", "sysAccountGet", "sysDomainQuery"))).toEqual(["dashboard", "accounts"]);
  });

  it("gives the dashboard a card for each number the role can read", () => {
    expect(dashboardCards(set("sysAccountQuery", "sysAccountGet", "sysDomainQuery", "sysDomainGet"))).toEqual(["users", "domains"]);
    expect(dashboardCards(set("sysQueuedMessageQuery"))).toEqual(["pending"]);
    // The history takes its get as well: the query only finds the records.
    expect(dashboardCards(set("sysMetricQuery"))).toEqual([]);
    expect(dashboardCards(set("sysMetricQuery", "sysMetricGet"))).toEqual(["memory", "received", "sent"]);
    expect(adminSections(set("jmapEmailGet"))).toEqual([]);
  });

  it("reads one permission per object and operation", () => {
    expect(can(helpdesk, "Account", "Update")).toBe(true);
    expect(can(helpdesk, "Account", "Destroy")).toBe(false);
    expect(can(helpdesk, "Domain", "Get")).toBe(false);
  });
});

/**
 * Stalwart checks a grant, but not a password change or a delete. Without this,
 * anyone allowed to edit accounts could take over one that can do more.
 */
describe("an account that outranks the viewer", () => {
  it("an ordinary user never does", () => {
    expect(outranks(helpdesk, { roles: { "@type": "User" } }, null)).toBe(false);
    expect(outranks(helpdesk, {}, null)).toBe(false);
  });

  it("an administrator does, unless the viewer is one too", () => {
    expect(outranks(helpdesk, { roles: { "@type": "Admin" } }, roles)).toBe(true);
    expect(outranks(everything, { roles: { "@type": "Admin" } }, roles)).toBe(false);
  });

  it("a custom role does when it carries something the viewer lacks", () => {
    expect(outranks(helpdesk, { roles: { "@type": "Custom", roleIds: { helpdesk: true } } }, roles)).toBe(false);
    expect(outranks(helpdesk, { roles: { "@type": "Custom", roleIds: { dns: true } } }, roles)).toBe(true);
  });

  it("a role that cannot be read counts against the target, not for it", () => {
    expect(outranks(helpdesk, { roles: { "@type": "Custom", roleIds: { helpdesk: true } } }, null)).toBe(true);
    expect(outranks(everything, { roles: { "@type": "Custom", roleIds: { gone: true } } }, roles)).toBe(true);
  });

  it("extra permissions on the account itself are counted", () => {
    expect(outranks(helpdesk, { roles: { "@type": "User" }, permissions: { "@type": "Merge", enabledPermissions: { sysDomainDestroy: true } } }, roles)).toBe(true);
    // Replace ignores the roles entirely, so only what it lists matters.
    expect(outranks(helpdesk, { roles: { "@type": "Custom", roleIds: { dns: true } }, permissions: { "@type": "Replace", enabledPermissions: { jmapEmailGet: true } } }, roles)).toBe(false);
  });

  it("survives a role that names itself", () => {
    expect(resolveRoles(["loop"], roles)).toEqual(new Set());
  });
});

describe("granting a role", () => {
  it("is offered only for roles whose every permission the viewer holds", () => {
    expect(canGrantRole(helpdesk, "helpdesk", roles)).toBe(true);
    expect(canGrantRole(helpdesk, "dns", roles)).toBe(false);
    expect(canGrantRole(everything, "missing", roles)).toBe(false);
  });
});

describe("generated passwords", () => {
  it("are four groups of five unambiguous characters", () => {
    const p = generatePassword();
    expect(p).toMatch(/^[a-zA-Z2-9]{5}(-[a-zA-Z2-9]{5}){3}$/);
    expect(p).not.toMatch(/[01lIO]/);
  });

  it("skip bytes that would favour the start of the alphabet", () => {
    // 256 % 55 leaves 36 byte values over; a plain modulo would hand those to
    // the first 36 characters twice as often. Bytes of 220 and up are dropped
    // and more are drawn, so a batch of nothing but those costs a draw.
    let call = 0;
    const source = (n: number) => (call++ === 0 ? new Uint8Array(n).fill(250) : Uint8Array.from({ length: n }, (_, i) => i));
    expect(generatePassword(source)).toBe("abcde-fghjk-mnpqr-stuvw");
    expect(call).toBe(2);
  });
});
