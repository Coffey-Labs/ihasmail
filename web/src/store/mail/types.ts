import type { ArchiveGranularity } from "@/lib/archiveDate";
import type {
  Comparator,
  Email,
  EmailFilter,
  Id,
  Identity,
  Mailbox,
  MailboxRole,
  Quota,
  Thread,
  VacationResponse,
} from "@/jmap/types";

export interface ListQuery {
  key: string;
  filter: EmailFilter;
  sort: Comparator[];
  collapseThreads: boolean;
  mailboxId: string | null;
  label?: string;
}

export interface ListState extends ListQuery {
  ids: Id[];
  total: number;
  queryState: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  exhausted: boolean;
}

export interface MailState {
  accountId: Id | null;
  mailboxes: Record<Id, Mailbox>;
  mailboxState: string | null;
  mailboxesLoaded: boolean;
  emails: Record<Id, Email>;
  fullIds: Record<Id, true>;
  emailState: string | null;
  threads: Record<Id, Thread>;
  identities: Identity[];
  quotas: Quota[];
  vacation: VacationResponse | null;
  list: ListState | null;
  selected: Record<Id, true>;
  /** Unread messages per label keyword, for the sidebar. */
  labelCounts: Record<string, number>;
  /**
   * The selection means "everything the current query matches", not the rows
   * that happen to be loaded. Ticking the header box selects the loaded page;
   * this is the deliberate second step past it.
   */
  selectedAll: boolean;
  anchorId: Id | null;
  loadingThreads: Record<Id, true>;
  lastSeenInboxEmailIds: Id[] | null;
  openThreadId: Id | null;
  setOpenThread(id: Id | null): void;

  setAccount(accountId: Id | null): void;
  loadMailboxes(): Promise<void>;
  roleId(role: MailboxRole): Id | null;
  mailboxPath(id: Id): string;
  childrenOf(parentId: Id | null): Mailbox[];

  query(q: ListQuery, opts?: { reset?: boolean }): Promise<void>;
  loadMore(): Promise<void>;
  refreshList(): Promise<void>;

  getEmails(ids: Id[], full?: boolean): Promise<Email[]>;
  loadThread(threadId: Id): Promise<Email[]>;
  threadEmails(threadId: Id): Email[];
  threadIdsIn(threadId: Id, mailboxId: Id | null): Id[];

  setKeyword(ids: Id[], keyword: string, value: boolean): Promise<void>;
  markRead(ids: Id[], read: boolean): Promise<void>;
  star(ids: Id[], on: boolean): Promise<void>;
  move(ids: Id[], toMailboxId: Id, opts?: { fromMailboxId?: Id | null; silent?: boolean; label?: string }): Promise<void>;
  addToMailbox(ids: Id[], mailboxId: Id, add: boolean): Promise<void>;
  trash(ids: Id[]): Promise<void>;
  destroy(ids: Id[]): Promise<void>;
  archive(ids: Id[]): Promise<void>;
  /** Archive into a dated subfolder of Archive, creating the folders as needed. */
  archiveByDate(ids: Id[], granularity: ArchiveGranularity): Promise<void>;
  spam(ids: Id[], isSpam: boolean): Promise<void>;
  emptyMailbox(mailboxId: Id): Promise<void>;
  /** Mark every unread message in a mailbox read; optionally its subfolders too. */
  markMailboxRead(mailboxId: Id, includeChildren?: boolean): Promise<void>;
  /** The mailbox plus all of its descendants. */
  descendantMailboxIds(mailboxId: Id): Id[];

  createMailbox(name: string, parentId: Id | null, role?: MailboxRole): Promise<Id>;
  /** Give something the Archive role -- adopting a folder already named for it, or making one. */
  ensureArchiveFolder(): Promise<Id>;
  updateMailbox(id: Id, patch: Partial<Mailbox>): Promise<void>;
  destroyMailbox(id: Id, removeEmails?: boolean): Promise<void>;

  loadIdentities(): Promise<Identity[]>;
  /** The user's preferred identity (falls back to the first one). */
  defaultIdentity(): Identity | undefined;
  setDefaultIdentity(id: Id): void;
  saveIdentity(id: Id | null, patch: Partial<Identity>): Promise<void>;
  destroyIdentity(id: Id): Promise<void>;
  loadVacation(): Promise<void>;
  saveVacation(patch: Partial<VacationResponse>): Promise<void>;
  loadQuota(): Promise<void>;

  select(ids: Id[], on: boolean): void;
  clearSelection(): void;
  /** Refresh the per-label unread counts, in one request. */
  loadLabelCounts(): Promise<void>;
  selectAll(): void;
  /** Extend the selection from the loaded rows to everything the query matches. */
  selectAllMatching(): void;
  /** Every id the current query matches, walked a page at a time. */
  queryAllIds(): Promise<Id[]>;
  setAnchor(id: Id | null): void;

  applyChanges(types: Set<string>): Promise<void>;
  importEml(blobId: Id, mailboxId: Id, keywords?: Record<string, boolean>): Promise<Id | null>;
}

export const DEFAULT_SORT: Comparator[] = [{ property: "receivedAt", isAscending: false }];
