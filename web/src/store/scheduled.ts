import { create } from "zustand";
import { client, ref, setErrorMessage } from "@/jmap/client";
import type { EmailSubmission, GetResponse, Id, Mailbox, QueryResponse, SetResponse } from "@/jmap/types";
import { toast } from "@/ui/toast";
import { useMail } from "./mail";
import { canScheduleSend, maxDelayMs, SUBMISSION_CAP, type SubmissionCapability } from "@/lib/schedule";
import { t } from "@/lib/i18n";

/**
 * A held message lives in a folder of its own, the way Gmail's does, because
 * the alternatives are both wrong: leaving it in Drafts invites the user to
 * edit a message the queue has already frozen, and `onSuccessUpdateEmail`
 * files it in Sent the instant the submission is created -- which for a
 * scheduled send is a lie for however long the hold lasts.
 *
 * JMAP has no role for this (the IANA attribute registry has no `\Scheduled`),
 * so it is an ordinary folder found by name.
 */
export const SCHEDULED_MAILBOX = "Scheduled";

/** What this account's server says about holding a message before sending it. */
export function submissionCapability(): SubmissionCapability | undefined {
  const accountId = useMail.getState().accountId;
  if (!accountId) return undefined;
  return client.accountCapability<SubmissionCapability>(accountId, SUBMISSION_CAP);
}

/** Whether to offer scheduled send at all. */
export function scheduleSupported(): boolean {
  return canScheduleSend(submissionCapability());
}

/** How far ahead this server will hold a message, in milliseconds. */
export function scheduleWindowMs(): number {
  return maxDelayMs(submissionCapability());
}

/** Whether this folder is the one held messages wait in. */
export function isScheduledMailbox(m: Pick<Mailbox, "role" | "parentId" | "name">): boolean {
  return !m.role && !m.parentId && m.name.toLowerCase() === SCHEDULED_MAILBOX.toLowerCase();
}

/** The Scheduled folder in a given set of mailboxes, if one exists yet. */
export function scheduledMailboxIdFrom(mailboxes: Record<Id, Mailbox>): Id | null {
  return Object.values(mailboxes).find(isScheduledMailbox)?.id ?? null;
}

/** The Scheduled folder, if one exists yet. */
export function scheduledMailboxId(): Id | null {
  return scheduledMailboxIdFrom(useMail.getState().mailboxes);
}

/** The Scheduled folder, creating it the first time something is scheduled. */
export async function ensureScheduledMailbox(): Promise<Id> {
  const existing = scheduledMailboxId();
  if (existing) return existing;
  const accountId = useMail.getState().accountId!;
  const res = await client.call<SetResponse<Mailbox>>("Mailbox/set", {
    accountId,
    create: { sched: { name: SCHEDULED_MAILBOX, parentId: null, isSubscribed: true } },
  });
  const err = res.notCreated?.sched;
  // A racing tab (or another client) may have created it between the two calls.
  if (err) {
    await useMail.getState().loadMailboxes();
    const again = scheduledMailboxId();
    if (again) return again;
    throw new Error(setErrorMessage(err));
  }
  const id = res.created!.sched!.id;
  await useMail.getState().loadMailboxes();
  return id;
}

export interface PendingSend {
  id: Id;
  emailId: Id;
  /** Epoch milliseconds, as the server settled on it. */
  sendAt: number;
  undoStatus: EmailSubmission["undoStatus"];
}

interface ScheduledState {
  /** Pending submissions, keyed by the message they will send. */
  pending: Record<Id, PendingSend>;
  loaded: boolean;
  load(): Promise<void>;
  cancel(emailId: Id): Promise<void>;
  reconcile(): Promise<void>;
}

const SUB_PROPS = ["id", "emailId", "sendAt", "undoStatus"];

function toPending(s: EmailSubmission): PendingSend {
  return { id: s.id, emailId: s.emailId, sendAt: Date.parse(s.sendAt), undoStatus: s.undoStatus };
}

/** Every submission still sitting in the server's queue. */
async function loadPending(accountId: Id): Promise<PendingSend[]> {
  const res = await client.chain([
    ["EmailSubmission/query", { accountId, filter: { undoStatus: "pending" } }, "q"],
    ["EmailSubmission/get", { accountId, "#ids": ref("q", "EmailSubmission/query", "/ids"), properties: SUB_PROPS }, "g"],
  ]);
  const got = res.get("g")?.[0] as unknown as GetResponse<EmailSubmission> | undefined;
  return (got?.list ?? []).map(toPending);
}

/** The submissions belonging to a specific set of messages, whatever their status. */
async function loadFor(accountId: Id, emailIds: Id[]): Promise<PendingSend[]> {
  if (!emailIds.length) return [];
  const res = await client.chain([
    ["EmailSubmission/query", { accountId, filter: { emailIds } }, "q"],
    ["EmailSubmission/get", { accountId, "#ids": ref("q", "EmailSubmission/query", "/ids"), properties: SUB_PROPS }, "g"],
  ]);
  const got = res.get("g")?.[0] as unknown as GetResponse<EmailSubmission> | undefined;
  return (got?.list ?? []).map(toPending);
}

export const useScheduled = create<ScheduledState>((set, get) => ({
  pending: {},
  loaded: false,

  async load() {
    const accountId = useMail.getState().accountId;
    if (!accountId) return;
    try {
      const list = await loadPending(accountId);
      const pending: Record<Id, PendingSend> = {};
      for (const s of list) pending[s.emailId] = s;
      set({ pending, loaded: true });
    } catch {
      // A server without the submission capability simply has nothing to show.
      set({ loaded: true });
    }
  },

  async cancel(emailId) {
    const accountId = useMail.getState().accountId!;
    const sub = get().pending[emailId];
    if (!sub) throw new Error("This message is no longer waiting to be sent");
    const draftsId = useMail.getState().roleId("drafts");
    const scheduledId = scheduledMailboxId();
    // Not `onSuccessUpdateEmail`: RFC 8621 keys it by submission id, but
    // Stalwart takes a plain key as an Email id and would patch the wrong
    // object. Moving the message back is a separate call in the same request.
    const res = await client.chain([
      ["EmailSubmission/set", { accountId, update: { [sub.id]: { undoStatus: "canceled" } } }, "s"],
      [
        "Email/set",
        {
          accountId,
          update: {
            [emailId]: {
              "keywords/$draft": true,
              ...(draftsId ? { [`mailboxIds/${draftsId}`]: true } : {}),
              ...(scheduledId ? { [`mailboxIds/${scheduledId}`]: null } : {}),
            },
          },
        },
        "e",
      ],
    ], { allowErrors: true });
    const setRes = res.get("s")?.[0] as unknown as SetResponse & { __error?: { type: string; description?: string } };
    if (setRes.__error) throw new Error(setErrorMessage(setRes.__error));
    const err = setRes.notUpdated?.[sub.id];
    if (err) throw new Error(setErrorMessage(err));
    set((s) => {
      const { [emailId]: _drop, ...rest } = s.pending;
      return { pending: rest };
    });
    const mail = useMail.getState();
    void mail.loadMailboxes();
    void mail.refreshList();
  },

  /**
   * Nothing moves a message out of Scheduled when its hold expires -- the
   * server sends it and updates the submission, but the message stays where we
   * filed it. So on the way into the folder, settle up: what went out belongs
   * in Sent, what was cancelled elsewhere belongs back in Drafts.
   */
  async reconcile() {
    const mail = useMail.getState();
    const accountId = mail.accountId;
    const scheduledId = scheduledMailboxId();
    if (!accountId || !scheduledId) return;
    try {
      const q = await client.call<QueryResponse>("Email/query", {
        accountId,
        filter: { inMailbox: scheduledId },
        limit: 200,
      });
      if (!q.ids.length) {
        set({ pending: {} });
        return;
      }
      const subs = await loadFor(accountId, q.ids);
      // A message may carry several submissions if it was rescheduled. One
      // still pending settles it whatever the timestamps say -- the queue holds
      // a copy either way -- and otherwise the most recent wins.
      const latest = new Map<Id, PendingSend>();
      for (const s of subs) {
        const prev = latest.get(s.emailId);
        if (!prev) { latest.set(s.emailId, s); continue; }
        if (prev.undoStatus === "pending") continue;
        if (s.undoStatus === "pending" || s.sendAt >= prev.sendAt) latest.set(s.emailId, s);
      }
      const sentId = mail.roleId("sent");
      const draftsId = mail.roleId("drafts");
      const update: Record<Id, Record<string, unknown>> = {};
      const pending: Record<Id, PendingSend> = {};
      for (const emailId of q.ids) {
        const s = latest.get(emailId);
        if (s?.undoStatus === "pending") {
          pending[emailId] = s;
          continue;
        }
        // Cancelled goes back to Drafts; sent (or a submission the server no
        // longer knows about) goes to Sent, which is where it actually is.
        const toDrafts = s?.undoStatus === "canceled";
        const dest = toDrafts ? draftsId : sentId;
        if (!dest) continue;
        update[emailId] = {
          [`mailboxIds/${scheduledId}`]: null,
          [`mailboxIds/${dest}`]: true,
          ...(toDrafts ? { "keywords/$draft": true } : {}),
        };
      }
      set({ pending, loaded: true });
      if (Object.keys(update).length) {
        await client.call("Email/set", { accountId, update });
        void mail.loadMailboxes();
        void mail.refreshList();
      }
    } catch (err) {
      toast.error(t("Could not update the Scheduled folder: {error}", { error: (err as Error).message }));
    }
  },
}));
