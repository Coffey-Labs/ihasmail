/* ------------------------------------------------------------------ */
/* JMAP core (RFC 8620)                                                */
/* ------------------------------------------------------------------ */

export type Id = string;
export type UTCDate = string; // "2024-01-01T10:00:00Z"
export type LocalDate = string; // "2024-01-01T10:00:00"

export interface Account {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface JmapSession {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
  ihasmail?: {
    appName: string;
    /** Where this instance's source can be had, for the AGPL's sake. */
    sourceUrl?: string;
    imageProxy: boolean;
    maxUploadBytes: number;
    sessionId: string;
    loginName: string;
    remember: boolean;
    /** Locale configured for the account in Stalwart, if the server exposes it. */
    userLocale?: string | null;
    /** What the upstream server was willing to say about itself. */
    server?: {
      /** Which API generation answered: Stalwart publishes no version number. */
      generation?: "0.16+" | "pre-0.16" | null;
      edition?: string | null;
    };
  };
}

export interface CoreCapabilities {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  collationAlgorithms: string[];
}

export interface MailCapabilities {
  maxMailboxesPerEmail: number | null;
  maxMailboxDepth: number | null;
  maxSizeMailboxName: number;
  maxSizeAttachmentsPerEmail: number;
  emailQuerySortOptions: string[];
  mayCreateTopLevelMailbox: boolean;
}

export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

export interface JmapResponse {
  methodResponses: Invocation[];
  sessionState: string;
  createdIds?: Record<string, Id>;
}

export interface MethodError {
  type: string;
  description?: string;
  [k: string]: unknown;
}

export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
  [k: string]: unknown;
}

export interface SetResponse<T = Record<string, unknown>> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created?: Record<string, T>;
  updated?: Record<string, T | null>;
  destroyed?: Id[];
  notCreated?: Record<string, SetError>;
  notUpdated?: Record<string, SetError>;
  notDestroyed?: Record<string, SetError>;
}

export interface GetResponse<T> {
  accountId: Id;
  state: string;
  list: T[];
  notFound: Id[];
}

export interface QueryResponse {
  accountId: Id;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: Id[];
  total?: number;
  limit?: number;
}

export interface ChangesResponse {
  accountId: Id;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
}

export interface StateChange {
  "@type": "StateChange";
  changed: Record<Id, Record<string, string>>;
}

/* ------------------------------------------------------------------ */
/* Mail (RFC 8621)                                                     */
/* ------------------------------------------------------------------ */

export type MailboxRole =
  | "inbox"
  | "archive"
  | "drafts"
  | "sent"
  | "trash"
  | "junk"
  | "important"
  | "all"
  | "flagged"
  | "subscribed"
  | null;

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: MailboxRole;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
  shareWith?: Record<Id, Partial<MailboxRights>> | null;
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailAddressGroup {
  name: string | null;
  addresses: EmailAddress[];
}

export interface EmailHeader {
  name: string;
  value: string;
}

export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  size: number;
  headers?: EmailHeader[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language?: string[] | null;
  location?: string | null;
  subParts?: EmailBodyPart[] | null;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export interface Email {
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: UTCDate;
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  sender?: EmailAddress[] | null;
  from?: EmailAddress[] | null;
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  replyTo?: EmailAddress[] | null;
  subject?: string | null;
  sentAt?: string | null;
  hasAttachment?: boolean;
  preview?: string;
  bodyStructure?: EmailBodyPart;
  bodyValues?: Record<string, EmailBodyValue>;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
  attachments?: EmailBodyPart[];
  headers?: EmailHeader[];
  // convenience header fetches
  "header:List-Unsubscribe:asText"?: string | null;
  "header:List-Unsubscribe-Post:asText"?: string | null;
  "header:List-Id:asText"?: string | null;
  "header:Disposition-Notification-To:asAddresses"?: EmailAddress[] | null;
  "header:X-Priority:asText"?: string | null;
  "header:Importance:asText"?: string | null;
  "header:Auto-Submitted:asText"?: string | null;
  /** Bulk/list mail marks itself here; read receipts for it only confirm the address. */
  "header:Precedence:asText"?: string | null;
  "header:Return-Path:asText"?: string | null;
  "header:Authentication-Results:asText"?: string | null;
  "header:Received:asText:all"?: string[] | null;
  "header:X-Spam-Status:asText"?: string | null;
  "header:X-Spam-Result:asText"?: string | null;
}

export interface Thread {
  id: Id;
  emailIds: Id[];
}

export interface Identity {
  id: Id;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

export interface EmailSubmission {
  id: Id;
  identityId: Id;
  emailId: Id;
  threadId: Id;
  envelope: { mailFrom: { email: string; parameters?: Record<string, unknown> | null }; rcptTo: { email: string }[] } | null;
  sendAt: UTCDate;
  undoStatus: "pending" | "final" | "canceled";
  deliveryStatus: Record<string, { smtpReply: string; delivered: string; displayed: string }> | null;
}

export interface VacationResponse {
  id: "singleton";
  isEnabled: boolean;
  fromDate: UTCDate | null;
  toDate: UTCDate | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
}

export interface SearchSnippet {
  emailId: Id;
  subject: string | null;
  preview: string | null;
}

export interface EmailFilterCondition {
  inMailbox?: Id;
  inMailboxOtherThan?: Id[];
  before?: UTCDate;
  after?: UTCDate;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: string[];
}

export interface FilterOperator<T> {
  operator: "AND" | "OR" | "NOT";
  conditions: Array<T | FilterOperator<T>>;
}

export type EmailFilter = EmailFilterCondition | FilterOperator<EmailFilterCondition>;

export interface Comparator {
  property: string;
  isAscending?: boolean;
  collation?: string;
  keyword?: string;
}

/* ------------------------------------------------------------------ */
/* Quota (RFC 9425)                                                    */
/* ------------------------------------------------------------------ */

export interface Quota {
  id: Id;
  resourceType: "count" | "octets";
  used: number;
  hardLimit: number;
  scope: "account" | "domain" | "global";
  name: string;
  types: string[];
  warnLimit?: number | null;
  softLimit?: number | null;
  description?: string | null;
}

/* ------------------------------------------------------------------ */
/* Sieve (RFC 9661)                                                    */
/* ------------------------------------------------------------------ */

export interface SieveScript {
  id: Id;
  name: string;
  blobId: Id;
  isActive: boolean;
}

/* ------------------------------------------------------------------ */
/* Principals (RFC 9670)                                               */
/* ------------------------------------------------------------------ */

export interface Principal {
  id: Id;
  type: "individual" | "group" | "resource" | "location" | "other";
  name: string;
  description: string | null;
  email: string | null;
  timeZone: string | null;
  capabilities?: Record<string, unknown>;
  accounts?: Record<Id, Account> | null;
}

export interface BusyPeriod {
  utcStart: UTCDate;
  utcEnd: UTCDate;
  busyStatus: "confirmed" | "tentative" | "unavailable";
  event: JSCalendarEvent | null;
}

/* ------------------------------------------------------------------ */
/* Contacts (RFC 9610 / JSContact RFC 9553)                            */
/* ------------------------------------------------------------------ */

export interface AddressBookRights {
  mayRead: boolean;
  mayWrite: boolean;
  mayShare: boolean;
  mayDelete: boolean;
}

export interface AddressBook {
  id: Id;
  name: string;
  description: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSubscribed: boolean;
  shareWith: Record<Id, AddressBookRights> | null;
  myRights: AddressBookRights;
}

export interface JSContactNameComponent {
  "@type"?: "NameComponent";
  kind: "title" | "given" | "given2" | "surname" | "surname2" | "credential" | "generation" | "separator";
  value: string;
}

export interface JSContactName {
  "@type"?: "Name";
  components?: JSContactNameComponent[];
  isOrdered?: boolean;
  full?: string;
  defaultSeparator?: string;
  sortAs?: Record<string, string>;
}

export interface JSContactEmail {
  "@type"?: "EmailAddress";
  address: string;
  contexts?: Record<string, boolean>;
  pref?: number;
  label?: string;
}

export interface JSContactPhone {
  "@type"?: "Phone";
  number: string;
  features?: Record<string, boolean>;
  contexts?: Record<string, boolean>;
  pref?: number;
  label?: string;
}

export interface JSContactAddressComponent {
  "@type"?: "AddressComponent";
  kind: string;
  value: string;
}

export interface JSContactAddress {
  "@type"?: "Address";
  components?: JSContactAddressComponent[];
  isOrdered?: boolean;
  countryCode?: string;
  coordinates?: string;
  timeZone?: string;
  contexts?: Record<string, boolean>;
  full?: string;
  defaultSeparator?: string;
  pref?: number;
}

export interface JSContactOrganization {
  "@type"?: "Organization";
  name?: string;
  units?: { "@type"?: "OrgUnit"; name: string }[];
  sortAs?: string;
  contexts?: Record<string, boolean>;
}

export interface JSContactTitle {
  "@type"?: "Title";
  name: string;
  kind?: "title" | "role";
  organizationId?: string;
}

export interface JSContactAnniversary {
  "@type"?: "Anniversary";
  kind: "birth" | "death" | "wedding" | string;
  date: { "@type"?: "PartialDate" | "Timestamp"; year?: number; month?: number; day?: number; utc?: string };
  place?: JSContactAddress;
}

export interface JSContactNote {
  "@type"?: "Note";
  note: string;
  created?: string;
  author?: { name?: string; uri?: string };
}

export interface JSContactOnlineService {
  "@type"?: "OnlineService";
  service?: string;
  uri?: string;
  user?: string;
  contexts?: Record<string, boolean>;
  pref?: number;
  label?: string;
}

export interface JSContactMedia {
  "@type"?: "Media";
  kind: "photo" | "sound" | "logo";
  uri?: string;
  blobId?: Id;
  mediaType?: string;
  contexts?: Record<string, boolean>;
  pref?: number;
  label?: string;
}

export interface JSContactRelation {
  "@type"?: "Relation";
  relation?: Record<string, boolean>;
}

export interface ContactCard {
  id: Id;
  addressBookIds: Record<Id, boolean>;
  "@type"?: "Card";
  version?: "1.0";
  uid: string;
  kind?: "individual" | "group" | "org" | "location" | "device" | "application";
  created?: UTCDate;
  updated?: UTCDate;
  language?: string;
  prodId?: string;
  members?: Record<string, boolean>;
  name?: JSContactName;
  nicknames?: Record<string, { "@type"?: "Nickname"; name: string; contexts?: Record<string, boolean>; pref?: number }>;
  organizations?: Record<string, JSContactOrganization>;
  titles?: Record<string, JSContactTitle>;
  emails?: Record<string, JSContactEmail>;
  phones?: Record<string, JSContactPhone>;
  addresses?: Record<string, JSContactAddress>;
  onlineServices?: Record<string, JSContactOnlineService>;
  anniversaries?: Record<string, JSContactAnniversary>;
  notes?: Record<string, JSContactNote>;
  keywords?: Record<string, boolean>;
  media?: Record<string, JSContactMedia>;
  relatedTo?: Record<string, JSContactRelation>;
  links?: Record<string, { "@type"?: "Link"; uri: string; kind?: string; label?: string }>;
  preferredLanguages?: Record<string, { "@type"?: "LanguagePref"; language: string; pref?: number; contexts?: Record<string, boolean> }>;
  speakToAs?: { "@type"?: "SpeakToAs"; grammaticalGender?: string; pronouns?: Record<string, { pronouns: string }> };
  calendars?: Record<string, { "@type"?: "Calendar"; kind?: string; uri: string }>;
  schedulingAddresses?: Record<string, { "@type"?: "SchedulingAddress"; uri: string }>;
  personalInfo?: Record<string, { "@type"?: "PersonalInfo"; kind: string; value: string; level?: string }>;
}

/* ------------------------------------------------------------------ */
/* Calendars (draft-ietf-jmap-calendars / JSCalendar RFC 8984)         */
/* ------------------------------------------------------------------ */

export interface CalendarRights {
  mayReadFreeBusy: boolean;
  mayReadItems: boolean;
  mayWriteAll: boolean;
  mayWriteOwn: boolean;
  mayUpdatePrivate: boolean;
  mayRSVP: boolean;
  mayShare: boolean;
  mayDelete: boolean;
}

export interface Calendar {
  id: Id;
  name: string;
  description: string | null;
  color: string | null;
  sortOrder: number;
  isSubscribed: boolean;
  isVisible: boolean;
  isDefault: boolean;
  includeInAvailability: "all" | "attending" | "none";
  defaultAlertsWithTime: Record<string, JSCalendarAlert> | null;
  defaultAlertsWithoutTime: Record<string, JSCalendarAlert> | null;
  timeZone: string | null;
  shareWith: Record<Id, CalendarRights> | null;
  myRights: CalendarRights;
}

export interface JSCalendarAlert {
  "@type"?: "Alert";
  trigger:
    | { "@type"?: "OffsetTrigger"; offset: string; relativeTo?: "start" | "end" }
    | { "@type"?: "AbsoluteTrigger"; when: UTCDate };
  acknowledged?: UTCDate;
  action?: "display" | "email";
  relatedTo?: Record<string, JSContactRelation>;
}

export interface JSCalendarNDay {
  "@type"?: "NDay";
  day: "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";
  nthOfPeriod?: number;
}

export interface JSCalendarRecurrenceRule {
  "@type"?: "RecurrenceRule";
  frequency: "yearly" | "monthly" | "weekly" | "daily" | "hourly" | "minutely" | "secondly";
  interval?: number;
  rscale?: string;
  skip?: string;
  firstDayOfWeek?: string;
  byDay?: JSCalendarNDay[];
  byMonthDay?: number[];
  byMonth?: string[];
  byYearDay?: number[];
  byWeekNo?: number[];
  byHour?: number[];
  byMinute?: number[];
  bySecond?: number[];
  bySetPosition?: number[];
  count?: number;
  until?: LocalDate;
}

export interface JSCalendarParticipant {
  "@type"?: "Participant";
  name?: string;
  email?: string;
  description?: string;
  sendTo?: Record<string, string>;
  /** Where Stalwart 0.16 keeps the address, in place of `sendTo` / `email`. */
  calendarAddress?: string;
  kind?: "individual" | "group" | "location" | "resource";
  roles: Record<string, boolean>;
  locationId?: string;
  language?: string;
  participationStatus?: "needs-action" | "accepted" | "declined" | "tentative" | "delegated";
  participationComment?: string;
  expectReply?: boolean;
  scheduleAgent?: "server" | "client" | "none";
  scheduleForceSend?: boolean;
  scheduleSequence?: number;
  scheduleStatus?: string[];
  scheduleUpdated?: UTCDate;
  sentBy?: string;
  invitedBy?: string;
  delegatedTo?: Record<string, boolean>;
  delegatedFrom?: Record<string, boolean>;
  memberOf?: Record<string, boolean>;
  links?: Record<string, unknown>;
  progress?: string;
  percentComplete?: number;
}

export interface JSCalendarLocation {
  "@type"?: "Location";
  name?: string;
  description?: string;
  locationTypes?: Record<string, boolean>;
  relativeTo?: "start" | "end";
  timeZone?: string;
  coordinates?: string;
  links?: Record<string, unknown>;
}

export interface JSCalendarVirtualLocation {
  "@type"?: "VirtualLocation";
  name?: string;
  description?: string;
  uri: string;
  features?: Record<string, boolean>;
}

export interface JSCalendarEvent {
  "@type"?: "Event";
  uid: string;
  relatedTo?: Record<string, JSContactRelation>;
  prodId?: string;
  created?: UTCDate;
  updated?: UTCDate;
  sequence?: number;
  method?: string;
  title?: string;
  description?: string;
  descriptionContentType?: string;
  showWithoutTime?: boolean;
  locations?: Record<string, JSCalendarLocation>;
  virtualLocations?: Record<string, JSCalendarVirtualLocation>;
  links?: Record<string, { "@type"?: "Link"; href: string; contentType?: string; size?: number; rel?: string; display?: string; title?: string }>;
  locale?: string;
  keywords?: Record<string, boolean>;
  categories?: Record<string, boolean>;
  color?: string;
  recurrenceId?: LocalDate;
  recurrenceIdTimeZone?: string;
  recurrenceRules?: JSCalendarRecurrenceRule[];
  /** Stalwart 0.16 stores a single rule under this name instead of the array above. */
  recurrenceRule?: JSCalendarRecurrenceRule;
  excludedRecurrenceRules?: JSCalendarRecurrenceRule[];
  recurrenceOverrides?: Record<LocalDate, Record<string, unknown> | null>;
  excluded?: boolean;
  priority?: number;
  freeBusyStatus?: "free" | "busy";
  privacy?: "public" | "private" | "secret";
  replyTo?: Record<string, string>;
  /** Where Stalwart 0.16 keeps the organizer, in place of `replyTo`. */
  organizerCalendarAddress?: string;
  sentBy?: string;
  participants?: Record<string, JSCalendarParticipant>;
  requestStatus?: string;
  useDefaultAlerts?: boolean;
  alerts?: Record<string, JSCalendarAlert>;
  localizations?: Record<string, Record<string, unknown>>;
  timeZone?: string | null;
  start: LocalDate;
  duration?: string;
  status?: "confirmed" | "cancelled" | "tentative";
}

export interface CalendarEvent extends JSCalendarEvent {
  id: Id;
  baseEventId?: Id | null;
  calendarIds: Record<Id, boolean>;
  isDraft?: boolean;
  isOrigin?: boolean;
  utcStart?: UTCDate;
  utcEnd?: UTCDate;
  mayInviteSelf?: boolean;
  mayInviteOthers?: boolean;
  hideAttendees?: boolean;
}

export interface ParticipantIdentity {
  id: Id;
  name: string;
  calendarAddress: string;
  sendTo: Record<string, string>;
  isDefault: boolean;
}

export interface CalendarEventNotification {
  id: Id;
  created: UTCDate;
  changedBy: { name: string; email: string | null; principalId: Id | null; calendarAddress?: string | null };
  comment: string | null;
  type: "created" | "updated" | "destroyed";
  calendarEventId: Id;
  isDraft?: boolean;
  event: JSCalendarEvent;
  eventPatch?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Files (draft-ietf-jmap-filenode)                                    */
/* ------------------------------------------------------------------ */

export interface FilesRights {
  mayRead: boolean;
  mayAddChildren: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  mayModifyContent: boolean;
  mayShare: boolean;
}

export interface FileNode {
  id: Id;
  parentId: Id | null;
  nodeType: "file" | "directory" | "symlink";
  blobId: Id | null;
  target?: string[] | null;
  size: number | null;
  name: string;
  type: string | null;
  created: UTCDate;
  modified: UTCDate | null;
  accessed?: UTCDate | null;
  changed?: UTCDate;
  executable?: boolean;
  isSubscribed?: boolean;
  myRights: FilesRights;
  shareWith?: Record<Id, FilesRights> | null;
  role?: string | null;
}

/* ------------------------------------------------------------------ */
/* Blob (RFC 9404)                                                     */
/* ------------------------------------------------------------------ */

export interface UploadResponse {
  accountId: Id;
  blobId: Id;
  type: string;
  size: number;
}

export interface BlobGetResponse {
  id: Id;
  "data:asText"?: string | null;
  "data:asBase64"?: string | null;
  size?: number;
  isEncodingProblem?: boolean;
  isTruncated?: boolean;
}
