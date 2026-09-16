import { SPAM_HEADER_PROPS } from "@/lib/spamScore";


/*
 * Named explicitly so `shareWith` comes back, which it does not otherwise --
 * see the note on CALENDAR_PROPS and the KNOWN-ISSUES entry. Mailboxes were the
 * third and last store fetching everything by asking for nothing.
 *
 * It matters here for one narrow but real case. Sharing a mail folder is
 * withdrawn because Stalwart stores the share and never delivers it, and the
 * only way left to clear one already made is the "Stop sharing" entry, which
 * appears only when a folder looks shared. Without this it never looked shared,
 * so the escape hatch for the exact situation it was built for was invisible.
 */
export const MAILBOX_PROPS = [
  "id",
  "name",
  "parentId",
  "role",
  "sortOrder",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
  "myRights",
  "isSubscribed",
  "shareWith",
];

export const LIST_PROPS = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "hasAttachment",
  "from",
  "to",
  "subject",
  "receivedAt",
  "sentAt",
  "size",
  "preview",
];

export const FULL_PROPS = [
  ...LIST_PROPS,
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "cc",
  "bcc",
  "replyTo",
  "bodyStructure",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "header:List-Unsubscribe:asText",
  "header:List-Unsubscribe-Post:asText",
  "header:List-Id:asText",
  "header:Disposition-Notification-To:asAddresses",
  "header:X-Priority:asText",
  "header:Importance:asText",
  "header:Auto-Submitted:asText",
  "header:Precedence:asText",
  "header:Authentication-Results:asText",
  ...SPAM_HEADER_PROPS,
];

export const BODY_PROPS = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid", "language", "location", "subParts", "headers"];
