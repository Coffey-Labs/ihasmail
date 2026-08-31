import { useState } from "react";
import { UserPlus } from "lucide-react";
import type { EmailBodyPart, Id } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { client } from "@/jmap/client";
import { toast } from "@/ui/toast";
import { t } from "@/lib/i18n";

export function VCardCard({ part, accountId }: { part: EmailBodyPart; accountId: Id }) {
  const contacts = useContacts();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (!contacts.available || !part.blobId) return null;
  const add = async () => {
    setBusy(true);
    try {
      const text = await client.fetchBlobText(accountId, part.blobId!, "text/vcard");
      const book = Object.values(contacts.books).find((b) => b.isDefault) ?? Object.values(contacts.books)[0];
      if (!book) throw new Error("No address book available");
      const n = await contacts.importVCard(text, book.id);
      setDone(true);
      toast.success(`Added ${n} contact${n === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vcard-card">
      <UserPlus size={20} style={{ color: "var(--accent)" }} />
      <div className="grow">
        <div style={{ fontWeight: 600 }}>{part.name ?? "Contact card"}</div>
        <div className="hint">{t("vCard attachment")}</div>
      </div>
      <button className="btn btn-sm" disabled={busy || done} onClick={() => void add()}>{done ? "Added" : "Add to contacts"}</button>
    </div>
  );
}
