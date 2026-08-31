import { useCallback, useState, type MouseEvent, type ReactNode } from "react";
import { Copy, Mail, Pencil, UserPlus } from "lucide-react";
import type { EmailAddress } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { useCompose } from "@/store/compose";
import { contactFromAddress } from "@/lib/contacts";
import { formatAddress } from "@/lib/address";
import { MenuItem, MenuSep, Popover, type Anchor } from "@/ui/popover";
import { toast } from "@/ui/toast";
import { ContactEditor } from "../contacts/ContactEditor";
import { t } from "@/lib/i18n";

/**
 * Right-click on anyone named in a message — sender, recipients, Reply-To — to
 * add them to the address book. The contact editor opens prefilled rather than
 * saving silently, so the address book gets a real card and not just a stray
 * email address.
 */
export function useAddressMenu() {
  const [menu, setMenu] = useState<{ anchor: Anchor; address: EmailAddress } | null>(null);
  const [editing, setEditing] = useState<ReturnType<typeof contactFromAddress> | null>(null);
  const contacts = useContacts();
  const openCompose = useCompose((s) => s.open);

  const open = useCallback((ev: MouseEvent, address: EmailAddress) => {
    if (!address.email) return;
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({ anchor: { x: ev.clientX, y: ev.clientY }, address });
    // The books are needed the moment "Add to contacts" is chosen.
    const st = useContacts.getState();
    if (st.available && !st.loaded && !st.loading) void st.loadAll();
  }, []);

  const close = () => setMenu(null);
  const known = menu ? contacts.lookupByEmail(menu.address.email) : undefined;
  const books = Object.values(contacts.books);
  const defaultBookId = (books.find((b) => b.isDefault) ?? books[0])?.id ?? null;

  const node: ReactNode = (
    <>
      {menu && (
        <Popover anchor={menu.anchor} onClose={close} width={230} ariaLabel={`Actions for ${menu.address.email}`}>
          <div className="menu-title truncate">{formatAddress(menu.address)}</div>
          {contacts.available && (
            known ? (
              <MenuItem icon={<Pencil size={16} />} label={t("Edit contact")} onClick={() => { setEditing(known); close(); }} />
            ) : (
              <MenuItem icon={<UserPlus size={16} />} label={t("Add to contacts")} onClick={() => { setEditing(contactFromAddress(menu.address)); close(); }} />
            )
          )}
          <MenuItem icon={<Mail size={16} />} label={t("New message to this address")} onClick={() => { openCompose({ to: [menu.address] }); close(); }} />
          <MenuSep />
          <MenuItem
            icon={<Copy size={16} />}
            label={t("Copy email address")}
            onClick={() => {
              void navigator.clipboard?.writeText(menu.address.email).then(
                () => toast.show(t("Address copied")),
                () => toast.error(t("Could not copy the address")),
              );
              close();
            }}
          />
        </Popover>
      )}
      {editing && (
        <ContactEditor
          card={editing}
          defaultBookId={defaultBookId}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </>
  );

  return { open, node };
}

/** Comma-separated addresses, each of them right-clickable. */
export function AddressList({ list, onContext, empty = "—" }: { list: EmailAddress[] | null | undefined; onContext: (ev: MouseEvent, a: EmailAddress) => void; empty?: string }) {
  if (!list?.length) return <>{empty}</>;
  return (
    <>
      {list.map((a, i) => (
        <span key={`${a.email}-${i}`}>
          {i > 0 && ", "}
          <span className="addr" onContextMenu={(ev) => onContext(ev, a)} title={t("Right-click for options")}>{formatAddress(a)}</span>
        </span>
      ))}
    </>
  );
}
