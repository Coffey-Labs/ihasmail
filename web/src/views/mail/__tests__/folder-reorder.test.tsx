import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxTree } from "../MailboxTree";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import type { Mailbox, MailboxRole } from "@/jmap/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Reordering folders in the sidebar (#402), driven through the real tree.
 *
 * The placement arithmetic has its own tests in lib/mailbox; these are about
 * the row deciding where a drop lands from where the pointer is, which only
 * the component knows.
 */

window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const rights = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true };
const box = (id: string, name: string, parentId: string | null, role: MailboxRole = null): Mailbox => ({
  id, name, parentId, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rights, isSubscribed: true,
});

const MAILBOXES = {
  zeta: box("zeta", "Zeta", null),
  trash: box("trash", "Deleted Items", null, "trash"),
  sent: box("sent", "Sent", null, "sent"),
  inbox: box("inbox", "Inbox", null, "inbox"),
  alpha: box("alpha", "Alpha", null),
  drafts: box("drafts", "Drafts", null, "drafts"),
};

/** jsdom has no DataTransfer; this is the part of one the tree touches. */
function transfer() {
  const data: Record<string, string> = {};
  return {
    get types() { return Object.keys(data); },
    setData: (k: string, v: string) => { data[k] = v; },
    getData: (k: string) => data[k] ?? "",
    effectAllowed: "", dropEffect: "",
  };
}

function fire(el: Element, type: string, dataTransfer: ReturnType<typeof transfer>, clientY = 0) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { dataTransfer, clientY });
  act(() => { el.dispatchEvent(e); });
}

describe("reordering folders in the tree", () => {
  let host: HTMLDivElement;
  let root: Root;
  const arrange = vi.fn(async (_updates: Record<string, Partial<Mailbox>>) => {});
  const updateMailbox = vi.fn(async (_id: string, _patch: Partial<Mailbox>) => {});
  const rows = () => Array.from(document.querySelectorAll(".nav-item.folder-row")).map((r) => r.querySelector(".nav-label")?.textContent);
  const rowFor = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".nav-item.folder-row")).find((r) => r.querySelector(".nav-label")?.textContent === name)!;

  /** Drag `from` over `to` at a fraction of its height, drop, and say what the row showed. */
  function drag(from: string, to: string, frac: number) {
    const dt = transfer();
    const target = rowFor(to);
    // Every row is 36px tall, from 100px down the page.
    target.getBoundingClientRect = () => ({ top: 100, height: 36, bottom: 136, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON() {} });
    fire(rowFor(from), "dragstart", dt);
    fire(target, "dragover", dt, 100 + 36 * frac);
    const shown = /drop-(before|after|target)/.exec(target.className)?.[1] ?? null;
    fire(target, "drop", dt, 100 + 36 * frac);
    return shown;
  }

  beforeEach(() => {
    arrange.mockClear();
    updateMailbox.mockClear();
    window.history.replaceState({}, "", "/mail/inbox");
    useMail.setState({ mailboxes: MAILBOXES, mailboxesLoaded: true, arrangeMailboxes: arrange, updateMailbox });
    useSettings.setState((s) => ({ settings: { ...s.settings, showHiddenFolders: false, labelsSidebar: false } }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<MailboxTree />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("lists special folders under Inbox before the rest, until something is dragged", () => {
    expect(rows()).toEqual(["Inbox", "Drafts", "Sent", "Deleted Items", "Alpha", "Zeta"]);
  });

  it("puts a folder above the row when it's dropped on the row's top edge", () => {
    expect(drag("Zeta", "Drafts", 0.1)).toBe("before");
    expect(arrange).toHaveBeenCalledWith({
      zeta: { sortOrder: 20 }, drafts: { sortOrder: 30 }, sent: { sortOrder: 40 }, trash: { sortOrder: 50 }, alpha: { sortOrder: 60 }, inbox: { sortOrder: 10 },
    });
  });

  it("nests a folder dropped on the middle of an ordinary folder, as before", () => {
    expect(drag("Zeta", "Alpha", 0.5)).toBe("target");
    expect(updateMailbox).toHaveBeenCalledWith("zeta", { parentId: "alpha" });
    expect(arrange).not.toHaveBeenCalled();
  });

  it("reorders a special folder by the nearer half, since it can't be nested", () => {
    expect(drag("Deleted Items", "Drafts", 0.4)).toBe("before");
    expect(Object.keys(arrange.mock.calls[0]![0])).toContain("trash");
  });

  it("drops nothing above Inbox", () => {
    expect(drag("Sent", "Inbox", 0.1)).toBeNull();
    expect(arrange).not.toHaveBeenCalled();
  });
});
