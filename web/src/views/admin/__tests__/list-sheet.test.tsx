import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/store/session";
import type { JmapSession } from "@/jmap/types";
import type { DirectoryList } from "@/lib/adminLists";
import type { DirectoryContext } from "../directoryContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ updateList: vi.fn(async () => {}) }));
vi.mock("@/lib/adminLists", async (original) => ({ ...(await original<typeof import("@/lib/adminLists")>()), updateList: api.updateList }));

const { ListSheet } = await import("../ListSheet");

const list: DirectoryList = { id: "l1", name: "announce", domainId: "d1", emailAddress: "announce@example.com", description: "Announcements", recipients: { "ada@example.org": true, "grace@example.org": true }, aliases: {} };
const ctx: DirectoryContext = { domains: [{ id: "d1", name: "example.com" }], roles: null, groups: new Map(), self: { ids: new Set(), address: "demo@example.com" } };
const signIn = (permissions: string[]) =>
  useSession.setState({ session: { capabilities: {}, accounts: {}, primaryAccounts: {}, username: "demo@example.com", ihasmail: { permissions } } as unknown as JmapSession });
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the mailing list sheet", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async () => {
    await act(async () => {
      root.render(<ListSheet list={list} ctx={ctx} onClose={() => {}} onChanged={() => {}} onCreated={() => {}} onDeleted={() => {}} />);
    });
  };
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    api.updateList.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("saves only the recipients added and removed, and says what it could not read", async () => {
    signIn(["sysMailingListGet", "sysMailingListQuery", "sysMailingListUpdate"]);
    await render();
    await act(async () => button(host, "Remove ada@example.org")!.click());
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Add recipients"]')!, "Bob <bob@elsewhere.test>, oops@");
    await act(async () => button(host, "Add")!.click());
    expect(host.querySelector(".admin-notice.warn")?.textContent).toContain("oops@");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Add recipients"]')!.value).toBe("oops@");
    await act(async () => button(host, "Save changes")!.click());
    expect(api.updateList).toHaveBeenCalledWith("l1", { "recipients/ada@example.org": null, "recipients/bob@elsewhere.test": true });
  });

  it("offers nothing to change to a role that can only read, and no delete without the permission", async () => {
    signIn(["sysMailingListGet", "sysMailingListQuery"]);
    await render();
    expect(host.textContent).toContain("Your role lets you view mailing lists but not change them.");
    expect(button(host, "Remove ada@example.org")).toBeUndefined();
    expect(host.querySelector('input[aria-label="Add recipients"]')).toBeNull();
    expect(button(host, "Delete list…")).toBeUndefined();
  });
});
