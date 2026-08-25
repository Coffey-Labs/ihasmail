import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { AlertOctagon, Archive, ChevronDown, Clock, ChevronRight, File, Folder, FolderPlus, Inbox, Mail, MoreVertical, Send, Star, Tag, Trash2, Plus, Pencil, Eye, EyeOff, CheckCheck, Eraser, Share2 } from "lucide-react";
import { useMail } from "@/store/mail";
import { isScheduledMailbox } from "@/store/scheduled";
import { useSettings } from "@/store/settings";
import type { Id, Mailbox } from "@/jmap/types";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { ShareDialog } from "../settings/ShareDialog";
import { loadRaw, saveJson } from "@/lib/storage";
import { canDropFolder, movable } from "@/lib/folderMove";

const ROLE_ICONS: Record<string, ReactNode> = {
  inbox: <Inbox size={20} />,
  drafts: <File size={20} />,
  sent: <Send size={20} />,
  trash: <Trash2 size={20} />,
  junk: <AlertOctagon size={20} />,
  archive: <Archive size={20} />,
  all: <Mail size={20} />,
  flagged: <Star size={20} />,
  important: <Tag size={20} />,
};

/** Its own drag type, so a folder can only be dropped where folders belong. */
const FOLDER_MIME = "application/x-ihasmail-folder";

export function MailboxTree() {
  const mailboxes = useMail((s) => s.mailboxes);
  const loaded = useMail((s) => s.mailboxesLoaded);
  const [location] = useLocation();
  const currentId = location.startsWith("/mail/") ? location.split("/")[2] : undefined;
  const showHidden = useSettings((s) => s.settings.showHiddenFolders);
  const labels = useSettings((s) => s.settings.labels);
  const labelsSidebar = useSettings((s) => s.settings.labelsSidebar);
  const menu = useMenu();
  const [menuTarget, setMenuTarget] = useState<Mailbox | null>(null);
  const [shareTarget, setShareTarget] = useState<Mailbox | null>(null);
  /**
   * The folder being dragged. Held here rather than read from the drag itself:
   * dataTransfer.getData is blocked during dragover, so a row cannot ask what
   * is over it, and every row needs to know whether it is a legal target.
   */
  const [draggingId, setDraggingId] = useState<Id | null>(null);
  const [rootDrop, setRootDrop] = useState(false);
  /** Whether the folder in flight may be dropped on this folder, or on the root. */
  const canDropOn = (targetId: Id | null): boolean => Boolean(draggingId) && canDropFolder(mailboxes, draggingId!, targetId);

  const moveFolder = async (id: Id, parentId: Id | null) => {
    const m = mailboxes[id];
    setDraggingId(null);
    try {
      await useMail.getState().updateMailbox(id, { parentId });
      // Show where it landed rather than leaving it hidden in a closed parent.
      if (parentId) {
        const next = { ...expanded, [parentId]: true };
        setExpanded(next);
        saveJson("mbx-expanded", next);
      }
      toast.success(parentId ? `“${m?.name}” moved into “${mailboxes[parentId]?.name}”` : `“${m?.name}” moved to the top level`);
    } catch (err) {
      toast.error(`Could not move “${m?.name}”: ${(err as Error).message}`);
    }
  };

  // Tree: A–Z at every level (Inbox pinned to the top of the root), subfolders nested and
  // collapsed by default. Expansion state is remembered per folder.
  const [expanded, setExpanded] = useState<Record<Id, boolean>>(() => loadRaw("mbx-expanded", {}));
  const toggle = (id: Id) => {
    const next = { ...expanded, [id]: !expanded[id] };
    setExpanded(next);
    saveJson("mbx-expanded", next);
  };
  const rows = useMemo(() => {
    const all = Object.values(mailboxes).filter((m) => showHidden || m.isSubscribed || m.role === "inbox");
    const byParent = new Map<Id | null, Mailbox[]>();
    for (const m of all) {
      const p = m.parentId && mailboxes[m.parentId] ? m.parentId : null;
      byParent.set(p, [...(byParent.get(p) ?? []), m]);
    }
    const cmp = (a: Mailbox, b: Mailbox) => {
      if ((a.role === "inbox") !== (b.role === "inbox")) return a.role === "inbox" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    };
    const out: Array<{ m: Mailbox; depth: number; hasChildren: boolean; open: boolean; hiddenUnread: number; childUnread: number }> = [];
    const subtreeUnread = (id: Id): number => (byParent.get(id) ?? []).reduce((n, c) => n + c.unreadEmails + subtreeUnread(c.id), 0);
    const walk = (parent: Id | null, depth: number) => {
      for (const m of (byParent.get(parent) ?? []).sort(cmp)) {
        const kids = byParent.get(m.id) ?? [];
        const open = Boolean(expanded[m.id]);
        const childUnread = kids.length ? subtreeUnread(m.id) : 0;
        out.push({ m, depth, hasChildren: kids.length > 0, open, hiddenUnread: kids.length && !open ? childUnread : 0, childUnread });
        if (kids.length && open) walk(m.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [mailboxes, showHidden, expanded]);

  const createFolder = async (parentId: Id | null) => {
    const name = await promptDialog({ title: parentId ? "New subfolder" : "New folder", placeholder: "Folder name" });
    if (!name?.trim()) return;
    try {
      await useMail.getState().createMailbox(name.trim(), parentId);
      toast.success(`Folder “${name.trim()}” created`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (!loaded) {
    return (
      <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        {[...Array(6)].map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 28, width: `${70 + (i % 3) * 10}%` }} />
        ))}
      </div>
    );
  }

  return (
    <>
      <nav aria-label="Folders" style={{ marginTop: 6 }}>
        <div
          className={`nav-section${rootDrop ? " drop-target" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(FOLDER_MIME) || !canDropOn(null)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!rootDrop) setRootDrop(true);
          }}
          onDragLeave={() => setRootDrop(false)}
          onDrop={(e) => {
            e.preventDefault();
            setRootDrop(false);
            const id = e.dataTransfer.getData(FOLDER_MIME);
            if (id) void moveFolder(id, null);
          }}
        >
          <span>{draggingId && canDropOn(null) ? "Drop here for the top level" : "Folders"}</span>
          <button className="icon-btn" title="New folder" aria-label="New folder" onClick={() => void createFolder(null)}>
            <Plus size={16} />
          </button>
        </div>
        {rows.map(({ m, depth, hasChildren, open, hiddenUnread, childUnread }) => (
          <FolderRow
            key={m.id}
            mailbox={m}
            label={m.name}
            depth={depth}
            hasChildren={hasChildren}
            open={open}
            hiddenUnread={hiddenUnread}
            childUnread={childUnread}
            onToggle={() => toggle(m.id)}
            currentId={currentId}
            onMenu={(mb, e) => { setMenuTarget(mb); menu.open(e); }}
            dragging={draggingId === m.id}
            acceptsFolder={canDropOn(m.id)}
            onFolderDragStart={() => setDraggingId(m.id)}
            onFolderDragEnd={() => { setDraggingId(null); setRootDrop(false); }}
            onFolderDrop={(id) => void moveFolder(id, m.id)}
          />
        ))}
        {labelsSidebar && labels.length > 0 && (
          <>
            <div className="nav-section">
              <span>Labels</span>
              <Link href="/settings/labels" className="icon-btn" title="Manage labels" aria-label="Manage labels">
                <Pencil size={14} />
              </Link>
            </div>
            {labels.map((l) => (
              <Link key={l.keyword} href={`/search?q=label:${encodeURIComponent(l.keyword)}`} className="nav-item folder-row" title={l.name}>
                <span className="nav-label-color" style={{ "--label-color": l.color } as React.CSSProperties} />
                <span className="nav-label">{l.name}</span>
              </Link>
            ))}
          </>
        )}
      </nav>
      <Popover anchor={menu.anchor} onClose={menu.close} width={300}>
        {menuTarget && <MailboxMenu mailbox={menuTarget} onCreateChild={() => void createFolder(menuTarget.id)} onShare={() => setShareTarget(menuTarget)} />}
      </Popover>
      {shareTarget && <ShareDialog kind="Mailbox" id={shareTarget.id} name={shareTarget.name} shareWith={shareTarget.shareWith ?? null} onClose={() => setShareTarget(null)} />}
    </>
  );
}

function FolderRow({ mailbox: m, label, depth, hasChildren, open, hiddenUnread, childUnread, onToggle, currentId, onMenu, dragging, acceptsFolder, onFolderDragStart, onFolderDragEnd, onFolderDrop }: { mailbox: Mailbox; label: string; depth: number; hasChildren: boolean; open: boolean; hiddenUnread: number; childUnread: number; onToggle: () => void; currentId?: string; onMenu: (m: Mailbox, e: { currentTarget: Element }) => void; dragging: boolean; acceptsFolder: boolean; onFolderDragStart: () => void; onFolderDragEnd: () => void; onFolderDrop: (id: Id) => void }) {
  const [dropping, setDropping] = useState(false);
  // Scheduled counts like Drafts: everything in it is already read, so the
  // useful number is how many messages are waiting, not how many are unseen.
  const scheduled = isScheduledMailbox(m);
  const own = m.role === "drafts" || scheduled ? m.totalEmails : m.unreadEmails;
  const count = own + hiddenUnread;
  // Bold when this folder has unread mail, or any folder beneath it does (parent + child both bold).
  const unread = m.role !== "drafts" && m.role !== "trash" && m.role !== "junk" && m.role !== "sent" && !scheduled ? m.unreadEmails + childUnread > 0 : m.unreadEmails > 0 && m.role !== "drafts" && !scheduled;
  const icon = m.role && ROLE_ICONS[m.role] ? ROLE_ICONS[m.role] : scheduled ? <Clock size={20} /> : <Folder size={20} />;

  const onDragOver = (e: DragEvent) => {
    const folder = e.dataTransfer.types.includes(FOLDER_MIME);
    if (folder ? !acceptsFolder : !e.dataTransfer.types.includes("application/x-ihasmail-emails")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dropping) setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const folderId = e.dataTransfer.getData(FOLDER_MIME);
    if (folderId) {
      if (acceptsFolder) onFolderDrop(folderId);
      return;
    }
    const raw = e.dataTransfer.getData("application/x-ihasmail-emails");
    if (!raw) return;
    try {
      const ids = JSON.parse(raw) as string[];
      void useMail.getState().move(ids, m.id);
    } catch {
      /* ignore */
    }
  };
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(FOLDER_MIME, m.id);
    e.dataTransfer.effectAllowed = "move";
    // A folder row is a link, and a link drag would otherwise carry its URL.
    e.stopPropagation();
    onFolderDragStart();
  };

  return (
    <Link
      href={`/mail/${m.id}`}
      className={`nav-item folder-row depth-${Math.min(depth, 4)} ${currentId === m.id ? "active" : ""} ${unread ? "unread" : ""} ${dropping ? "drop-target" : ""} ${dragging ? "dragging" : ""}`}
      title={label}
      draggable={movable(m)}
      onDragStart={onDragStart}
      onDragEnd={onFolderDragEnd}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(m, { currentTarget: e.currentTarget });
      }}
    >
      <span
        className="nav-twisty"
        role={hasChildren ? "button" : undefined}
        aria-label={hasChildren ? (open ? "Collapse" : "Expand") : undefined}
        aria-expanded={hasChildren ? open : undefined}
        aria-hidden={hasChildren ? undefined : true}
        onClick={
          hasChildren
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggle();
              }
            : undefined
        }
      >
        {hasChildren ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
      </span>
      {icon}
      <span className="nav-label">{label}</span>
      {count > 0 && <span className="nav-count" title={hiddenUnread ? `${own} here, ${hiddenUnread} in subfolders` : undefined}>{count > 9999 ? "9999+" : count}</span>}
      {count > 0 && <span className="nav-dot" />}
      <button
        className="icon-btn nav-more"
        aria-label="Folder options"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(m, e);
        }}
      >
        <MoreVertical size={16} />
      </button>
    </Link>
  );
}

function MailboxMenu({ mailbox: m, onCreateChild, onShare }: { mailbox: Mailbox; onCreateChild: () => void; onShare: () => void }) {
  const [, navigate] = useLocation();
  const hasChildren = useMail((s) => Object.values(s.mailboxes).some((x) => (x.parentId ?? null) === m.id));
  const subUnread = useMail((s) => {
    const all = Object.values(s.mailboxes);
    let n = 0;
    const walk = (parent: Id) => {
      for (const x of all)
        if ((x.parentId ?? null) === parent) {
          n += x.unreadEmails;
          walk(x.id);
        }
    };
    walk(m.id);
    return n;
  });
  const rename = async () => {
    const name = await promptDialog({ title: "Rename folder", defaultValue: m.name });
    if (!name?.trim() || name.trim() === m.name) return;
    try {
      await useMail.getState().updateMailbox(m.id, { name: name.trim() });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({ title: `Delete “${m.name}”?`, message: `This permanently deletes the folder and its ${m.totalEmails} message(s).`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await useMail.getState().destroyMailbox(m.id, true);
      toast.success("Folder deleted");
      navigate(`/mail/${useMail.getState().roleId("inbox") ?? ""}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const empty = async () => {
    const ok = await confirmDialog({ title: `Empty “${m.name}”?`, message: `All ${m.totalEmails} messages will be permanently deleted.`, confirmLabel: "Empty folder", danger: true });
    if (ok) await useMail.getState().emptyMailbox(m.id);
  };
  const isSpecial = Boolean(m.role) && m.role !== "subscribed";
  return (
    <>
      <MenuItem icon={<CheckCheck size={16} />} label="Mark all as read" onClick={() => void useMail.getState().markMailboxRead(m.id)} disabled={!m.unreadEmails} />
      {hasChildren && (
        <MenuItem
          icon={<CheckCheck size={16} />}
          label="Mark all as read, incl. subfolders"
          kbd={m.unreadEmails + subUnread ? String(m.unreadEmails + subUnread) : undefined}
          onClick={() => void useMail.getState().markMailboxRead(m.id, true)}
          disabled={!m.unreadEmails && !subUnread}
        />
      )}
      <MenuItem icon={<FolderPlus size={16} />} label="New subfolder" onClick={onCreateChild} disabled={!m.myRights.mayCreateChild} />
      <MenuItem icon={<Pencil size={16} />} label="Rename" onClick={() => void rename()} disabled={isSpecial || !m.myRights.mayRename} />
      <MenuItem icon={m.isSubscribed ? <EyeOff size={16} /> : <Eye size={16} />} label={m.isSubscribed ? "Hide from list" : "Show in list"} onClick={() => void useMail.getState().updateMailbox(m.id, { isSubscribed: !m.isSubscribed })} disabled={m.role === "inbox"} />
      <MenuItem icon={<Share2 size={16} />} label="Share…" onClick={onShare} />
      <MenuSep />
      {m.role === "trash" && <MenuItem icon={<Eraser size={16} />} label="Empty folder" onClick={() => void empty()} danger />}
      <MenuItem icon={<Trash2 size={16} />} label="Delete folder" onClick={() => void remove()} danger disabled={isSpecial || !m.myRights.mayDelete} />
    </>
  );
}
