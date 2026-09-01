import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxTree } from "../MailboxTree";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import type { Mailbox, MailboxRole } from "@/jmap/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no matchMedia, and the whole question here is which side of the
 * 768px breakpoint we are on — so it is stubbed rather than skipped, and each
 * test says which width it is standing at.
 */
function setWidth(px: number) {
  window.matchMedia = ((q: string) => ({
    matches: /max-width:\s*(\d+)px/.test(q) ? px <= Number(RegExp.$1) : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

const rights = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true };
const box = (id: string, name: string, parentId: string | null, unread = 0, role: MailboxRole = null): Mailbox => ({
  id, name, parentId, role, sortOrder: 0, totalEmails: unread, unreadEmails: unread, totalThreads: unread, unreadThreads: unread, myRights: rights, isSubscribed: true,
});

/*
 * Inbox, then Work > Clients > Acme. Three levels is the shape the flat tree
 * handled badly in a 300px drawer, and the one the drill has to walk.
 */
const MAILBOXES = {
  inbox: box("inbox", "Inbox", null, 2, "inbox"),
  work: box("work", "Work", null, 1),
  clients: box("clients", "Clients", "work", 3),
  acme: box("acme", "Acme Corp", "clients", 4),
  sent: box("sent", "Sent", null, 0, "sent"),
};

describe("folder drill-down", () => {
  let host: HTMLDivElement;
  let root: Root;
  const rows = () => Array.from(document.querySelectorAll(".nav-item.folder-row")).map((r) => r.querySelector(".nav-label")?.textContent);
  const rowFor = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".nav-item.folder-row")).find((r) => r.querySelector(".nav-label")?.textContent === name);
  const drillInto = (name: string) => act(() => { rowFor(name)!.querySelector<HTMLElement>(".drill-into")!.click(); });
  const back = () => act(() => { document.querySelector<HTMLElement>(".drill-back")!.click(); });

  const mount = () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<MailboxTree />));
  };

  beforeEach(() => {
    window.history.replaceState({}, "", "/mail/inbox");
    useMail.setState({ mailboxes: MAILBOXES, mailboxesLoaded: true });
    useSettings.setState((s) => ({ settings: { ...s.settings, showHiddenFolders: false, labelsSidebar: false } }));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("shows the whole tree on a wide screen, and no drill controls", () => {
    setWidth(1280);
    mount();
    expect(rows()).toEqual(["Inbox", "Sent", "Work"]);
    expect(document.querySelector(".drill-into")).toBeNull();
    expect(document.querySelector(".drill-back")).toBeNull();
    // The twisty is what expands a folder in place, and it is still there.
    expect(rowFor("Work")!.querySelector('.nav-twisty[role="button"]')).not.toBeNull();
  });

  it("shows one level at a time on a phone, deepest folders included", () => {
    setWidth(390);
    mount();
    expect(rows()).toEqual(["Inbox", "Sent", "Work"]);
    // Only a folder with children offers the drill, and it replaces the twisty.
    expect(rowFor("Work")!.querySelector(".drill-into")).not.toBeNull();
    expect(rowFor("Work")!.querySelector('.nav-twisty[role="button"]')).toBeNull();
    expect(rowFor("Inbox")!.querySelector(".drill-into")).toBeNull();

    drillInto("Work");
    // The folder drilled into is listed with its children, because it is still
    // a folder you can open — going back out to reach it would be absurd.
    expect(rows()).toEqual(["Work", "Clients"]);
    expect(document.querySelector(".drill-back")!.textContent).toContain("Folders");

    drillInto("Clients");
    expect(rows()).toEqual(["Clients", "Acme Corp"]);
    expect(document.querySelector(".drill-back")!.textContent).toContain("Work");
  });

  /*
   * jsdom has no layout to measure, so this asserts the mechanism the
   * alignment hangs off instead: the indent is dropped for the whole list, by
   * a class on the nav. The first cut put it on the rows offering a drill,
   * which meant only folders with children lost the twisty's 30px gutter and
   * they hung 18px left of every folder without any.
   */
  it("hangs every folder off the same edge, children or not", () => {
    setWidth(390);
    mount();
    expect(document.querySelector("nav")!.className).toContain("folder-drill");
    const depths = Array.from(document.querySelectorAll(".nav-item.folder-row")).map((r) => r.className.match(/depth-\d/)?.[0]);
    expect(depths).toEqual(["depth-0", "depth-0", "depth-0"]);

    drillInto("Work");
    // Work has a child and Clients does not; neither may be indented for it.
    expect(Array.from(document.querySelectorAll(".nav-item.folder-row")).map((r) => r.className.match(/depth-\d/)?.[0])).toEqual(["depth-0", "depth-0"]);
    expect(document.querySelector(".nav-item.folder-row.has-drill")).toBeNull();
  });

  it("keeps the indent on a wide screen, where the tree still needs it", () => {
    setWidth(1280);
    mount();
    expect(document.querySelector("nav")!.className).not.toContain("folder-drill");
    act(() => { rowFor("Work")!.querySelector<HTMLElement>(".nav-twisty")!.click(); });
    expect(rowFor("Clients")!.className).toContain("depth-1");
  });

  it("walks back out one level per tap", () => {
    setWidth(390);
    mount();
    drillInto("Work");
    drillInto("Clients");
    back();
    expect(rows()).toEqual(["Work", "Clients"]);
    back();
    expect(rows()).toEqual(["Inbox", "Sent", "Work"]);
    expect(document.querySelector(".drill-back")).toBeNull();
  });

  it("counts the unread hiding below a folder you have not drilled into", () => {
    setWidth(390);
    mount();
    // Work: 1 of its own, plus Clients' 3 and Acme's 4 out of sight.
    expect(rowFor("Work")!.querySelector(".nav-count")!.textContent).toBe("8");
    drillInto("Work");
    // Drilled in, Work speaks only for itself and Clients carries its own subtree.
    expect(rowFor("Work")!.querySelector(".nav-count")!.textContent).toBe("1");
    expect(rowFor("Clients")!.querySelector(".nav-count")!.textContent).toBe("7");
  });

  it("opens at the level of the folder being read, not back at the root", () => {
    setWidth(390);
    window.history.replaceState({}, "", "/mail/acme");
    mount();
    // Reading Acme Corp, the drawer comes back inside Clients where it lives.
    expect(rows()).toEqual(["Clients", "Acme Corp"]);
    expect(rowFor("Acme Corp")!.className).toContain("active");
  });
});
