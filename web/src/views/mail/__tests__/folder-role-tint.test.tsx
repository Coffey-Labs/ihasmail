import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxTree } from "../MailboxTree";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import type { Mailbox, MailboxRole } from "@/jmap/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

/*
 * Role folders get their own icon tint, read from the icon's data-role; a
 * plain folder has none, and a color the reader chose still applies.
 */

const rights = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true };
const box = (id: string, name: string, role: MailboxRole, unread = 0): Mailbox => ({
  id, name, parentId: null, role, sortOrder: 0, totalEmails: unread, unreadEmails: unread, totalThreads: unread, unreadThreads: unread, myRights: rights, isSubscribed: true,
});

describe("folder icons by role", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    window.history.replaceState({}, "", "/mail/inbox");
    useMail.setState({
      mailboxes: { inbox: box("inbox", "Inbox", "inbox", 3), junk: box("junk", "Junk", "junk", 1), work: box("work", "Work", null, 2) },
      mailboxesLoaded: true,
    });
    useSettings.setState((s) => ({ settings: { ...s.settings, showHiddenFolders: false, labelsSidebar: false, folderColors: { junk: "#123456" } } }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<MailboxTree />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const icons = () => Array.from(document.querySelectorAll<HTMLElement>(".nav-item.folder-row .folder-icon"));
  const byRole = (role: string) => icons().find((i) => i.dataset.role === role)!;

  it("marks role folders with their role and leaves a plain folder unmarked", () => {
    expect(icons().map((i) => i.dataset.role ?? null).sort()).toEqual(["inbox", "junk", null].sort());
  });

  it("keeps the reader's own color on a role folder", () => {
    expect(byRole("junk").style.getPropertyValue("--folder-color")).toBe("#123456");
  });

  it("shows unread counts as pills", () => {
    const pill = Array.from(document.querySelectorAll(".nav-item.folder-row.unread .nav-count")).map((p) => p.textContent);
    expect(pill).toEqual(expect.arrayContaining(["3", "1", "2"]));
  });
});
