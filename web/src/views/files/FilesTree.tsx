import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, HardDrive, Pencil, Share2, Trash2 } from "lucide-react";
import { useFiles } from "@/store/files";
import type { FileNode, Id } from "@/jmap/types";
import { canDropFileNode, isShared } from "@/lib/filenode";
import { entriesFromDrop, hasDirectory, planUpload } from "@/lib/dropUpload";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { loadRaw, saveJson } from "@/lib/storage";
import { ShareDialog } from "../settings/ShareDialog";

/** The MIME a dragged node is offered under, so a target can recognise it. */
export const NODE_MIME = "application/x-ihasmail-filenode";

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
  // Kept across sessions, the way the mailbox tree keeps its own.
  const [expanded, setExpandedState] = useState<Record<Id, boolean>>(() => loadRaw("files-expanded", {}));
  const setExpanded = (fn: (x: Record<Id, boolean>) => Record<Id, boolean>) => setExpandedState((x) => { const next = fn(x); saveJson("files-expanded", next); return next; });
  const [menuNode, setMenuNode] = useState<FileNode | null>(null);
  const [shareNode, setShareNode] = useState<FileNode | null>(null);
  const [rootDrop, setRootDrop] = useState(false);
  const menu = useMenu();

  /* Shared with the list pane: a drag starting in one has to be recognised by
     the other. See the note on `draggingId` in the store. */
  const draggingId = useFiles((s) => s.draggingId);
  const setDraggingId = useFiles((s) => s.setDragging);

  useEffect(() => {
    if (available && !treeLoaded) void loadTree();
  }, [available, treeLoaded, loadTree]);

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
  const canDropOn = (targetId: Id | null) => Boolean(draggingId) && canDropFileNode(nodes, draggingId!, targetId);

  const moveTo = async (id: Id, parentId: Id | null) => {
    setDraggingId(null);
    try {
      await useFiles.getState().move(id, parentId);
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
      const id = e.dataTransfer.getData(NODE_MIME);
      if (id && canDropFileNode(nodes, id, targetId)) void moveTo(id, targetId);
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
          className={`nav-item ${currentId === d.id ? "active" : ""} ${draggingId && canDropOn(d.id) ? "drop-target" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => navigate(`/files/${d.id}`)}
          onContextMenu={(e) => { e.preventDefault(); setMenuNode(d); menu.openAt(e.clientX, e.clientY); }}
          draggable
          onDragStart={(e) => { e.dataTransfer.setData(NODE_MIME, d.id); e.dataTransfer.effectAllowed = "move"; setDraggingId(d.id); }}
          onDragEnd={() => setDraggingId(null)}
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
          {isShared(d) && <Share2 size={12} className="faint" aria-label="Shared" />}
        </div>
        {open && kids.map((k) => row(k, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div className="nav-section"><span>Files</span></div>
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
        <span className="grow truncate">All files</span>
      </div>
      {childrenOf(null).map((d) => row(d, 1))}
      {treeLoaded && !dirs.length && <p className="hint" style={{ padding: "4px 12px" }}>No folders yet.</p>}

      <Popover anchor={menu.anchor} onClose={menu.close} width={210}>
        <MenuItem
          icon={<FolderPlus size={16} />}
          label="New folder"
          onClick={async () => {
            const name = await promptDialog({ title: "New folder", placeholder: "Folder name" });
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
              label="Rename"
              disabled={!menuNode.myRights?.mayRename}
              onClick={async () => {
                const name = await promptDialog({ title: "Rename", defaultValue: menuNode.name });
                if (!name?.trim() || name === menuNode.name) return;
                try {
                  await useFiles.getState().rename(menuNode.id, name.trim());
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
            <MenuItem icon={<Share2 size={16} />} label="Share…" disabled={!menuNode.myRights?.mayShare} onClick={() => setShareNode(menuNode)} />
            <MenuSep />
            <MenuItem
              danger
              icon={<Trash2 size={16} />}
              label="Delete"
              disabled={!menuNode.myRights?.mayDelete}
              onClick={async () => {
                if (!(await confirmDialog({ title: `Delete “${menuNode.name}”?`, message: "Everything inside it goes too.", confirmLabel: "Delete", danger: true }))) return;
                try {
                  await useFiles.getState().destroy([menuNode.id]);
                  if (currentId === menuNode.id) navigate("/files");
                  toast.success("Deleted");
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
