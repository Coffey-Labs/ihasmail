import type { MailboxRole } from "@/jmap/types";

export function mailboxIcon(role: MailboxRole): string {
  switch (role) {
    case "inbox":
      return "inbox";
    case "drafts":
      return "file";
    case "sent":
      return "send";
    case "trash":
      return "trash";
    case "junk":
      return "alert";
    case "archive":
      return "archive";
    case "all":
      return "mail";
    case "flagged":
      return "star";
    case "important":
      return "tag";
    default:
      return "folder";
  }
}

export const ROLE_ORDER: Record<string, number> = { inbox: 0, flagged: 1, important: 2, drafts: 3, sent: 4, archive: 5, all: 6, junk: 7, trash: 8 };
