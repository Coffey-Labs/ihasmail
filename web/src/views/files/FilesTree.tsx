import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, HardDrive, Pencil, RefreshCw, Share2, Trash2, Users } from "lucide-react";
import { useFiles } from "@/store/files";
import { useSession } from "@/store/session";
import type { FileNode, Id } from "@/jmap/types";
import { canDropFileNodes, NODE_MIME, readDraggedIds, isShared } from "@/lib/filenode";
import { entriesFromDrop, hasDirectory, planUpload } from "@/lib/dropUpload";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { loadRaw, saveJson } from "@/lib/storage";
import { ShareDialog } from "../settings/ShareDialog";
import { t } from "@/lib/i18n";

/**
 * Re-read the session, so the shared accounts on offer are current.
 *
 * Throttled because Files is navigated to often and this is a round trip that
 * tells the reader nothing new most times it runs.
 */
let lastShareRefresh = 0;
async function refreshShares(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastShareRefresh < 30_000) return;
  lastShareRefresh = now;
  try {
    await useSession.getState().refresh();
  } catch {
    // The tree still lists whatever the last session said; a failed refresh is
    // not worth an error over something the reader did not ask for.
    return;
  }
  await useFiles.getState().init();
}


/**
 * The folder tree beside the file list.
 *
 * Every directory in the account arrives in one query, so this never waits on
 * an expand and a drag always knows every folder it could land on -- including
 * ones the reader has never opened.
 */
export function FilesTree() {
  const [location, navigate] = useLocation();
  const nodes = useFiles((s) => s.nodes);
  const dirIds = useFiles((s) => s.dirIds);
  const treeLoaded = useFiles((s) => s.treeLoaded);
  const available = useFiles((s) => s.available);
  const loadTree = useFiles((s) => s.loadTree);
  const accountId = useFiles((s) => s.accountId);
  const ownAccountId = useFiles((s) => s.ownAccountId);
  const sharedAccounts = useFiles((s) => s.sharedAccounts);
  const [refreshing, setRefreshing] = useState(false);
  const viewingShare = Boolean(accountId && accountId !== ownAccountId);
  // Kept across sessions, the way the mailbox tree keeps its own.
  const [expanded, setExpandedState] = useState<Record<Id, boolean>>(() => loadRaw("files-expanded", {}));
  const setExpanded = (fn: (x: Record<Id, boolean>) => Record<Id, boolean>) => setExpandedState((x) => { const next = fn(x); saveJson("files-expanded", next); return next; });
  const [menuNode, setMenuNode] = useState<FileNode | null>(null);
  const [shareNode, setShareNode] = useState<FileNode | null>(null);
  const [rootDrop, setRootDrop] = useState(false);
  const menu = useMenu();

  /* Shared with the list pane: a drag starting in one has to be recognised by
     the other. See the note on `draggingId` in the store. */
  const draggingIds = useFiles((s) => s.draggingIds);
  const setDragging = useFiles((s) => s.setDragging);

  useEffect(() => {
    if (available && !treeLoaded) void loadTree();
  }, [available, treeLoaded, loadTree]);

  /*
   * Ask the server what is shared, on the way in.
   *
   * Shared accounts arrive in the JMAP session, which is fetched at sign-in and
   * refreshed only when a session-state change is pushed to this tab. A share
   * granted while the tab was open therefore stayed invisible until the next
   * sign-in -- and a share removed stayed on offer, which is why two browsers
   * disagreed about whether an account still existed. Opening Files is the
   * moment the answer matters, so that is when it is asked for.
   */
  useEffect(() => {
    void refreshShares();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentId = location.startsWith("/files/") ? location.slice("/files/".length) : null;

  // Open the branch the reader is looking at, so the current folder is visible
  // without them having to find it.
  useEffect(() => {
    if (!currentId) return;
    const open: Record<Id, boolean> = {};
    for (let id: Id | null | undefined = nodes[currentId]?.parentId; id; id = nodes[id]?.parentId) open[id] = true;
    if (Object.keys(open).length) setExpanded((x) => ({ ...x, ...open }));
  }, [currentId, nodes]);

  if (!available) return null;

  const dirs = dirIds.map((id) => nodes[id]).filter((n): n is FileNode => Boolean(n));
  const childrenOf = (parentId: Id | null) => dirs.filter((d) => (d.parentId ?? null) === parentId);
  const canDropOn = (targetId: Id | null) => canDropFileNodes(nodes, draggingIds, targetId);

  const moveTo = async (ids: Id[], parentId: Id | null) => {
    setDragging([]);
    try {
      await useFiles.getState().moveMany(ids, parentId);
      if (parentId) setExpanded((x) => ({ ...x, [parentId]: true }));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  /** Files dropped from outside land in the folder they were dropped on. */
  const dropFiles = async (parentId: Id | null, dt: DataTransfer) => {
    const entries = entriesFromDrop(dt);
    const flat = Array.from(dt.files);
    if (entries.length && hasDirectory(entries)) {
      const plan = await planUpload(entries);
      if (plan.length) await useFiles.getState().uploadPlan(parentId, plan);
      return;
    }
    if (flat.length) await useFiles.getState().upload(parentId, flat);
  };

  const onDrop = (targetId: Id | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRootDrop(false);
    if (e.dataTransfer.types.includes(NODE_MIME)) {
      const ids = readDraggedIds(e.dataTransfer);
      if (canDropFileNodes(nodes, ids, targetId)) void moveTo(ids, targetId);
      return;
    }
    if (e.dataTransfer.types.includes("Files")) void dropFiles(targetId, e.dataTransfer);
  };

  const onDragOver = (targetId: Id | null) => (e: React.DragEvent) => {
    const node = e.dataTransfer.types.includes(NODE_MIME);
    if (node ? !canDropOn(targetId) : !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = node ? "move" : "copy";
  };

  const row = (d: FileNode, depth: number) => {
    const kids = childrenOf(d.id);
    const open = Boolean(expanded[d.id]);
    return (
      <div key={d.id}>
        <div
          className={`nav-item ${currentId === d.id ? "active" : ""} ${draggingIds.length && canDropOn(d.id) ? "drop-target" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => navigate(`/files/${d.id}`)}
          onContextMenu={(e) => { e.preventDefault(); setMenuNode(d); menu.openAt(e.clientX, e.clientY); }}
          draggable
          onDragStart={(e) => { e.dataTransfer.setData(NODE_MIME, d.id); e.dataTransfer.effectAllowed = "move"; setDragging([d.id]); }}
          onDragEnd={() => setDragging([])}
          onDragOver={onDragOver(d.id)}
          onDrop={onDrop(d.id)}
        >
          <button
            className="nav-twisty"
            aria-label={open ? "Collapse" : "Expand"}
            style={{ visibility: kids.length ? "visible" : "hidden" }}
            onClick={(e) => { e.stopPropagation(); setExpanded((x) => ({ ...x, [d.id]: !open })); }}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {open && kids.length ? <FolderOpen size={17} /> : <Folder size={17} />}
          <span className="grow truncate">{d.name}</span>
          {isShared(d) && <Share2 size={12} className="faint" aria-label={t("Shared")} />}
        </div>
        {open && kids.map((k) => row(k, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div className="nav-section"><span>{viewingShare ? "Shared folder" : "Files"}</span></div>
      <div
        className={`nav-item ${currentId === null ? "active" : ""} ${rootDrop ? "drop-target" : ""}`}
        onClick={() => navigate("/files")}
        onContextMenu={(e) => { e.preventDefault(); setMenuNode(null); menu.openAt(e.clientX, e.clientY); }}
        onDragOver={(e) => { onDragOver(null)(e); if (!e.defaultPrevented) return; setRootDrop(true); }}
        onDragLeave={() => setRootDrop(false)}
        onDrop={onDrop(null)}
      >
        <span className="nav-twisty" aria-hidden="true" />
        <HardDrive size={17} />
        <span className="grow truncate">{viewingShare ? sharedAccounts.find((a) => a.id === accountId)?.name ?? "Shared files" : "All files"}</span>
      </div>
      {childrenOf(null).map((d) => row(d, 1))}
      {treeLoaded && !dirs.length && <p className="hint" style={{ padding: "4px 12px" }}>{viewingShare ? "Nothing shared here." : "No folders yet."}</p>}

      {/* Reaching a share used to mean switching the whole app to the other
          account from the profile menu, which pointed mail, calendar and
          contacts at them as well. Shared folders belong here, beside your
          own. */}
      {(viewingShare || sharedAccounts.length > 0) && (
        <>
          <div className="nav-section">
            <span>{t("Shared with me")}</span>
            <button
              className="icon-btn sm"
              title={t("Check for new shares")}
              aria-label={t("Check for new shares")}
              onClick={async () => { setRefreshing(true); await refreshShares(true); setRefreshing(false); }}
            >
              <RefreshCw size={14} className={refreshing ? "spin" : ""} />
            </button>
          </div>
          {viewingShare && (
            <div className="nav-item" onClick={() => { useFiles.getState().openAccount(ownAccountId); navigate("/files"); }}>
              <span className="nav-twisty" aria-hidden="true" />
              <HardDrive size={17} />
              <span className="grow truncate">{t("Back to my files")}</span>
            </div>
          )}
          {sharedAccounts.map((a) => (
            <div
              key={a.id}
              className={`nav-item ${accountId === a.id ? "active" : ""}`}
              onClick={() => { useFiles.getState().openAccount(a.id); navigate("/files"); }}
            >
              <span className="nav-twisty" aria-hidden="true" />
              <Users size={17} />
              <span className="grow truncate">{a.name}</span>
            </div>
          ))}
          {!sharedAccounts.length && <p className="hint" style={{ padding: "4px 12px" }}>{t("Nothing is shared with you.")}</p>}
        </>
      )}

      <Popover anchor={menu.anchor} onClose={menu.close} width={210}>
        <MenuItem
          icon={<FolderPlus size={16} />}
          label={t("New folder")}
          onClick={async () => {
            const name = await promptDialog({ title: t("New folder"), placeholder: t("Folder name") });
            if (!name?.trim()) return;
            try {
              await useFiles.getState().mkdir(menuNode?.id ?? null, name.trim());
              if (menuNode) setExpanded((x) => ({ ...x, [menuNode.id]: true }));
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        />
        {menuNode && (
          <>
            <MenuItem
              icon={<Pencil size={16} />}
              label={t("Rename")}
              disabled={!menuNode.myRights?.mayRename}
              onClick={async () => {
                const name = await promptDialog({ title: t("Rename"), defaultValue: menuNode.name });
                if (!name?.trim() || name === menuNode.name) return;
                try {
                  await useFiles.getState().rename(menuNode.id, name.trim());
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
            <MenuItem icon={<Share2 size={16} />} label={t("Share…")} disabled={!menuNode.myRights?.mayShare} onClick={() => setShareNode(menuNode)} />
            <MenuSep />
            <MenuItem
              danger
              icon={<Trash2 size={16} />}
              label={t("Delete")}
              disabled={!menuNode.myRights?.mayDelete}
              onClick={async () => {
                if (!(await confirmDialog({ title: t("Delete “{name}”?", { name: menuNode.name }), message: t("Everything inside it goes too."), confirmLabel: t("Delete"), danger: true }))) return;
                try {
                  await useFiles.getState().destroy([menuNode.id]);
                  if (currentId === menuNode.id) navigate("/files");
                  toast.success(t("Deleted"));
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
          </>
        )}
      </Popover>
      {shareNode && <ShareDialog kind="FileNode" id={shareNode.id} name={shareNode.name} shareWith={shareNode.shareWith ?? null} onClose={() => setShareNode(null)} />}
    </>
  );
}
