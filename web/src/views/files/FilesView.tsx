import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ChevronRight, Download, File, Folder, FolderPlus, FolderOpen, Home, MoreVertical, Pencil, Share2, Trash2, Upload, FolderInput } from "lucide-react";
import { useFiles } from "@/store/files";
import { client } from "@/jmap/client";
import type { FileNode } from "@/jmap/types";
import { formatSize, formatListDate } from "@/lib/format";
import { canDropFileNode, isShared } from "@/lib/filenode";
import { entriesFromDrop, hasDirectory, planUpload } from "@/lib/dropUpload";
import { NODE_MIME } from "./FilesTree";
import { ShareDialog } from "../settings/ShareDialog";
import { Empty, Spinner } from "@/ui/misc";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog, Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { t } from "@/lib/i18n";

export function FilesView({ nodeId }: { nodeId?: string }) {
  const [, navigate] = useLocation();
  const files = useFiles();
  const parentId = nodeId ?? null;
  const [dropping, setDropping] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const menu = useMenu();
  const [menuNode, setMenuNode] = useState<FileNode | null>(null);
  const [moveNode, setMoveNode] = useState<FileNode | null>(null);
  const [shareNode, setShareNode] = useState<FileNode | null>(null);
  /* Shared with the sidebar tree, so a row dragged onto a folder there is
     recognised. See the note on `draggingId` in the store. */
  const draggingId = files.draggingId;
  const setDraggingId = files.setDragging;
  const inputRef = useRef<HTMLInputElement>(null);

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
      const id = e.dataTransfer.getData(NODE_MIME);
      setDraggingId(null);
      if (id && canDropFileNode(files.nodes, id, into)) {
        void files.move(id, into).catch((err) => toast.error((err as Error).message));
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

  const download = (n: FileNode) => {
    if (!n.blobId) return;
    const a = document.createElement("a");
    a.href = client.downloadUrl(files.accountId!, n.blobId, n.name, n.type ?? "application/octet-stream");
    a.download = n.name;
    a.click();
  };

  return (
    <div className={`files-layout ${dropping ? "dropping" : ""}`} onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } else if (e.dataTransfer.types.includes(NODE_MIME) && canDropFileNode(files.nodes, draggingId ?? "", parentId)) { e.preventDefault(); } }} onDragLeave={() => setDropping(false)} onDrop={onDrop}>
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
        <button className="btn btn-sm" onClick={async () => { const n = await promptDialog({ title: "New folder", placeholder: "Folder name" }); if (n?.trim()) { try { await files.mkdir(parentId, n.trim()); } catch (err) { toast.error((err as Error).message); } } }}><FolderPlus size={16} />  {t("New folder")}</button>
      </div>
      {files.uploads.length > 0 && (
        <div className="list-hint" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          {files.uploads.map((u) => <div key={u.id} className="row"><span className="truncate grow">{u.name}</span>{u.error ? <span style={{ color: "var(--danger)" }}>{u.error}</span> : <span>{u.progress}%</span>}</div>)}
        </div>
      )}
      {files.error && <div className="error-box" style={{ margin: 12 }}>{files.error}</div>}
      <div
        className="files-scroll"
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
                  className={`${selected === n.id ? "selected" : ""} ${draggingId && n.nodeType === "directory" && canDropFileNode(files.nodes, draggingId, n.id) ? "drop-target" : ""}`}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData(NODE_MIME, n.id); e.dataTransfer.effectAllowed = "move"; setDraggingId(n.id); }}
                  onDragEnd={() => setDraggingId(null)}
                  onDragOver={(e) => {
                    if (n.nodeType !== "directory") return;
                    const node = e.dataTransfer.types.includes(NODE_MIME);
                    if (node ? !(draggingId && canDropFileNode(files.nodes, draggingId, n.id)) : !e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = node ? "move" : "copy";
                  }}
                  onDrop={(e) => { if (n.nodeType === "directory") dropOnto(n.id, e); }}
                  onClick={() => setSelected(n.id)} onDoubleClick={() => (n.nodeType === "directory" ? navigate(`/files/${n.id}`) : download(n))} onContextMenu={(e) => { e.preventDefault(); setMenuNode(n); menu.openAt(e.clientX, e.clientY); }}>
                  <td><div className="f-name">{n.nodeType === "directory" ? <Folder size={18} /> : <File size={18} />}<span onClick={(e) => { if (n.nodeType === "directory") { e.stopPropagation(); navigate(`/files/${n.id}`); } }} style={n.nodeType === "directory" ? { cursor: "pointer" } : undefined}>{n.name}</span>{isShared(n) && <Share2 size={13} className="faint" aria-label={t("Shared")} />}</div></td>
                  <td className="hide-mobile muted">{n.nodeType === "directory" ? "—" : formatSize(n.size)}</td>
                  <td className="hide-mobile muted">{formatListDate(n.modified ?? n.created)}</td>
                  <td style={{ textAlign: "right" }}><button className="icon-btn sm" onClick={(e) => { e.stopPropagation(); setMenuNode(n); menu.open(e); }} aria-label={t("Options")}><MoreVertical size={16} /></button></td>
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
            <MenuItem icon={<FolderPlus size={16} />} label={t("New folder")} onClick={async () => { const n = await promptDialog({ title: "New folder", placeholder: "Folder name" }); if (n?.trim()) { try { await files.mkdir(parentId, n.trim()); } catch (err) { toast.error((err as Error).message); } } }} />
          </>
        )}
        {menuNode && (
          <>
            {menuNode.nodeType === "directory" ? <MenuItem icon={<FolderOpen size={16} />} label={t("Open")} onClick={() => navigate(`/files/${menuNode.id}`)} /> : <MenuItem icon={<Download size={16} />} label={t("Download")} onClick={() => download(menuNode)} />}
            <MenuItem icon={<Pencil size={16} />} label={t("Rename")} disabled={!menuNode.myRights?.mayRename} onClick={async () => { const n = await promptDialog({ title: "Rename", defaultValue: menuNode.name }); if (n?.trim() && n !== menuNode.name) { try { await files.rename(menuNode.id, n.trim()); } catch (err) { toast.error((err as Error).message); } } }} />
            <MenuItem icon={<FolderInput size={16} />} label={t("Move to…")} onClick={() => setMoveNode(menuNode)} />
            <MenuItem icon={<Share2 size={16} />} label={t("Share…")} disabled={!menuNode.myRights?.mayShare} onClick={() => setShareNode(menuNode)} />
            <MenuSep />
            <MenuItem danger icon={<Trash2 size={16} />} label={t("Delete")} disabled={!menuNode.myRights?.mayDelete} onClick={async () => { if (await confirmDialog({ title: `Delete “${menuNode.name}”?`, confirmLabel: "Delete", danger: true })) { try { await files.destroy([menuNode.id]); toast.success("Deleted"); } catch (err) { toast.error((err as Error).message); } } }} />
          </>
        )}
      </Popover>
      {moveNode && <MoveDialog node={moveNode} onClose={() => setMoveNode(null)} />}
      {shareNode && <ShareDialog kind="FileNode" id={shareNode.id} name={shareNode.name} shareWith={shareNode.shareWith ?? null} onClose={() => setShareNode(null)} />}
    </div>
  );
}

function MoveDialog({ node, onClose }: { node: FileNode; onClose: () => void }) {
  const files = useFiles();
  const [cur, setCur] = useState<string | null>(null);
  useEffect(() => {
    void files.loadChildren(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);
  const dirs = (files.children[cur ?? "root"] ?? []).map((id) => files.nodes[id]).filter((n): n is FileNode => Boolean(n && n.nodeType === "directory" && n.id !== node.id));
  const path = files.pathTo(cur);
  return (
    <Dialog open onClose={onClose} title={`Move “${node.name}”`} size="sm" footer={<><button className="btn" onClick={onClose}>{t("Cancel")}</button><button className="btn btn-primary" disabled={cur === (node.parentId ?? null)} onClick={async () => { try { await files.move(node.id, cur); toast.success("Moved"); onClose(); } catch (err) { toast.error((err as Error).message); } }}>{t("Move here")}</button></>}>
      <div className="breadcrumb mb-8">
        <button onClick={() => setCur(null)}><Home size={14} /></button>
        {path.map((n) => <span key={n.id} className="row gap-4"><ChevronRight size={12} /><button onClick={() => setCur(n.id)}>{n.name}</button></span>)}
      </div>
      {dirs.map((d) => <button key={d.id} className="menu-item" onClick={() => setCur(d.id)}><Folder size={16} /><span className="grow">{d.name}</span><ChevronRight size={14} /></button>)}
      {!dirs.length && <p className="hint">{t("No subfolders here.")}</p>}
    </Dialog>
  );
}
