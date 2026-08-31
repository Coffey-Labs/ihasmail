import { useEffect, useState } from "react";
import { ChevronRight, File as FileIcon, Folder, HardDrive, Users } from "lucide-react";
import { Dialog } from "@/ui/dialog";
import { Spinner } from "@/ui/misc";
import { useFiles } from "@/store/files";
import type { AttachableFile } from "@/store/compose";
import type { FileNode } from "@/jmap/types";
import { formatSize } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * Pick something already in Files to attach.
 *
 * Browsing is the store's, so this shows the same folders the Files view does,
 * shared accounts included -- a file somebody shared with you is a file you can
 * send on, and having to download it first only to upload it again would be
 * the sort of detour the rest of this avoids.
 *
 * It borrows the Files store rather than keeping its own copy, which means
 * opening the picker moves where Files is browsing. Closing it puts that back:
 * a detour through somebody's shared folder to find an attachment should not
 * leave the file manager somewhere else afterwards.
 */
export function FilePicker({ onPick, onClose }: { onPick: (files: AttachableFile[]) => void; onClose: () => void }) {
  const files = useFiles();
  const [cur, setCur] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, FileNode>>({});
  const [returnTo] = useState(() => files.accountId);

  useEffect(() => {
    void files.loadChildren(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, files.accountId]);

  const close = () => {
    if (files.accountId !== returnTo) files.openAccount(returnTo);
    onClose();
  };

  const openAccount = (accountId: string | null) => {
    files.openAccount(accountId);
    setCur(null);
    setPicked({});
  };

  const nodes = (files.children[cur ?? "root"] ?? []).map((id) => files.nodes[id]).filter((n): n is FileNode => Boolean(n));
  const path = files.pathTo(cur);
  const chosen = Object.values(picked);
  const viewingShare = files.accountId !== files.ownAccountId;

  return (
    <Dialog
      open
      onClose={close}
      title={t("Attach from Files")}
      size="md"
      footer={
        <>
          <button className="btn" onClick={close}>{t("Cancel")}</button>
          <button
            className="btn btn-primary"
            disabled={!chosen.length}
            onClick={() => {
              onPick(chosen.map((n) => ({ accountId: files.accountId!, name: n.name, type: n.type, size: n.size, blobId: n.blobId! })));
              close();
            }}
          >
            {chosen.length > 1 ? `Attach ${chosen.length} files` : "Attach"}
          </button>
        </>
      }
    >
      {files.sharedAccounts.length > 0 && (
        <div className="row wrap gap-4" style={{ marginBottom: 10 }}>
          <button className={`btn btn-sm ${viewingShare ? "" : "btn-primary"}`} onClick={() => openAccount(files.ownAccountId)}>
            <HardDrive size={14} />  {t("My files")}
          </button>
          {files.sharedAccounts.map((a) => (
            <button key={a.id} className={`btn btn-sm ${files.accountId === a.id ? "btn-primary" : ""}`} onClick={() => openAccount(a.id)}>
              <Users size={14} /> {a.name}
            </button>
          ))}
        </div>
      )}

      <div className="breadcrumb mb-8">
        <button onClick={() => setCur(null)}><HardDrive size={14} /></button>
        {path.map((n) => (
          <span key={n.id} className="row gap-4">
            <ChevronRight size={12} />
            <button onClick={() => setCur(n.id)}>{n.name}</button>
          </span>
        ))}
      </div>

      {files.loading && !nodes.length ? (
        <Spinner />
      ) : !nodes.length ? (
        <p className="hint">{t("This folder is empty.")}</p>
      ) : (
        nodes.map((n) =>
          n.nodeType === "directory" ? (
            <button key={n.id} className="menu-item" onClick={() => setCur(n.id)}>
              <Folder size={16} />
              <span className="grow truncate">{n.name}</span>
              <ChevronRight size={14} />
            </button>
          ) : (
            <label key={n.id} className="menu-item" style={{ cursor: n.blobId ? "pointer" : "not-allowed", opacity: n.blobId ? 1 : 0.5 }}>
              <input
                type="checkbox"
                disabled={!n.blobId}
                checked={Boolean(picked[n.id])}
                onChange={(e) =>
                  setPicked((p) => {
                    const next = { ...p };
                    if (e.target.checked) next[n.id] = n;
                    else delete next[n.id];
                    return next;
                  })
                }
              />
              <FileIcon size={16} />
              <span className="grow truncate">{n.name}</span>
              <span className="hint">{formatSize(n.size)}</span>
            </label>
          ),
        )
      )}

      {viewingShare && chosen.length > 0 && (
        // Blobs belong to the account holding them, so one from a share has to
        // be copied into yours before a draft can reference it. Worth saying,
        // because it is the difference between instant and a wait.
        <p className="hint" style={{ marginTop: 10 }}>{t("Shared files are copied to your account when attached.")}</p>
      )}
    </Dialog>
  );
}
