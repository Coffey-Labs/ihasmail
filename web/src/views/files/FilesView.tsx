import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ChevronRight, Download, Eye, File, FilePen, Folder, FolderPlus, FolderOpen, Home, MoreVertical, Pencil, Share2, Trash2, Upload, FolderInput, X } from "lucide-react";
import { useFiles } from "@/store/files";
import { client } from "@/jmap/client";
import type { FileNode, Id } from "@/jmap/types";
import { formatSize, formatListDate } from "@/lib/format";
import { canDropFileNodes, isShared, NODE_MIME, readDraggedIds } from "@/lib/filenode";
import { previewKind } from "@/lib/preview";
import { entriesFromDrop, hasDirectory, planUpload } from "@/lib/dropUpload";
import { ShareDialog } from "../settings/ShareDialog";
import { Empty, Spinner } from "@/ui/misc";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog, Dialog } from "@/ui/dialog";
import { FilePreviewDialog, type PreviewFile } from "@/ui/filepreview";
import { toast } from "@/ui/toast";
import { plural, t } from "@/lib/i18n";

export function FilesView({ nodeId }: { nodeId?: string }) {
  const [, navigate] = useLocation();
  const files = useFiles();
  const parentId = nodeId ?? null;
  const [dropping, setDropping] = useState(false);
  /* A set, and the row a shift-click measures from. Kept as ids rather than
     indices: the listing reloads under you -- a push, an upload finishing --
     and an index would then point at a different file. */
  const [selection, setSelection] = useState<Set<Id>>(() => new Set());
  const [anchor, setAnchor] = useState<Id | null>(null);
  const menu = useMenu();
  const [menuNode, setMenuNode] = useState<FileNode | null>(null);
  const [moveNodes, setMoveNodes] = useState<FileNode[] | null>(null);
  const [shareNode, setShareNode] = useState<FileNode | null>(null);
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  /* What the open editor is editing, and the blob its text came from -- the
     baseline a save is checked against. Kept beside `preview` rather than in
     it, because the dialog is presentational and knows nothing about nodes. */
  const [editTarget, setEditTarget] = useState<{ id: Id; blobId: Id | null } | null>(null);
  const [startInEdit, setStartInEdit] = useState(false);
  /* Shared with the sidebar tree, so a row dragged onto a folder there is
     recognised. See the note on `draggingId` in the store. */
  const draggingIds = files.draggingIds;
  const setDragging = files.setDragging;
  const inputRef = useRef<HTMLInputElement>(null);

  /* A selection belongs to the folder it was made in. Carrying it across would
     leave rows selected that are no longer on screen, and the delete two
     folders later would be a surprise. */
  useEffect(() => {
    setSelection(new Set());
    setAnchor(null);
  }, [parentId, files.accountId]);

  /* Escape drops it, the way it does everywhere else. */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSelection((cur) => (cur.size ? new Set() : cur));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (files.available) void files.loadChildren(parentId);
    // `accountId` is in here because opening a share changes which account the
    // same route means: at /files the parent is null before and after, so
    // without it the listing would keep showing the previous account's folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.available, files.accountId, parentId]);

  // The sidebar's primary button asks for an upload here, the way it asks the
  // calendar for a new event.
  useEffect(() => {
    const open = () => inputRef.current?.click();
    window.addEventListener("ihm:files-upload", open);
    return () => window.removeEventListener("ihm:files-upload", open);
  }, []);

  // Ensure ancestors are loaded for breadcrumbs
  useEffect(() => {
    if (!files.available || !parentId) return;
    const n = files.nodes[parentId];
    if (!n) {
      void client.call<{ list: FileNode[] }>("FileNode/get", { accountId: files.accountId, ids: [parentId], fetchParents: true }).then((r) => {
        useFiles.setState((s) => {
          const nodes = { ...s.nodes };
          for (const x of r.list) nodes[x.id] = x;
          return { nodes };
        });
      }).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, files.available]);

  if (!files.available) return <div className="p-16"><Empty icon={<FolderOpen size={40} />} title={t("File storage is not available")}>{t("This account does not have the JMAP file storage capability.")}</Empty></div>;

  const ids = files.children[parentId ?? "root"] ?? [];
  const nodes = ids.map((id) => files.nodes[id]).filter((n): n is FileNode => Boolean(n));
  const path = files.pathTo(parentId);

  /* A drop lands in `into`, which is the folder under the pointer when there is
     one and the folder being listed otherwise. Entries have to be read out
     before the first await -- the list is emptied the moment the handler
     returns -- so that happens here, synchronously, for every path. */
  const dropOnto = (into: string | null, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    if (e.dataTransfer.types.includes(NODE_MIME)) {
      const ids = readDraggedIds(e.dataTransfer);
      setDragging([]);
      if (canDropFileNodes(files.nodes, ids, into)) {
        setSelection(new Set());
        void files.moveMany(ids, into).catch((err) => toast.error((err as Error).message));
      }
      return;
    }
    if (!e.dataTransfer.types.includes("Files")) return;
    const entries = entriesFromDrop(e.dataTransfer);
    const flat = Array.from(e.dataTransfer.files);
    void (async () => {
      if (entries.length && hasDirectory(entries)) {
        const plan = await planUpload(entries);
        if (plan.length) await files.uploadPlan(into, plan);
        return;
      }
      if (flat.length) await files.upload(into, flat);
    })();
  };

  const onDrop = (e: React.DragEvent) => dropOnto(parentId, e);

  const blobUrl = (n: FileNode, inline: boolean) =>
    client.downloadUrl(files.accountId!, n.blobId!, n.name, n.type ?? "application/octet-stream", inline);

  const download = (n: FileNode) => {
    if (!n.blobId) return;
    const a = document.createElement("a");
    a.href = blobUrl(n, false);
    a.download = n.name;
    a.click();
  };

  /*
   * Clicking a row, with the conventions a file manager has taught everyone:
   * plain replaces the selection, ctrl/cmd adds or removes one, shift takes
   * the run from the last row clicked to this one. The anchor is the row a
   * shift measures from, and a plain or toggling click moves it.
   */
  const clickRow = (n: FileNode, ev: React.MouseEvent) => {
    if (ev.shiftKey && anchor) {
      const from = nodes.findIndex((x) => x.id === anchor);
      const to = nodes.findIndex((x) => x.id === n.id);
      if (from >= 0 && to >= 0) {
        const run = nodes.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.id);
        setSelection(new Set(ev.ctrlKey || ev.metaKey ? [...selection, ...run] : run));
        return;
      }
    }
    if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(selection);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
      setSelection(next);
      setAnchor(n.id);
      return;
    }
    setSelection(new Set([n.id]));
    setAnchor(n.id);
  };

  /* Right-clicking inside the selection acts on all of it; right-clicking
     outside it means you meant that row, so the selection follows the pointer
     rather than the menu quietly applying to something off-screen. */
  const menuFor = (n: FileNode, at: (x: number, y: number) => void, x: number, y: number) => {
    if (!selection.has(n.id)) {
      setSelection(new Set([n.id]));
      setAnchor(n.id);
    }
    setMenuNode(n);
    at(x, y);
  };

  const selectedNodes = () => nodes.filter((n) => selection.has(n.id));
  /* What the menu and the bar act on: the whole selection when the row is part
     of it, and that row alone otherwise. */
  const targets = (n: FileNode | null) => (n && selection.has(n.id) && selection.size > 1 ? selectedNodes() : n ? [n] : selectedNodes());

  const removeNodes = async (list: FileNode[]) => {
    if (!list.length) return;
    const title = list.length === 1
      ? t("Delete “{name}”?", { name: list[0]!.name })
      : plural(list.length, { one: "Delete {n} item?", other: "Delete {n} items?" });
    if (!(await confirmDialog({ title, confirmLabel: t("Delete"), danger: true }))) return;
    try {
      await files.destroy(list.map((n) => n.id));
      setSelection(new Set());
      toast.success(t("Deleted"));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  /* A file with nothing to show still does what it always did. */
  const canPreview = (n: FileNode) => Boolean(n.blobId) && n.nodeType !== "directory" && previewKind(n.type, n.name) !== null;

  const openPreview = (n: FileNode, edit = false) => {
    setPreview({ name: n.name, type: n.type ?? "application/octet-stream", size: n.size, url: blobUrl(n, false), inlineUrl: blobUrl(n, true) });
    setEditTarget({ id: n.id, blobId: n.blobId });
    setStartInEdit(edit);
  };

  /* What the menu can tell from a row: text, and the right to write it. Whether
     it is *really* editable needs the bytes -- a truncated or non-UTF-8 file
     opens read-only and says so. */
  const canEditFile = (n: FileNode) => canPreview(n) && previewKind(n.type, n.name) === "text" && Boolean(n.myRights?.mayModifyContent);

  /*
   * Only offered where the reader may actually write: a folder shared read-only
   * still opens, and the Edit button is simply not there. `saveText` checks the
   * blob it started from, so two people editing the same file get told rather
   * than one of them losing the work.
   */
  const canEditNode = (n: FileNode | undefined) => Boolean(n?.myRights?.mayModifyContent);
  const saveEdited = async (text: string) => {
    const target = editTarget;
    if (!target) return;
    const next = await files.saveText(target.id, text, target.blobId);
    // The file has a new blob now; the next save in this same session is
    // checked against that one, not the one we opened.
    setEditTarget({ id: target.id, blobId: next });
    toast.success(t("Saved"));
  };

  /* Double-clicking a file used to download it, which is a decision made for
     you: to look at a picture you had to put it on disk first. Now it opens
     what can be opened and downloads the rest. */
  const activate = (n: FileNode) => {
    if (n.nodeType === "directory") navigate(`/files/${n.id}`);
    else if (canPreview(n)) openPreview(n);
    else download(n);
  };

  return (
    <div className={`files-layout ${dropping ? "dropping" : ""}`} onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } else if (e.dataTransfer.types.includes(NODE_MIME) && canDropFileNodes(files.nodes, draggingIds, parentId)) { e.preventDefault(); } }} onDragLeave={() => setDropping(false)} onDrop={onDrop}>
      <div className="files-toolbar">
        <div className="breadcrumb">
          <button className={path.length ? "" : "current"} onClick={() => navigate("/files")}><Home size={16} /></button>
          {path.map((n, i) => (
            <span key={n.id} className="row gap-4">
              <ChevronRight size={14} className="faint" />
              <button className={i === path.length - 1 ? "current" : ""} onClick={() => navigate(`/files/${n.id}`)}>{n.name}</button>
            </span>
          ))}
        </div>
        <button className="btn btn-sm" onClick={() => inputRef.current?.click()}><Upload size={16} />  {t("Upload")}</button>
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => { const l = Array.from(e.target.files ?? []); if (l.length) void files.upload(parentId, l); e.target.value = ""; }} />
        <button className="btn btn-sm" onClick={async () => { const n = await promptDialog({ title: t("New folder"), placeholder: t("Folder name") }); if (n?.trim()) { try { await files.mkdir(parentId, n.trim()); } catch (err) { toast.error((err as Error).message); } } }}><FolderPlus size={16} />  {t("New folder")}</button>
      </div>
      {files.uploads.length > 0 && (
        <div className="list-hint" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          {files.uploads.map((u) => <div key={u.id} className="row"><span className="truncate grow">{u.name}</span>{u.error ? <span style={{ color: "var(--danger)" }}>{u.error}</span> : <span>{u.progress}%</span>}</div>)}
        </div>
      )}
      {selection.size > 1 && (
        <div className="selection-bar">
          <span className="grow">{plural(selection.size, { one: "{n} item selected", other: "{n} items selected" })}</span>
          <button className="btn btn-sm" onClick={() => setMoveNodes(selectedNodes())}><FolderInput size={16} />  {t("Move to…")}</button>
          <button className="btn btn-sm btn-danger" onClick={() => void removeNodes(selectedNodes())}><Trash2 size={16} />  {t("Delete")}</button>
          <button className="icon-btn sm" aria-label={t("Clear selection")} title={t("Clear selection")} onClick={() => setSelection(new Set())}><X size={16} /></button>
        </div>
      )}
      {files.error && <div className="error-box" style={{ margin: 12 }}>{files.error}</div>}
      <div
        className="files-scroll"
        /* Clicking past the last row clears the selection, the way it does in
           every file manager. Rows stop the click from reaching here by
           handling it themselves, so this only ever sees the empty space. */
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("tr")) return;
          setSelection((cur) => (cur.size ? new Set() : cur));
        }}
        onContextMenu={(e) => {
          // Only the empty space below the rows: a row has its own menu.
          if ((e.target as HTMLElement).closest("tr")) return;
          e.preventDefault();
          setMenuNode(null);
          menu.openAt(e.clientX, e.clientY);
        }}
      >
        {files.loading && !nodes.length ? <Spinner /> : !nodes.length ? (
          <Empty icon={<FolderOpen size={40} />} title={t("This folder is empty")}>{t("Drag files here or use Upload.")}</Empty>
        ) : (
          <table className="files-table">
            <thead><tr><th>{t("Name")}</th><th className="hide-mobile">{t("Size")}</th><th className="hide-mobile">{t("Modified")}</th><th /></tr></thead>
            <tbody>
              {nodes.map((n) => (
                <tr
                  key={n.id}
                  className={`${selection.has(n.id) ? "selected" : ""} ${n.nodeType === "directory" && canDropFileNodes(files.nodes, draggingIds, n.id) ? "drop-target" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    /* Dragging a row that is part of the selection drags all of
                       it; dragging one outside the selection means that row. */
                    const ids = selection.has(n.id) ? [...selection] : [n.id];
                    if (!selection.has(n.id)) { setSelection(new Set([n.id])); setAnchor(n.id); }
                    e.dataTransfer.setData(NODE_MIME, ids.join(","));
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(ids);
                  }}
                  onDragEnd={() => setDragging([])}
                  onDragOver={(e) => {
                    if (n.nodeType !== "directory") return;
                    const node = e.dataTransfer.types.includes(NODE_MIME);
                    if (node ? !canDropFileNodes(files.nodes, draggingIds, n.id) : !e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = node ? "move" : "copy";
                  }}
                  onDrop={(e) => { if (n.nodeType === "directory") dropOnto(n.id, e); }}
                  onClick={(e) => clickRow(n, e)} onDoubleClick={() => activate(n)} onContextMenu={(e) => { e.preventDefault(); menuFor(n, menu.openAt, e.clientX, e.clientY); }}>
                  <td><div className="f-name">{n.nodeType === "directory" ? <Folder size={18} /> : <File size={18} />}<span onClick={(e) => { if (n.nodeType === "directory") { e.stopPropagation(); navigate(`/files/${n.id}`); } }} style={n.nodeType === "directory" ? { cursor: "pointer" } : undefined}>{n.name}</span>{isShared(n) && <Share2 size={13} className="faint" aria-label={t("Shared")} />}</div></td>
                  <td className="hide-mobile muted">{n.nodeType === "directory" ? "—" : formatSize(n.size)}</td>
                  <td className="hide-mobile muted">{formatListDate(n.modified ?? n.created)}</td>
                  <td style={{ textAlign: "right" }}><button className="icon-btn sm" onClick={(e) => { e.stopPropagation(); if (!selection.has(n.id)) { setSelection(new Set([n.id])); setAnchor(n.id); } setMenuNode(n); menu.open(e); }} aria-label={t("Options")}><MoreVertical size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Popover anchor={menu.anchor} onClose={menu.close} width={200}>
        {!menuNode && (
          <>
            <MenuItem icon={<Upload size={16} />} label={t("Upload files…")} onClick={() => inputRef.current?.click()} />
            <MenuItem icon={<FolderPlus size={16} />} label={t("New folder")} onClick={async () => { const n = await promptDialog({ title: t("New folder"), placeholder: t("Folder name") }); if (n?.trim()) { try { await files.mkdir(parentId, n.trim()); } catch (err) { toast.error((err as Error).message); } } }} />
          </>
        )}
        {menuNode && targets(menuNode).length > 1 && (
          <>
            <MenuItem icon={<FolderInput size={16} />} label={plural(targets(menuNode).length, { one: "Move {n} item…", other: "Move {n} items…" })} onClick={() => setMoveNodes(targets(menuNode))} />
            <MenuSep />
            <MenuItem danger icon={<Trash2 size={16} />} label={plural(targets(menuNode).length, { one: "Delete {n} item", other: "Delete {n} items" })} onClick={() => void removeNodes(targets(menuNode))} />
          </>
        )}
        {menuNode && targets(menuNode).length <= 1 && (
          <>
            {menuNode.nodeType === "directory" ? <MenuItem icon={<FolderOpen size={16} />} label={t("Open")} onClick={() => navigate(`/files/${menuNode.id}`)} /> : (
              <>
                {canPreview(menuNode) && <MenuItem icon={<Eye size={16} />} label={t("Preview")} onClick={() => openPreview(menuNode)} />}
                {canEditFile(menuNode) && <MenuItem icon={<FilePen size={16} />} label={t("Edit")} onClick={() => openPreview(menuNode, true)} />}
                <MenuItem icon={<Download size={16} />} label={t("Download")} onClick={() => download(menuNode)} />
              </>
            )}
            <MenuItem icon={<Pencil size={16} />} label={t("Rename")} disabled={!menuNode.myRights?.mayRename} onClick={async () => { const n = await promptDialog({ title: t("Rename"), defaultValue: menuNode.name }); if (n?.trim() && n !== menuNode.name) { try { await files.rename(menuNode.id, n.trim()); } catch (err) { toast.error((err as Error).message); } } }} />
            <MenuItem icon={<FolderInput size={16} />} label={t("Move to…")} onClick={() => setMoveNodes([menuNode])} />
            <MenuItem icon={<Share2 size={16} />} label={t("Share…")} disabled={!menuNode.myRights?.mayShare} onClick={() => setShareNode(menuNode)} />
            <MenuSep />
            <MenuItem danger icon={<Trash2 size={16} />} label={t("Delete")} disabled={!menuNode.myRights?.mayDelete} onClick={() => void removeNodes([menuNode])} />
          </>
        )}
      </Popover>
      {moveNodes && <MoveDialog nodes={moveNodes} onClose={() => setMoveNodes(null)} onMoved={() => setSelection(new Set())} />}
      <FilePreviewDialog
        file={preview}
        onClose={() => { setPreview(null); setEditTarget(null); setStartInEdit(false); }}
        onSave={editTarget && canEditNode(files.nodes[editTarget.id]) ? saveEdited : undefined}
        startInEdit={startInEdit}
      />
      {shareNode && <ShareDialog kind="FileNode" id={shareNode.id} name={shareNode.name} shareWith={shareNode.shareWith ?? null} onClose={() => setShareNode(null)} />}
    </div>
  );
}

function MoveDialog({ nodes, onClose, onMoved }: { nodes: FileNode[]; onClose: () => void; onMoved: () => void }) {
  const files = useFiles();
  const [cur, setCur] = useState<string | null>(null);
  useEffect(() => {
    void files.loadChildren(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);
  /* None of the folders being moved can be their own destination, and neither
     can a folder already holding all of them -- "Move here" would be a no-op. */
  const moving = new Set(nodes.map((n) => n.id));
  const dirs = (files.children[cur ?? "root"] ?? []).map((id) => files.nodes[id]).filter((n): n is FileNode => Boolean(n && n.nodeType === "directory" && !moving.has(n.id)));
  const path = files.pathTo(cur);
  const already = nodes.every((n) => (n.parentId ?? null) === cur);
  const title = nodes.length === 1 ? t("Move \u201c{name}\u201d", { name: nodes[0]!.name }) : plural(nodes.length, { one: "Move {n} item", other: "Move {n} items" });
  return (
    <Dialog open onClose={onClose} title={title} size="sm" footer={<><button className="btn" onClick={onClose}>{t("Cancel")}</button><button className="btn btn-primary" disabled={already} onClick={async () => { try { await files.moveMany(nodes.map((n) => n.id), cur); toast.success(t("Moved")); onMoved(); onClose(); } catch (err) { toast.error((err as Error).message); } }}>{t("Move here")}</button></>}>
      <div className="breadcrumb mb-8">
        <button onClick={() => setCur(null)}><Home size={14} /></button>
        {path.map((n) => <span key={n.id} className="row gap-4"><ChevronRight size={12} /><button onClick={() => setCur(n.id)}>{n.name}</button></span>)}
      </div>
      {dirs.map((d) => <button key={d.id} className="menu-item" onClick={() => setCur(d.id)}><Folder size={16} /><span className="grow">{d.name}</span><ChevronRight size={14} /></button>)}
      {!dirs.length && <p className="hint">{t("No subfolders here.")}</p>}
    </Dialog>
  );
}
