import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";
import type { DirectoryRole } from "@/lib/admin/adminRoles";
import type { PermissionEntry } from "@/lib/permissionLabels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ updateRole: vi.fn(async () => {}) }));
vi.mock("@/lib/admin/adminRoles", async (original) => ({ ...(await original<typeof import("@/lib/admin/adminRoles")>()), updateRole: api.updateRole }));

const { RoleSheet } = await import("../RoleSheet");

const flags = (...n: string[]) => Object.fromEntries(n.map((x) => [x, true]));
const roles = new Map<string, DirectoryRole>([
  ["user", { id: "user", description: "User", enabledPermissions: flags("jmapEmailGet") }],
  ["help", { id: "help", description: "Helpdesk", enabledPermissions: flags("sysAccountGet"), roleIds: flags("user") }],
  ["admin", { id: "admin", description: "Admin", enabledPermissions: flags("sysTenantCreate") }],
]);
const entries: PermissionEntry[] = [
  { name: "jmapEmailGet", categoryKey: "JMAP", category: "JMAP", action: "Get emails" },
  { name: "sysAccountGet", categoryKey: "Accounts Management", category: "Accounts Management", action: "Get accounts" },
  { name: "sysAccountUpdate", categoryKey: "Accounts Management", category: "Accounts Management", action: "Update accounts" },
  { name: "sysTenantCreate", categoryKey: "Tenants Management", category: "Tenants Management", action: "Create tenants" },
];
const signIn = (permissions: string[]) =>
  useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "a@example.com", ihasmail: { permissions } } as unknown as JmapSession });
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.textContent?.includes(label));
const change = async (el: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("the role sheet", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async (role: DirectoryRole, defaults = null as { user: string[]; group: string[]; tenant: string[]; admin: string[] } | null) => {
    await act(async () => {
      root.render(<RoleSheet role={role} roles={roles} defaults={defaults} entries={entries} permissionsError={null} onClose={() => {}} onChanged={() => {}} onCreated={() => {}} onDeleted={() => {}} />);
    });
  };
  const VIEWER = ["sysRoleGet", "sysRoleQuery", "sysRoleUpdate", "sysRoleDestroy", "jmapEmailGet", "sysAccountGet", "sysAccountUpdate"];
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    api.updateRole.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows where an inherited permission comes from, and saves only the change as a pointer", async () => {
    signIn(VIEWER);
    await render(roles.get("help")!);
    await act(async () => button(host, "Accounts Management")!.click());
    await act(async () => button(host, "JMAP")!.click());
    expect(host.textContent).toContain("Granted by User");
    await change(host.querySelector<HTMLSelectElement>('select[aria-label="Update accounts"]')!, "allow");
    await change(host.querySelector<HTMLSelectElement>('select[aria-label="Get emails"]')!, "deny");
    await act(async () => button(host, "Save changes")!.click());
    expect(api.updateRole).toHaveBeenCalledWith("help", { "enabledPermissions/sysAccountUpdate": true, "disabledPermissions/jmapEmailGet": true });
  });

  it("will not let a viewer allow what they do not hold", async () => {
    signIn(VIEWER);
    await render(roles.get("help")!);
    await act(async () => button(host, "Tenants Management")!.click());
    const allow = host.querySelector<HTMLSelectElement>('select[aria-label="Create tenants"]')!.querySelector<HTMLOptionElement>('option[value="allow"]')!;
    expect(allow.disabled).toBe(true);
  });

  it("opens a role that outranks the viewer read-only, with no delete", async () => {
    signIn(VIEWER);
    await render(roles.get("admin")!);
    expect(host.textContent).toContain("This role carries permissions yours doesn't");
    expect(button(host, "Save changes")).toBeUndefined();
    expect(button(host, "Delete role…")?.disabled).toBe(true);
  });

  it("warns about a default role and will not delete it", async () => {
    signIn(VIEWER);
    await render(roles.get("user")!, { user: ["user"], group: [], tenant: [], admin: [] });
    expect(host.textContent).toContain("Stalwart gives this role by default to users");
    expect(button(host, "Delete role…")?.disabled).toBe(true);
  });
});
