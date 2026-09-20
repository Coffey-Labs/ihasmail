import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadView } from "../ThreadView";
import { useMail } from "@/store/mail";
import type { ListActions } from "../MessageList";
import type { Email, Id } from "@/jmap/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* jsdom has neither of these, and the opening scroll uses both. */
Element.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

/* jsdom has no matchMedia, and the toolbar asks whether this is a phone. */
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

/*
 * Reported from the inbox with conversation view off: marking a message unread
 * from the list -- hover button, right-click menu -- touched that message, but
 * the same action from the toolbar above the *opened* message marked every
 * message in its thread. Move to, Report spam and Delete did it too (#414).
 *
 * The toolbar's labels were already right: "Mark as unread" read the messages
 * on screen. Only the ids it handed the action named the whole thread.
 */

const msg = (id: Id, subject: string): Email =>
  ({
    id, threadId: "t1", subject, mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: "Ann", email: "ann@example.com" }], to: [{ name: "Me", email: "me@example.org" }],
    receivedAt: "2026-09-20T10:00:00Z", size: 10, blobId: "b1", preview: "hi",
    htmlBody: [], textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: "hi", isEncodingProblem: false, isTruncated: false } },
    attachments: [],
  }) as unknown as Email;

const FIRST = msg("m1", "The question");
const SECOND = msg("m2", "Re: The question");

function stubStore() {
  useMail.setState({
    accountId: "a1",
    threads: { t1: { id: "t1", emailIds: ["m1", "m2"] } } as never,
    emails: { m1: FIRST, m2: SECOND } as never,
    fullIds: { m1: true, m2: true } as never,
    loadingThreads: {} as never,
    mailboxes: { inbox: { id: "inbox", name: "Inbox", role: "inbox" } } as never,
    loadThread: (async () => undefined) as never,
    setOpenThread: (() => undefined) as never,
    markRead: (async () => undefined) as never,
    roleId: (() => null) as never,
  });
}

describe("what the toolbar above an opened message acts on", () => {
  let host: HTMLDivElement;
  let root: Root;
  let actions: ListActions;

  const show = async (messageId: Id | null) => {
    await act(async () => {
      root.render(
        <ThreadView
          threadId="t1" mailboxId="inbox" messageId={messageId} actions={actions}
          onBack={() => undefined} onNavigate={() => undefined} hasPrev={false} hasNext={false}
        />,
      );
    });
  };

  /** The toolbar buttons carry their shortcut in the title, as the tooltips show. */
  const press = async (title: string) => {
    const btn = [...host.querySelectorAll("button")].find((b) => b.title === title);
    expect(btn, `no toolbar button titled ${title}`).toBeTruthy();
    await act(async () => btn!.click());
  };

  beforeEach(() => {
    stubStore();
    actions = {
      archive: vi.fn(async () => undefined), trash: vi.fn(async () => undefined),
      spam: vi.fn(async () => undefined), read: vi.fn(async () => undefined),
      star: vi.fn(async () => undefined), move: vi.fn(async () => undefined),
      label: vi.fn(async () => undefined),
    } as unknown as ListActions;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("marks only the message that is open, not its thread", async () => {
    await show("m1");
    await press("Mark as unread");
    expect(actions.read).toHaveBeenCalledWith(false, ["m1"]);
  });

  it("moves, reports and deletes only that message too", async () => {
    await show("m1");
    await press("Move to (v)");
    await press("Report spam (!)");
    await press("Delete (#)");
    expect(actions.move).toHaveBeenCalledWith(["m1"]);
    expect(actions.spam).toHaveBeenCalledWith(["m1"]);
    expect(actions.trash).toHaveBeenCalledWith(["m1"]);
  });

  it("takes the whole thread when the pane is showing the whole thread", async () => {
    // Conversation view on: no message singled out, and the toolbar is the
    // conversation's toolbar. That is the behaviour this must not disturb.
    await show(null);
    await press("Mark as unread");
    expect(actions.read).toHaveBeenCalledWith(false, ["m1", "m2"]);
  });

  it("falls back to the thread when the open id names nothing in it", async () => {
    // A link from somebody with conversation view on, or a stale `m` in the
    // URL. The pane shows the conversation, so the toolbar acts on it.
    await show("gone");
    await press("Mark as unread");
    expect(actions.read).toHaveBeenCalledWith(false, ["m1", "m2"]);
  });
});
