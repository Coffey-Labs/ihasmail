import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadView } from "../ThreadView";
import { useMail } from "@/store/mail";
import type { ListActions } from "../MessageList";
import type { Email, Id } from "@/jmap/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

/*
 * Mark as unread on an open message undid itself: the unread count showed 1
 * for a moment, then the message was read again (Gitea issue #25). Clearing
 * `$seen` re-ran the mark-read timer, which found an open unread message and
 * did its job.
 */

const msg = (id: Id, seen: boolean, receivedAt: string): Email =>
  ({
    id, threadId: "t1", subject: "Hello", mailboxIds: { inbox: true }, keywords: seen ? { $seen: true } : {},
    from: [{ name: "Ann", email: "ann@example.com" }], to: [{ name: "Me", email: "me@example.org" }],
    receivedAt, size: 10, blobId: "b1", preview: "hi",
    htmlBody: [], textBody: [{ partId: "1", type: "text/plain" }],
    bodyValues: { "1": { value: "hi", isEncodingProblem: false, isTruncated: false } },
    attachments: [],
  }) as unknown as Email;

describe("marking an open message unread", () => {
  let host: HTMLDivElement;
  let root: Root;
  let markRead: ReturnType<typeof vi.fn>;

  const setEmails = async (emails: Email[]) => {
    await act(async () => {
      useMail.setState({
        threads: { t1: { id: "t1", emailIds: emails.map((e) => e.id) } } as never,
        emails: Object.fromEntries(emails.map((e) => [e.id, e])) as never,
        fullIds: Object.fromEntries(emails.map((e) => [e.id, true])) as never,
      });
    });
  };

  const show = async () => {
    const actions = {} as unknown as ListActions;
    await act(async () => {
      root.render(
        <ThreadView
          threadId="t1" mailboxId="inbox" messageId={null} actions={actions}
          onBack={() => undefined} onNavigate={() => undefined} hasPrev={false} hasNext={false}
        />,
      );
    });
  };

  const runTimers = async () => {
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    markRead = vi.fn(async () => undefined);
    useMail.setState({
      accountId: "a1",
      loadingThreads: {} as never,
      mailboxes: { inbox: { id: "inbox", name: "Inbox", role: "inbox" } } as never,
      loadThread: (async () => undefined) as never,
      setOpenThread: (() => undefined) as never,
      markRead: markRead as never,
      roleId: (() => null) as never,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("leaves it unread instead of marking it read again", async () => {
    await setEmails([msg("m1", true, "2026-10-01T10:00:00Z")]);
    await show();
    await runTimers();
    expect(markRead).not.toHaveBeenCalled();

    // What the button does: the server clears $seen and the store follows.
    await setEmails([msg("m1", false, "2026-10-01T10:00:00Z")]);
    await runTimers();
    expect(markRead).not.toHaveBeenCalled();
  });

  it("still marks a message read that was unread when the thread opened", async () => {
    await setEmails([msg("m1", false, "2026-10-01T10:00:00Z")]);
    await show();
    await runTimers();
    expect(markRead).toHaveBeenCalledWith(["m1"], true);
  });

  it("does not re-mark it after the timer has already read it once", async () => {
    // Opened unread, read by the timer, then marked unread by the reader.
    await setEmails([msg("m1", false, "2026-10-01T10:00:00Z")]);
    await show();
    await runTimers();
    expect(markRead).toHaveBeenCalledTimes(1);
    await setEmails([msg("m1", true, "2026-10-01T10:00:00Z")]);
    await setEmails([msg("m1", false, "2026-10-01T10:00:00Z")]);
    await runTimers();
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("still marks a reply read that arrives while the thread is open", async () => {
    await setEmails([msg("m1", true, "2026-10-01T10:00:00Z")]);
    await show();
    await setEmails([msg("m1", true, "2026-10-01T10:00:00Z"), msg("m2", false, "2026-10-01T11:00:00Z")]);
    await runTimers();
    expect(markRead).toHaveBeenCalledWith(["m2"], true);
  });
});
