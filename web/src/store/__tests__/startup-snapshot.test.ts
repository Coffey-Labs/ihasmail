import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { buildSnapshot, useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { clearSignedInData, setDeviceTrusted } from "@/lib/storage";

/**
 * Starting from what a trusted device kept: the session, the folder list and
 * the first page of recent folders. On a distant link each of those was a
 * round trip before the inbox could show.
 */

const INBOX = "mbInbox";
const session = (remember: boolean) =>
  ({
    capabilities: { [CAP.core]: { maxObjectsInGet: 500 }, [CAP.mail]: {} },
    accounts: { a1: { name: "me", isPersonal: true, isReadOnly: false, accountCapabilities: { [CAP.mail]: {} } } },
    primaryAccounts: { [CAP.mail]: "a1" },
    state: "s",
    username: "me",
    apiUrl: "",
    downloadUrl: "",
    uploadUrl: "",
    eventSourceUrl: "",
    ihasmail: { remember, sessionId: "public-id" },
  }) as unknown as JmapSession;

const email = (id: string) => ({
  id,
  threadId: `t${id}`,
  mailboxIds: { [INBOX]: true },
  keywords: {},
  receivedAt: "2026-09-16T00:00:00Z",
  subject: `Subject ${id}`,
  preview: "p",
  bodyValues: { "1": { value: "secret body" } },
});

const inboxQuery = { key: "", filter: { inMailbox: INBOX }, sort: [], collapseThreads: false, mailboxId: INBOX };

/** The key the store gives the inbox list, learned by asking for it. */
function inboxKey(): string {
  useMail.getState().setAccount("probe");
  void useMail.getState().query(inboxQuery);
  const key = useMail.getState().list!.key;
  useMail.getState().setAccount(null);
  return key;
}

function signedInWithList() {
  const key = inboxKey();
  useMail.getState().setAccount("a1");
  useMail.setState({
    mailboxes: { [INBOX]: { id: INBOX, role: "inbox", name: "Inbox" } } as never,
    mailboxesLoaded: true,
    emails: { e1: email("e1"), e2: email("e2") } as never,
    list: { key, filter: { inMailbox: INBOX }, sort: [], collapseThreads: false, mailboxId: INBOX, ids: ["e1", "e2"], total: 7, queryState: "q", loading: false, loadingMore: false, error: null, exhausted: false },
  });
}

let pending: ((v: Response) => void) | null;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  pending = null;
  // The session request stays unanswered unless a test answers it.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { pending = resolve; })));
  useMail.getState().setAccount(null);
  useSession.setState({ status: "loading", session: null, accountId: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setDeviceTrusted(false);
  localStorage.clear();
});

describe("the kept mail snapshot", () => {
  it("holds folders and list rows without bodies", () => {
    signedInWithList();
    const snap = buildSnapshot(useMail.getState())!;
    expect(snap.mailboxes.map((m) => m.id)).toEqual([INBOX]);
    expect(snap.lists).toEqual([{ key: inboxKey(), ids: ["e1", "e2"], total: 7 }]);
    expect(snap.emails.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(JSON.stringify(snap)).not.toContain("secret body");
  });

  it("is not made before the server's folder list has arrived", () => {
    signedInWithList();
    useMail.setState({ mailboxesLoaded: false });
    expect(buildSnapshot(useMail.getState())).toBeNull();
  });

  it("paints the folders and the inbox on the next start of a trusted device", () => {
    setDeviceTrusted(true);
    useSession.setState({ status: "authenticated", accountId: "a1" });
    signedInWithList();
    // A change to the list schedules the save.
    useMail.setState((s) => ({ list: { ...s.list!, total: 8 } }));
    vi.advanceTimersByTime(3500);
    expect(localStorage.getItem("ihasmail:mail-snapshot")).toContain('"e1"');

    // Next start.
    useMail.getState().setAccount(null);
    useMail.getState().setAccount("a1");
    const s = useMail.getState();
    expect(s.mailboxesCached).toBe(true);
    expect(s.mailboxesLoaded).toBe(false);
    expect(s.mailboxes[INBOX]?.name).toBe("Inbox");
    void s.query(inboxQuery);
    expect(useMail.getState().list).toMatchObject({ ids: ["e1", "e2"], total: 8, loading: true });
  });

  it("is neither written nor read on a device not marked as the reader's own", () => {
    setDeviceTrusted(true);
    useSession.setState({ status: "authenticated", accountId: "a1" });
    signedInWithList();
    useMail.setState((s) => ({ list: { ...s.list!, total: 8 } }));
    vi.advanceTimersByTime(3500);
    setDeviceTrusted(false);
    useMail.getState().setAccount(null);
    useMail.getState().setAccount("a1");
    expect(useMail.getState().mailboxesCached).toBe(false);
    expect(useMail.getState().mailboxes).toEqual({});

    localStorage.clear();
    useSession.setState({ status: "authenticated", accountId: "a1" });
    signedInWithList();
    useMail.setState((s) => ({ list: { ...s.list!, total: 9 } }));
    vi.advanceTimersByTime(3500);
    expect(localStorage.getItem("ihasmail:mail-snapshot")).toBeNull();
  });

  it("is gone after signing out, and a save scheduled before it does not bring it back", () => {
    setDeviceTrusted(true);
    useSession.setState({ status: "authenticated", accountId: "a1" });
    signedInWithList();
    useMail.setState((s) => ({ list: { ...s.list!, total: 8 } }));
    vi.advanceTimersByTime(3500);
    useMail.setState((s) => ({ list: { ...s.list!, total: 9 } }));
    clearSignedInData();
    useSession.setState({ status: "anonymous", accountId: null });
    vi.advanceTimersByTime(3500);
    expect(localStorage.getItem("ihasmail:mail-snapshot")).toBeNull();
  });

  it("belongs to one account", () => {
    setDeviceTrusted(true);
    useSession.setState({ status: "authenticated", accountId: "a1" });
    signedInWithList();
    useMail.setState((s) => ({ list: { ...s.list!, total: 8 } }));
    vi.advanceTimersByTime(3500);
    useMail.getState().setAccount("a2");
    expect(useMail.getState().mailboxesCached).toBe(false);
    expect(useMail.getState().emails).toEqual({});
  });
});

describe("the kept session", () => {
  it("lets a trusted device start before the server answers, then takes the server's", async () => {
    setDeviceTrusted(true);
    localStorage.setItem("ihasmail:session", JSON.stringify(session(true)));
    const boot = useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe("authenticated");
    expect(useSession.getState().accountId).toBe("a1");
    expect(client.session?.username).toBe("me");
    const fresh = { ...session(true), username: "me-fresh" };
    pending!({ ok: true, status: 200, json: async () => fresh } as Response);
    await boot;
    expect(client.session?.username).toBe("me-fresh");
    expect(JSON.parse(localStorage.getItem("ihasmail:session")!).username).toBe("me-fresh");
  });

  it("is not used on a device not marked as the reader's own", () => {
    localStorage.setItem("ihasmail:session", JSON.stringify(session(true)));
    void useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe("loading");
  });

  it("is not kept for a session that did not ask to be remembered", async () => {
    const boot = useSession.getState().bootstrap();
    pending!({ ok: true, status: 200, json: async () => session(false) } as Response);
    await boot;
    expect(useSession.getState().status).toBe("authenticated");
    expect(localStorage.getItem("ihasmail:session")).toBeNull();
  });

  it("stays on screen when the server cannot be reached", async () => {
    setDeviceTrusted(true);
    localStorage.setItem("ihasmail:session", JSON.stringify(session(true)));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await useSession.getState().bootstrap();
    expect(useSession.getState().status).toBe("authenticated");
  });
});
