import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { AlertOctagon, Archive, ChevronDown, ChevronLeft, Clock, ChevronRight, File, Folder, FolderPlus, Inbox, Mail, MoreVertical, Palette, Send, Star, Tag, Trash2, Plus, Pencil, Eye, EyeOff, CheckCheck, Eraser, Share2, X } from "lucide-react";
import { useMail } from "@/store/mail";
import { canEmpty, confirmAndEmpty, emptyLabel } from "@/lib/emptyFolder";
import { labelTree, visibleLabels } from "@/lib/labelTree";
import { isScheduledMailbox } from "@/store/scheduled";
import { useSettings } from "@/store/settings";
import type { Id, Mailbox } from "@/jmap/types";
import { MenuItem, MenuSep, MenuTitle, Popover, useMenu } from "@/ui/popover";
import { CALENDAR_COLORS, useIsMobile, useIsTouch } from "@/ui/misc";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { ShareDialog } from "../settings/ShareDialog";
import { loadRaw, saveJson } from "@/lib/storage";
import { canDropFolder, folderColor, movable } from "@/lib/folderMove";
import { haptic, useTouchRow } from "@/lib/touch";
import { plural, t } from "@/lib/i18n";
import { mailboxDisplayName } from "@/lib/mailboxName";

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
  const labelCounts = useMail((s) => s.labelCounts);
  const shownLabels = useMemo(() => visibleLabels(labelTree(labels, labelCounts)), [labels, labelCounts]);
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
      toast.success(parentId ? t("“{name}” moved into “{parent}”", { name: mailboxDisplayName(m), parent: mailboxDisplayName(mailboxes[parentId]) }) : t("“{name}” moved to the top level", { name: mailboxDisplayName(m) }));
    } catch (err) {
      toast.error(t("Could not move “{name}”: {reason}", { name: mailboxDisplayName(m), reason: (err as Error).message }));
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
  const { rows, childrenOf, subtreeUnread } = useMemo(() => {
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
    for (const list of byParent.values()) list.sort(cmp);
    const out: Array<{ m: Mailbox; depth: number; hasChildren: boolean; open: boolean; hiddenUnread: number; childUnread: number }> = [];
    const unreadBelow = (id: Id): number => (byParent.get(id) ?? []).reduce((n, c) => n + c.unreadEmails + unreadBelow(c.id), 0);
    const walk = (parent: Id | null, depth: number) => {
      for (const m of byParent.get(parent) ?? []) {
        const kids = byParent.get(m.id) ?? [];
        const open = Boolean(expanded[m.id]);
        const childUnread = kids.length ? unreadBelow(m.id) : 0;
        out.push({ m, depth, hasChildren: kids.length > 0, open, hiddenUnread: kids.length && !open ? childUnread : 0, childUnread });
        if (kids.length && open) walk(m.id, depth + 1);
      }
    };
    walk(null, 0);
    return { rows: out, childrenOf: (id: Id | null) => byParent.get(id) ?? [], subtreeUnread: unreadBelow };
  }, [mailboxes, showHidden, expanded]);

  /*
   * On a phone the tree is a drill-down instead: one level at a time, a back
   * row above it, no indent. The tree earns its indent on a wide sidebar and
   * cannot pay for it in a 300px drawer -- four levels down, the 16px steps and
   * the 18px twisty left a folder 85px to print its name in, and the twisty had
   * walked far enough right to be hard to hit at all. Width picks the mode, not
   * the pointer: this is a layout that does not fit, not a target that is small.
   */
  const isMobile = useIsMobile();
  const [drillId, setDrillId] = useState<Id | null>(null);
  const drill = drillId && mailboxes[drillId] ? mailboxes[drillId] : null;
  /*
   * Follow the reader into whichever folder they opened, so the drawer comes
   * back at the level they were last looking at rather than at the root they
   * would have to walk down from again.
   */
  useEffect(() => {
    if (!isMobile || !currentId) return;
    const m = mailboxes[currentId];
    if (m) setDrillId(m.parentId && mailboxes[m.parentId] ? m.parentId : null);
  }, [isMobile, currentId, mailboxes]);

  const createFolder = async (parentId: Id | null) => {
    const name = await promptDialog({ title: parentId ? t("New subfolder") : t("New folder"), placeholder: t("Folder name") });
    if (!name?.trim()) return;
    try {
      await useMail.getState().createMailbox(name.trim(), parentId);
      toast.success(t("Folder “{name}” created", { name: name.trim() }));
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
      <nav aria-label={t("Folders")} className={isMobile ? "folder-drill" : undefined} style={{ marginTop: 6 }}>
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
          <span>{draggingId && canDropOn(null) ? t("Drop here for the top level") : drill ? mailboxDisplayName(drill) : t("Folders")}</span>
          {/* Drilled in, the + makes a subfolder of the folder on screen --
              which is the one place in the app where "new folder here" has an
              unambiguous here. */}
          <button className="icon-btn" title={drill ? t("New subfolder") : t("New folder")} aria-label={drill ? t("New subfolder") : t("New folder")} onClick={() => void createFolder(drill?.id ?? null)}>
            <Plus size={16} />
          </button>
        </div>
        {drill && (
          <>
            <button className="nav-item drill-back" onClick={() => setDrillId(drill.parentId && mailboxes[drill.parentId] ? drill.parentId : null)}>
              <ChevronLeft size={20} />
              <span className="nav-label">{drill.parentId && mailboxes[drill.parentId] ? mailboxDisplayName(mailboxes[drill.parentId]) : t("Folders")}</span>
            </button>
            {/* The folder you drilled into is still a folder you can open. */}
            <FolderRow
              key={drill.id}
              mailbox={drill}
              label={mailboxDisplayName(drill)}
              depth={0}
              hasChildren={false}
              open={false}
              hiddenUnread={0}
              childUnread={subtreeUnread(drill.id)}
              onToggle={() => {}}
              currentId={currentId}
              onMenu={(mb, e) => { setMenuTarget(mb); menu.open(e); }}
              dragging={false}
              acceptsFolder={false}
              onFolderDragStart={() => {}}
              onFolderDragEnd={() => {}}
              onFolderDrop={() => {}}
            />
          </>
        )}
        {(isMobile ? childrenOf(drill?.id ?? null).map((m) => ({ m, depth: 0, hasChildren: childrenOf(m.id).length > 0, open: false, hiddenUnread: subtreeUnread(m.id), childUnread: subtreeUnread(m.id) })) : rows).map(({ m, depth, hasChildren, open, hiddenUnread, childUnread }) => (
          <FolderRow
            key={m.id}
            mailbox={m}
            label={mailboxDisplayName(m)}
            depth={depth}
            hasChildren={hasChildren}
            open={open}
            hiddenUnread={hiddenUnread}
            childUnread={childUnread}
            onToggle={() => toggle(m.id)}
            onDrillIn={isMobile && hasChildren ? () => setDrillId(m.id) : undefined}
            currentId={currentId}
            onMenu={(mb, e) => { setMenuTarget(mb); menu.open(e); }}
            dragging={draggingId === m.id}
            acceptsFolder={canDropOn(m.id)}
            onFolderDragStart={() => setDraggingId(m.id)}
            onFolderDragEnd={() => { setDraggingId(null); setRootDrop(false); }}
            onFolderDrop={(id) => void moveFolder(id, m.id)}
          />
        ))}
        {/* Labels are a flat list that belongs to the mailbox, not to whichever
            folder is on screen, so they stay at the top level of the drill. */}
        {!drill && labelsSidebar && shownLabels.length > 0 && (
          <>
            <div className="nav-section">
              <span>{t("Labels")}</span>
              <Link href="/settings/labels" className="icon-btn" title={t("Manage labels")} aria-label={t("Manage labels")}>
                <Pencil size={14} />
              </Link>
            </div>
            {shownLabels.map((n) => (
              <Link
                key={n.label.keyword}
                href={`/search?q=label:${encodeURIComponent(n.label.keyword)}`}
                className="nav-item folder-row"
                title={n.label.name}
                /* Indented rather than nested in the DOM: the rows are a flat
                   list of links and a nested one would break keyboard order. */
                style={{ paddingLeft: 12 + n.depth * 14 }}
              >
                <span className="nav-label-color" style={{ "--label-color": n.label.color } as React.CSSProperties} />
                <span className="nav-label">{n.label.name}</span>
                {n.unread > 0 && <span className="nav-count">{n.unread}</span>}
              </Link>
            ))}
          </>
        )}
      </nav>
      <Popover anchor={menu.anchor} onClose={menu.close} width={300}>
        {menuTarget && <MailboxMenu mailbox={menuTarget} onClose={menu.close} onCreateChild={() => void createFolder(menuTarget.id)} onShare={() => setShareTarget(menuTarget)} />}
      </Popover>
      {shareTarget && <ShareDialog kind="Mailbox" id={shareTarget.id} name={shareTarget.name} shareWith={shareTarget.shareWith ?? null} onClose={() => setShareTarget(null)} />}
    </>
  );
}

function FolderRow({ mailbox: m, label, depth, hasChildren, open, hiddenUnread, childUnread, onToggle, onDrillIn, currentId, onMenu, dragging, acceptsFolder, onFolderDragStart, onFolderDragEnd, onFolderDrop }: { mailbox: Mailbox; label: string; depth: number; hasChildren: boolean; open: boolean; hiddenUnread: number; childUnread: number; onToggle: () => void; onDrillIn?: () => void; currentId?: string; onMenu: (m: Mailbox, e: { currentTarget: Element }) => void; dragging: boolean; acceptsFolder: boolean; onFolderDragStart: () => void; onFolderDragEnd: () => void; onFolderDrop: (id: Id) => void }) {
  const [dropping, setDropping] = useState(false);
  /** Expanding in place and drilling in are the same relationship; only one shows. */
  const twisty = hasChildren && !onDrillIn;
  // Scheduled counts like Drafts: everything in it is already read, so the
  // useful number is how many messages are waiting, not how many are unseen.
  const scheduled = isScheduledMailbox(m);
  const own = m.role === "drafts" || scheduled ? m.totalEmails : m.unreadEmails;
  const count = own + hiddenUnread;
  // Bold when this folder has unread mail, or any folder beneath it does (parent + child both bold).
  const unread = m.role !== "drafts" && m.role !== "trash" && m.role !== "junk" && m.role !== "sent" && !scheduled ? m.unreadEmails + childUnread > 0 : m.unreadEmails > 0 && m.role !== "drafts" && !scheduled;
  const icon = m.role && ROLE_ICONS[m.role] ? ROLE_ICONS[m.role] : scheduled ? <Clock size={20} /> : <Folder size={20} />;
  // A chosen colour tints the icon only; the label keeps the tree's own
  // contrast, which a dozen arbitrary colours would not reliably give it.
  // Subscribed, not read once: picking a colour has to repaint the row.
  const tint = useSettings((s) => folderColor(s.settings.folderColors, m.id));

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
  /*
   * Hold a folder for its menu, which is the same menu the ⋮ opens.
   *
   * The button is already visible where there is no hover, so this is not the
   * only way in — but a 24px target beside a folder name is not what a thumb
   * aims at, and a right-click has no touchscreen equivalent to inherit.
   */
  const isTouch = useIsTouch();
  const press = useTouchRow({
    enabled: isTouch,
    onLongPress: (target) => {
      haptic(15);
      onMenu(m, { currentTarget: target });
    },
  });

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
      {...press}
      // Dragging a folder is a mouse gesture; on a touchscreen the browser
      // starts it from the same long press that now opens the menu.
      draggable={movable(m) && !isTouch}
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
      {/* Drilling replaces expanding, so the twisty goes with it -- two
          controls for one relationship, on opposite ends of the same row, is
          worse than either alone. */}
      <span
        className="nav-twisty"
        role={twisty ? "button" : undefined}
        aria-label={twisty ? (open ? "Collapse" : "Expand") : undefined}
        aria-expanded={twisty ? open : undefined}
        aria-hidden={twisty ? undefined : true}
        onClick={
          twisty
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggle();
              }
            : undefined
        }
      >
        {twisty ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
      </span>
      <span className="folder-icon" style={tint ? ({ "--folder-color": tint } as React.CSSProperties) : undefined}>{icon}</span>
      <span className="nav-label">{label}</span>
      {count > 0 && <span className="nav-count" title={hiddenUnread ? `${own} here, ${hiddenUnread} in subfolders` : undefined}>{count > 9999 ? "9999+" : count}</span>}
      {count > 0 && <span className="nav-dot" />}
      <button
        className="icon-btn nav-more"
        aria-label={t("Folder options")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(m, e);
        }}
      >
        <MoreVertical size={16} />
      </button>
      {/*
        Drilling in is a separate control from opening the folder, and sits at
        the right edge where it is the same size and the same place on every
        row -- unlike the twisty, which walks right with the indent and shrinks
        the name as it goes. Tapping the row still opens the folder, which is
        what a folder is for; this only changes what the list underneath shows.
      */}
      {onDrillIn && (
        <button
          className="icon-btn drill-into"
          aria-label={t("Open subfolders of {name}", { name: label })}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDrillIn();
          }}
        >
          <ChevronRight size={20} />
        </button>
      )}
    </Link>
  );
}

function MailboxMenu({ mailbox: m, onClose, onCreateChild, onShare }: { mailbox: Mailbox; onClose: () => void; onCreateChild: () => void; onShare: () => void }) {
  const shared = Object.keys(m.shareWith ?? {}).length > 0;
  const [, navigate] = useLocation();
  const colors = useSettings((s) => s.settings.folderColors);
  const update = useSettings((s) => s.update);
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
    const name = await // The server's own name, never the localised one: this box writes
    // back whatever it is prefilled with.
    promptDialog({ title: t("Rename folder"), defaultValue: m.name });
    if (!name?.trim() || name.trim() === m.name) return;
    try {
      await useMail.getState().updateMailbox(m.id, { name: name.trim() });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({ title: t("Delete “{name}”?", { name: mailboxDisplayName(m) }), message: plural(m.totalEmails, { one: "This permanently deletes the folder and its {n} message.", other: "This permanently deletes the folder and its {n} messages." }), confirmLabel: t("Delete"), danger: true });
    if (!ok) return;
    try {
      await useMail.getState().destroyMailbox(m.id, true);
      toast.success(t("Folder deleted"));
      navigate(`/mail/${useMail.getState().roleId("inbox") ?? ""}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const empty = () => confirmAndEmpty({ id: m.id, name: mailboxDisplayName(m), role: m.role, totalEmails: m.totalEmails });
  const isSpecial = Boolean(m.role) && m.role !== "subscribed";
  const color = folderColor(colors, m.id);
  const setColor = (c: string | null) => {
    onClose();
    const next = { ...colors };
    if (c) next[m.id] = c;
    else delete next[m.id];
    update({ folderColors: next });
  };
  return (
    <>
      <MenuItem icon={<CheckCheck size={16} />} label={t("Mark all as read")} onClick={() => void useMail.getState().markMailboxRead(m.id)} disabled={!m.unreadEmails} />
      {hasChildren && (
        <MenuItem
          icon={<CheckCheck size={16} />}
          label={t("Mark all as read, incl. subfolders")}
          kbd={m.unreadEmails + subUnread ? String(m.unreadEmails + subUnread) : undefined}
          onClick={() => void useMail.getState().markMailboxRead(m.id, true)}
          disabled={!m.unreadEmails && !subUnread}
        />
      )}
      <MenuItem icon={<FolderPlus size={16} />} label={t("New subfolder")} onClick={onCreateChild} disabled={!m.myRights.mayCreateChild} />
      <MenuItem icon={<Pencil size={16} />} label={t("Rename")} onClick={() => void rename()} disabled={isSpecial || !m.myRights.mayRename} />
      <MenuItem icon={m.isSubscribed ? <EyeOff size={16} /> : <Eye size={16} />} label={m.isSubscribed ? "Hide from list" : "Show in list"} onClick={() => void useMail.getState().updateMailbox(m.id, { isSubscribed: !m.isSubscribed })} disabled={m.role === "inbox"} />
      {/* Sharing a mail folder is withdrawn, not removed: Stalwart accepts and
          stores the share, and it never reaches the other account -- its own
          docs list calendars, address books and files as shareable and not mail
          folders. Offering it produced shares that looked real and did nothing.
          One that already exists can still be cleared here, which is the only
          reason this entry survives at all. */}
      {shared && <MenuItem icon={<Share2 size={16} />} label={t("Stop sharing")} onClick={onShare} />}
      <MenuSep />
      <MenuTitle><span className="row gap-4"><Palette size={12} />  {t("Colour")}</span></MenuTitle>
      <div className="color-grid" style={{ gridTemplateColumns: "repeat(6, 26px)", padding: "4px 10px 8px" }}>
        {CALENDAR_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            style={{ background: c, width: 26, height: 26, outline: color?.toLowerCase() === c ? "2px solid var(--fg)" : undefined, outlineOffset: 1 }}
            aria-label={c}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      {color && <MenuItem icon={<X size={16} />} label={t("Use the default colour")} onClick={() => setColor(null)} />}
      <MenuSep />
      {canEmpty(m.role) && <MenuItem icon={<Eraser size={16} />} label={emptyLabel(m)} onClick={() => void empty()} danger disabled={!m.totalEmails} />}
      <MenuItem icon={<Trash2 size={16} />} label={t("Delete folder")} onClick={() => void remove()} danger disabled={isSpecial || !m.myRights.mayDelete} />
    </>
  );
}
