import { describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { countTenantMembers, drawableLogo, quotasPatch, setDomainTenant } from "@/lib/adminTenants";

describe("a tenant's limits", () => {
  it("change one pointer each, leaving the quotas ihasmail does not offer alone", () => {
    const before = { maxAccounts: 25, maxDomains: 2, maxOauthClients: 7 };
    expect(quotasPatch(before, { maxAccounts: 30, maxDomains: null, maxGroups: 5, maxRoles: null })).toEqual({
      "quotas/maxAccounts": 30,
      "quotas/maxDomains": null,
      "quotas/maxGroups": 5,
    });
    expect(quotasPatch(before, { maxAccounts: 25 })).toEqual({});
  });
});

describe("what a tenant holds", () => {
  it("is counted with a memberTenantId filter per kind, users and groups apart", async () => {
    const call = vi.spyOn(client, "call").mockImplementation(async (method, args) => {
      const f = (args as { filter: Record<string, unknown> }).filter;
      if (method === "x:Role/query") throw new Error("forbidden");
      return { total: method === "x:Account/query" && f["@type"] === "Group" ? 2 : 1 };
    });
    expect(await countTenantMembers("t1")).toEqual({ accounts: 1, groups: 2, lists: 1, domains: 1 });
    expect(call).toHaveBeenCalledWith("x:Account/query", { filter: { "@type": "User", memberTenantId: "t1" }, limit: 0, calculateTotal: true });
    expect(call).toHaveBeenCalledWith("x:Domain/query", { filter: { memberTenantId: "t1" }, limit: 0, calculateTotal: true });
    call.mockRestore();
  });

  it("moves a domain in and out by its memberTenantId", async () => {
    const call = vi.spyOn(client, "call").mockResolvedValue({ updated: { d4: null } });
    await setDomainTenant("d4", "t1");
    expect(call).toHaveBeenLastCalledWith("x:Domain/set", { update: { d4: { memberTenantId: "t1" } } });
    await setDomainTenant("d4", null);
    expect(call).toHaveBeenLastCalledWith("x:Domain/set", { update: { d4: { memberTenantId: null } } });
    call.mockRestore();
  });
});

describe("a tenant's logo", () => {
  it("is drawn only from https or an image data URL", () => {
    expect(drawableLogo("https://example.com/logo.png")).toBe("https://example.com/logo.png");
    expect(drawableLogo("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(drawableLogo("http://example.com/logo.png")).toBeNull();
    expect(drawableLogo("javascript:alert(1)")).toBeNull();
    expect(drawableLogo("data:text/html;base64,AAAA")).toBeNull();
    expect(drawableLogo(null)).toBeNull();
  });
});
