import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";
import type { DirectoryAccount } from "@/lib/admin/adminDirectory";
import { AccountSheet } from "../AccountSheet";
import type { DirectoryContext } from "../directoryContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HELPDESK = ["sysAccountGet", "sysAccountQuery", "sysAccountUpdate"];

function signIn(permissions: string[], username = "sam@example.com") {
  useSession.setState({
    session: { capabilities: {}, accounts: {}, primaryAccounts: { "urn:stalwart:jmap": "self" }, username, ihasmail: { permissions } } as unknown as JmapSession,
  });
}

const account = (over: Partial<DirectoryAccount>): DirectoryAccount => ({
  id: "u1",
  "@type": "User",
  name: "ada",
  domainId: "d1",
  emailAddress: "ada@example.com",
  description: "Ada Lovelace",
  roles: { "@type": "User" },
  credentials: { "0": { "@type": "Password", secret: "[********]" } },
  ...over,
});

const ctx: DirectoryContext = { domains: [{ id: "d1", name: "example.com" }], roles: null, groups: new Map(), self: { ids: new Set(["self"]), address: "sam@example.com" } };

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

/**
 * The guards that stand in for checks Stalwart does not make. A store test
 * cannot see these: they are what the sheet renders, and what it leaves out.
 */
describe("the account sheet", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (a: DirectoryAccount) => {
    const { hook } = memoryLocation({ path: `/admin/accounts/${a.id}` });
    await act(async () => {
      root.render(
        <Router hook={hook}>
          <AccountSheet account={a} ctx={ctx} onClose={() => {}} onChanged={() => {}} onCreated={() => {}} onDeleted={() => {}} />
        </Router>,
      );
    });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows an account that outranks the viewer read-only, password included", async () => {
    signIn(HELPDESK);
    await render(account({ roles: { "@type": "Admin" } }));
    expect(host.textContent).toContain("permissions yours doesn't");
    expect(button(host, "Set a new password")?.disabled).toBe(true);
    expect((host.querySelector("#admin-description") as HTMLInputElement).disabled).toBe(true);
    expect(host.textContent).not.toContain("Save changes");
  });

  it("lets the same viewer edit an ordinary account, but not delete it", async () => {
    signIn(HELPDESK);
    await render(account({}));
    expect(button(host, "Set a new password")?.disabled).toBe(false);
    expect(host.textContent).toContain("Save changes");
    expect(host.textContent).not.toContain("Delete account");
  });

  it("sends your own password to Settings, and keeps your role and account out of reach", async () => {
    signIn([...HELPDESK, "sysAccountDestroy"]);
    await render(account({ id: "self", emailAddress: "sam@example.com" }));
    expect(host.textContent).toContain("Change your own password in");
    expect(host.querySelector('a[href="/settings/security"]')).not.toBeNull();
    expect(button(host, "Set a new password")).toBeUndefined();
    expect((host.querySelector('select[aria-label="Role"]') as HTMLSelectElement).disabled).toBe(true);
    expect(button(host, "Delete account")?.disabled).toBe(true);
  });
});

/**
 * An account in a tenant has to be on a domain in that tenant -- the live
 * server refuses anything else -- so the only tenant offered is the domain's.
 */
describe("an account's tenant", () => {
  let host: HTMLDivElement;
  let root: Root;
  const tenantCtx: DirectoryContext = {
    ...ctx,
    domains: [{ id: "d1", name: "example.com", memberTenantId: null }, { id: "d3", name: "acme.example", memberTenantId: "t1" }],
    tenants: [{ id: "t1", name: "Acme Corp" }, { id: "t2", name: "Globex" }],
  };
  const render = async (a: DirectoryAccount) => {
    const { hook } = memoryLocation({ path: `/admin/accounts/${a.id}` });
    await act(async () => {
      root.render(<Router hook={hook}><AccountSheet account={a} ctx={tenantCtx} onClose={() => {}} onChanged={() => {}} onCreated={() => {}} onDeleted={() => {}} /></Router>);
    });
  };
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("offers only the tenant its domain is in", async () => {
    signIn([...HELPDESK, "sysTenantGet", "sysTenantQuery"]);
    await render(account({ domainId: "d3", memberTenantId: "t1", emailAddress: "wile@acme.example" }));
    const options = [...host.querySelectorAll<HTMLOptionElement>('select[aria-label="Tenant"] option')].map((o) => o.textContent);
    expect(options).toEqual(["No tenant", "Acme Corp"]);
  });

  it("offers no choice at all on a domain in no tenant", async () => {
    signIn([...HELPDESK, "sysTenantGet", "sysTenantQuery"]);
    await render(account({ domainId: "d1" }));
    expect(host.querySelector('select[aria-label="Tenant"]')).toBeNull();
  });
});
