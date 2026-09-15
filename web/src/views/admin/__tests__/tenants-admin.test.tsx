import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ queryTenants: vi.fn(async () => ({ ids: ["t1"], total: 1 })) }));
vi.mock("@/lib/adminTenants", async (original) => ({
  ...(await original<typeof import("@/lib/adminTenants")>()),
  queryTenants: api.queryTenants,
  getTenants: vi.fn(async () => [{ id: "t1", name: "Acme Corp", quotas: {}, usedDiskQuota: 0 }]),
}));

const { TenantsAdmin } = await import("../TenantsAdmin");

const PERMS = ["sysTenantGet", "sysTenantQuery", "sysTenantCreate"];
const signIn = (edition: string | null) =>
  useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "a@example.com", ihasmail: { permissions: PERMS, server: { edition } } } as unknown as JmapSession });

/** Tenants are managed on Enterprise only; anywhere else the page is the notice and nothing more. */
describe("the Tenants page", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async () => {
    const { hook } = memoryLocation({ path: "/admin/tenants" });
    await act(async () => {
      root.render(<Router hook={hook}><TenantsAdmin /></Router>);
    });
    await act(async () => {});
  };
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    api.queryTenants.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  for (const edition of ["community", "oss", null]) {
    it(`shows only the notice on ${edition ?? "a server that reports no edition"}`, async () => {
      signIn(edition);
      await render();
      expect(host.querySelector(".admin-notice.warn")?.textContent).toContain("Tenants are a Stalwart Enterprise feature");
      expect(host.textContent).not.toContain("New tenant");
      expect(host.querySelector('input[type="search"]')).toBeNull();
      expect(host.querySelector(".admin-table")).toBeNull();
      expect(api.queryTenants).not.toHaveBeenCalled();
    });
  }

  it("lists and offers tenants on Enterprise, without the notice", async () => {
    signIn("enterprise");
    await render();
    expect(host.querySelector(".admin-notice.warn")).toBeNull();
    expect(host.textContent).toContain("New tenant");
    expect(host.querySelector(".admin-table")?.textContent).toContain("Acme Corp");
  });
});
