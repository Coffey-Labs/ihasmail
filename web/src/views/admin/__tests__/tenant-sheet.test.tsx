import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";
import type { DirectoryTenant } from "@/lib/adminTenants";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  counts: { accounts: 1, groups: 0, lists: 0, domains: 1, roles: 0, dkimKeys: 2 } as Record<string, number>,
  onDomain: 0,
  updateTenant: vi.fn(async () => {}),
  setDomainTenant: vi.fn(async () => {}),
}));
vi.mock("@/lib/adminTenants", async (original) => ({
  ...(await original<typeof import("@/lib/adminTenants")>()),
  countTenantMembers: vi.fn(async () => api.counts),
  tenantDomains: vi.fn(async () => ({ inTenant: [{ id: "d3", name: "old-brand.example" }], unassigned: [{ id: "d4", name: "spare.example" }] })),
  updateTenant: api.updateTenant,
  setDomainTenant: api.setDomainTenant,
  tenantAccountsOnDomain: vi.fn(async () => api.onDomain),
}));

const { TenantSheet } = await import("../TenantSheet");

const tenant: DirectoryTenant = { id: "t1", name: "Acme Corp", logo: null, roles: { "@type": "Default" }, quotas: { maxAccounts: 25, maxDomains: 2, maxOauthClients: 3 }, usedDiskQuota: 0 };
const ALL = ["sysTenantGet", "sysTenantQuery", "sysTenantUpdate", "sysTenantDestroy", "sysDomainUpdate"];
const signIn = (permissions: string[]) =>
  useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "a@example.com", ihasmail: { permissions } } as unknown as JmapSession });
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label || b.textContent?.includes(label));
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the tenant sheet", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async () => {
    await act(async () => {
      root.render(<TenantSheet tenant={tenant} roles={new Map()} onClose={() => {}} onChanged={() => {}} onCreated={() => {}} onDeleted={() => {}} />);
    });
    await act(async () => {});
  };
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    api.updateTenant.mockClear();
    api.setDomainTenant.mockClear();
    api.counts = { accounts: 1, groups: 0, lists: 0, domains: 1, roles: 0, dkimKeys: 2 };
    api.onDomain = 0;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows what it holds against its limits, and will not delete while it holds anything", async () => {
    signIn(ALL);
    await render();
    expect(host.querySelector(".admin-kv")?.textContent).toContain("1 of 25");
    expect(button(host, "Delete tenant…")?.disabled).toBe(true);
  });

  it("offers the delete once it is empty", async () => {
    api.counts = { accounts: 0, groups: 0, lists: 0, domains: 0, roles: 0, dkimKeys: 0 };
    signIn(ALL);
    await render();
    expect(button(host, "Delete tenant…")?.disabled).toBe(false);
  });

  it("saves a changed limit as one pointer, and an emptied one as no limit", async () => {
    signIn(ALL);
    await render();
    await type(host.querySelector<HTMLInputElement>("#admin-tenant-maxAccounts")!, "30");
    await type(host.querySelector<HTMLInputElement>("#admin-tenant-maxDomains")!, "");
    await act(async () => button(host, "Save changes")!.click());
    expect(api.updateTenant).toHaveBeenCalledWith("t1", { "quotas/maxAccounts": 30, "quotas/maxDomains": null });
  });

  it("moves a domain in, and offers no domain moves without the permission to change domains", async () => {
    signIn(ALL);
    await render();
    await act(async () => button(host, "Add")!.click());
    expect(api.setDomainTenant).toHaveBeenCalledWith("d4", "t1");
    await act(async () => root.unmount());
    root = createRoot(host);
    signIn(["sysTenantGet", "sysTenantQuery"]);
    await render();
    expect(host.querySelector('select[aria-label="Domain to add"]')).toBeNull();
    expect(button(host, "Take old-brand.example out of the tenant")).toBeUndefined();
  });
});

describe("taking a domain out of a tenant", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    api.setDomainTenant.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("is refused while the tenant still has accounts on it, which Stalwart would strand", async () => {
    api.onDomain = 2;
    signIn(ALL);
    await act(async () => {
      root.render(<TenantSheet tenant={tenant} roles={new Map()} onClose={() => {}} onChanged={() => {}} onCreated={() => {}} onDeleted={() => {}} />);
    });
    await act(async () => {});
    await act(async () => button(host, "Take old-brand.example out of the tenant")!.click());
    expect(api.setDomainTenant).not.toHaveBeenCalled();
    expect(host.querySelector(".admin-notice.error")?.textContent).toContain("2 accounts in this tenant are still on old-brand.example");
  });
});
