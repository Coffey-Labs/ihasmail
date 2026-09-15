import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";
import type { DirectoryGroup } from "@/lib/adminGroups";
import type { DirectoryContext } from "../directoryContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  members: [
    { id: "me", name: "demo", emailAddress: "demo@example.com", description: "Demo User" },
    { id: "u2", name: "ada", emailAddress: "ada@example.com", description: "Ada Lovelace" },
  ],
  setMembership: vi.fn(async () => {}),
  destroyGroup: vi.fn(async () => {}),
}));

vi.mock("@/lib/adminGroups", async (original) => ({
  ...(await original<typeof import("@/lib/adminGroups")>()),
  listMembers: vi.fn(async () => ({ members: api.members, total: api.members.length })),
  searchUsers: vi.fn(async () => []),
  setMembership: api.setMembership,
  destroyGroup: api.destroyGroup,
}));

const { GroupSheet } = await import("../GroupSheet");

const group: DirectoryGroup = { id: "g1", "@type": "Group", name: "support", domainId: "d1", emailAddress: "support@example.com", description: "Support", roles: { "@type": "Default" }, aliases: {} };
const ctx: DirectoryContext = { domains: [{ id: "d1", name: "example.com" }], roles: new Map(), groups: new Map(), self: { ids: new Set(["me"]), address: "demo@example.com" } };

const signIn = (permissions: string[]) =>
  useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "demo@example.com", ihasmail: { permissions } } as unknown as JmapSession });

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.includes(label));

/** The group panel's guards: what a role may change, and what nobody may change for themselves. */
describe("the group sheet", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async () => {
    await act(async () => {
      root.render(<GroupSheet group={group} ctx={ctx} onClose={() => {}} onChanged={() => {}} onCreated={() => {}} onDeleted={() => {}} />);
    });
    await act(async () => {});
  };
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    api.setMembership.mockClear();
    api.destroyGroup.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("lists the members, and will not take the viewer out of a group themselves", async () => {
    signIn(["sysAccountGet", "sysAccountQuery", "sysAccountUpdate"]);
    await render();
    expect(host.querySelectorAll(".admin-members li")).toHaveLength(2);
    expect(button(host, "Remove demo@example.com from the group")?.disabled).toBe(true);
    const ada = button(host, "Remove ada@example.com from the group")!;
    expect(ada.disabled).toBe(false);
    await act(async () => ada.click());
    expect(api.setMembership).toHaveBeenCalledWith(["u2"], "g1", false);
  });

  it("offers no changes to a role that can only read", async () => {
    signIn(["sysAccountGet", "sysAccountQuery"]);
    await render();
    expect(host.textContent).toContain("Your role lets you view groups but not change them.");
    expect(button(host, "Remove ada@example.com from the group")).toBeUndefined();
    expect(host.querySelector(".admin-add-member")).toBeNull();
    expect(button(host, "Save changes")).toBeUndefined();
  });

  it("will not start a delete it could only half finish", async () => {
    // Deleting takes the members out first, which is an update to each of them.
    signIn(["sysAccountGet", "sysAccountQuery", "sysAccountDestroy"]);
    await render();
    expect(button(host, "Delete group…")?.disabled).toBe(true);
    expect(host.querySelector(".admin-danger")?.textContent).toContain("your role can't change their accounts");
  });

  it("deletes with every member taken out, once the address is typed", async () => {
    signIn(["sysAccountGet", "sysAccountQuery", "sysAccountUpdate", "sysAccountDestroy"]);
    await render();
    await act(async () => button(host, "Delete group…")!.click());
    const input = document.querySelector<HTMLInputElement>("#admin-group-delete-confirm")!;
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Delete group")!;
    expect(confirm.disabled).toBe(true);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "support@example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(api.destroyGroup).toHaveBeenCalledWith("g1", ["me", "u2"]);
  });
});
