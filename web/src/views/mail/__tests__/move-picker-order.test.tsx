import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxPicker } from "../MailboxPicker";
import { useMail } from "@/store/mail";
import type { Mailbox, MailboxRole } from "@/jmap/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The move-to picker (v) lists folders in the sidebar's order (#1 on GitLab).
 *
 * It used to sort A–Z by path, so a folder dragged into place in the sidebar
 * turned up somewhere else here. The ordering has its own tests in
 * lib/mailbox; these check what the dialog actually shows.
 */

window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const rights = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true };
const box = (id: string, name: string, parentId: string | null, role: MailboxRole = null, sortOrder = 0): Mailbox => ({
  id, name, parentId, role, sortOrder, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rights, isSubscribed: true,
});

/** Ordered by hand in the sidebar: Zeta dragged to the top, Alpha to the bottom. */
const MAILBOXES = {
  inbox: box("inbox", "Inbox", null, "inbox", 10),
  zeta: box("zeta", "Zeta", null, null, 20),
  sent: box("sent", "Sent", null, "sent", 30),
  work: box("work", "Work", null, null, 40),
  clients: box("clients", "Clients", "work"),
  trash: box("trash", "Deleted Items", null, "trash", 50),
  alpha: box("alpha", "Alpha", null, null, 60),
};

describe("the move-to picker", () => {
  let host: HTMLDivElement;
  let root: Root;
  const rows = () => Array.from(document.querySelectorAll('[role="option"]')).map((r) => r.querySelector(".grow")?.textContent);

  function open(props: Partial<Parameters<typeof MailboxPicker>[0]> = {}) {
    act(() => root.render(<MailboxPicker title="Move to…" onClose={() => {}} onPick={() => {}} {...props} />));
  }

  beforeEach(() => {
    useMail.setState({ mailboxes: MAILBOXES, mailboxesLoaded: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("lists folders in the order they were dragged into, not A–Z", () => {
    open();
    expect(rows()).toEqual(["Inbox", "Zeta", "Sent", "Work", "Work / Clients", "Deleted Items", "Alpha"]);
  });

  it("keeps that order for the folders left after excluding one", () => {
    open({ exclude: ["work"] });
    expect(rows()).toEqual(["Inbox", "Zeta", "Sent", "Work / Clients", "Deleted Items", "Alpha"]);
  });
});
