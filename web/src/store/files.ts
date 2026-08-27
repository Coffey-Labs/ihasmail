import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import { directoryCreate, fileCreate, fileNodeProps } from "@/lib/filenode";
import { foldersNeeded, type PlannedUpload } from "@/lib/dropUpload";
import { isAppFolder } from "@/lib/appFolder";
import type { FileNode, GetResponse, Id, QueryResponse, SetResponse } from "@/jmap/types";
import { useSession } from "./session";

interface FilesState {
  accountId: Id | null;
  available: boolean;
  nodes: Record<Id, FileNode>;
  children: Record<string, Id[]>; // parentId ("root" for null) → ids
  loading: boolean;
  error: string | null;
  uploads: Array<{ id: string; name: string; progress: number; error: string | null }>;
  dirIds: Id[];
  treeLoaded: boolean;
  /*
   * The node being dragged, if any.
   *
   * Kept here rather than in whichever pane started the drag, because a drag
   * crosses between them -- a row dragged onto the sidebar tree, a folder in
   * the tree dragged onto a row -- and every possible target has to know what
   * is in flight to say whether it will take it. Two panes each holding their
   * own copy meant the one that did not start the drag never lit up and never
   * accepted the drop.
   *
   * It cannot be read from the drag itself: `dataTransfer.getData` is blocked
   * during dragover, which is exactly when the answer is needed.
   */
  draggingId: Id | null;

  init(): Promise<void>;
  loadChildren(parentId: Id | null): Promise<void>;
  mkdir(parentId: Id | null, name: string): Promise<Id>;
  upload(parentId: Id | null, files: File[]): Promise<void>;
  rename(id: Id, name: string): Promise<void>;
  move(id: Id, parentId: Id | null): Promise<void>;
  destroy(ids: Id[]): Promise<void>;
  refresh(ids: Id[]): Promise<void>;
  setDragging(id: Id | null): void;
  /** Every directory in the account, for the tree in the sidebar. */
  loadTree(): Promise<void>;
  /** Upload a planned drop, creating the folders it needs as it goes. */
  uploadPlan(parentId: Id | null, plan: PlannedUpload[]): Promise<void>;
  pathTo(id: Id | null): FileNode[];
  applyChanges(types: Set<string>): void;
}



/**
 * Drop the client's own `ihasmail` folder, and everything inside it, from a
 * listing. It holds signature images and the synced settings file — real nodes
 * in the account, but housekeeping rather than anything the user filed.
 *
 * The contents have to go too: the tree attaches a node whose parent is missing
 * to the root, so hiding the folder alone would spill its files into the top
 * level, which is worse than showing the folder.
 */
export function withoutAppFolder(nodes: FileNode[]): FileNode[] {
  const hidden = new Set<Id>();
  for (const n of nodes) if (isAppFolder(n)) hidden.add(n.id);
  if (!hidden.size) return nodes;
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of nodes) {
      if (!hidden.has(n.id) && n.parentId && hidden.has(n.parentId)) {
        hidden.add(n.id);
        grew = true;
      }
    }
  }
  return nodes.filter((n) => !hidden.has(n.id));
}

/**
 * The state that belongs to one account, emptied when the selection moves.
 *
 * Every field here describes somebody's files, so none of it survives a switch
 * to somebody else's. `treeLoaded` is the one that bites: leave it true and the
 * sidebar never asks the new account for its folders, while `dirIds` still
 * names the old account's, which no longer resolve -- so the tree is simply
 * empty, with nothing to say why. That shipped, and is what this exists to stop
 * happening again: the test asserts the whole set, so a field added to the
 * store and forgotten here fails rather than quietly persisting across
 * accounts.
 */
export function emptyForAccount(accountId: Id | null) {
  return { accountId, nodes: {}, children: {}, dirIds: [], treeLoaded: false, draggingId: null, error: null };
}

export const useFiles = create<FilesState>((set, get) => ({
  accountId: null,
  available: false,
  nodes: {},
  children: {},
  loading: false,
  error: null,
  uploads: [],
  dirIds: [],
  treeLoaded: false,
  draggingId: null,

  async init() {
    const accountId = useSession.getState().accountFor(CAP.filenode);
    const available = Boolean(accountId && client.hasCapability(CAP.filenode));
    if (accountId !== get().accountId) set(emptyForAccount(accountId));
    set({ available });
  },

  /*
   * The whole directory tree in one query.
   *
   * `filter: { nodeType: "directory" }` returns every folder in the account,
   * confirmed against 0.16.19 on 2026-08-27, so the sidebar tree is complete
   * from the first paint: expanding costs nothing, and a drag knows every
   * folder it could be dropped on without having opened it first.
   *
   * It is deliberately its own request rather than a call appended to another.
   * A filter Stalwart refuses fails with a request-level 400 that takes every
   * method call in the request with it -- `{ parentId: null }` does exactly
   * that -- so a tree query batched alongside the folder listing would blank
   * the whole view instead of just the sidebar.
   */
  async loadTree() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.chain([
        ["FileNode/query", { accountId, filter: { nodeType: "directory" }, sort: [{ property: "name", isAscending: true }], limit: 1000 }, "q"],
        ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: fileNodeProps() }, "g"],
      ]);
      const g = res.get("g")?.[0] as unknown as GetResponse<FileNode>;
      // Filtered again here rather than trusted: a server that ignores the
      // nodeType filter answers with files as well, and the tree would draw
      // them as folders you could open into nothing.
      const dirs = withoutAppFolder(g.list).filter((n) => n.nodeType === "directory");
      set((s) => {
        const nodes = { ...s.nodes };
        for (const n of dirs) nodes[n.id] = n;
        return { nodes, dirIds: dirs.map((n) => n.id), treeLoaded: true };
      });
    } catch (err) {
      // The listing still works without a tree, so this must not blank the view.
      set({ error: (err as Error).message, treeLoaded: true });
    }
  },

  async loadChildren(parentId) {
    const accountId = get().accountId;
    if (!accountId) return;
    set({ loading: true });
    try {
      const filter = parentId ? { parentId } : { isTopLevel: true };
      const res = await client.chain([
        ["FileNode/query", { accountId, filter, sort: [{ property: "nodeType", isAscending: false }, { property: "name", isAscending: true }], limit: 1000 }, "q"],
        ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: fileNodeProps() }, "g"],
      ]);
      const q = res.get("q")?.[0] as unknown as QueryResponse;
      const g = res.get("g")?.[0] as unknown as GetResponse<FileNode>;
      const listed = withoutAppFolder(g.list);
      const keep = new Set(listed.map((n) => n.id));
      set((s) => {
        const nodes = { ...s.nodes };
        for (const n of listed) nodes[n.id] = n;
        return { nodes, children: { ...s.children, [parentId ?? "root"]: q.ids.filter((id) => keep.has(id)) }, loading: false, error: null };
      });
    } catch (err) {
      // There used to be a fallback here that abandoned filters and fetched
      // every node in the account, because 0.15 refused parentId/isTopLevel.
      // 0.16 supports them, and quietly loading the whole tree instead would
      // hide a real fault behind a performance cliff nobody would notice.
      set({ loading: false, error: (err as Error).message });
    }
  },

  async mkdir(parentId, name) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse<FileNode>>("FileNode/set", { accountId, create: { d: directoryCreate(parentId, name) } });
    const err = res.notCreated?.d;
    if (err) throw new Error(setErrorMessage(err));
    await get().loadChildren(parentId);
    void get().loadTree();
    return res.created!.d!.id;
  },

  async upload(parentId, files) {
    const accountId = get().accountId!;
    for (const f of files) {
      const id = `${Date.now()}-${f.name}`;
      set((s) => ({ uploads: [...s.uploads, { id, name: f.name, progress: 0, error: null }] }));
      try {
        const up = await client.upload(accountId, f, {
          type: f.type || "application/octet-stream",
          onProgress: (l, t) => set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, progress: Math.round((l / t) * 100) } : u)) })),
        });
        const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
          accountId,
          create: { f: fileCreate(parentId, f.name, up.blobId, f.type || "application/octet-stream") },
        });
        const err = res.notCreated?.f;
        if (err) throw new Error(setErrorMessage(err));
        set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
      } catch (err) {
        set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, error: (err as Error).message } : u)) }));
      }
    }
    await get().loadChildren(parentId);
  },

  /* Re-read named nodes in place. Sharing changes one property of one node and
     nothing about which folder it sits in, so reloading the level around it
     would be a bigger round trip to land in the same place. */
  setDragging(id) {
    set({ draggingId: id });
  },

  async refresh(ids) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return;
    const res = await client.call<GetResponse<FileNode>>("FileNode/get", { accountId, ids, properties: fileNodeProps() });
    set((s) => {
      const nodes = { ...s.nodes };
      for (const n of res.list) nodes[n.id] = n;
      return { nodes };
    });
  },

  async uploadPlan(parentId, plan) {
    // Folders first, parents before children, so every file has somewhere to go.
    const dirIds = new Map<string, Id | null>([["", parentId]]);
    for (const path of foldersNeeded(plan)) {
      const parent = dirIds.get(path.slice(0, -1).join(" ")) ?? parentId;
      const name = path[path.length - 1]!;
      try {
        dirIds.set(path.join(" "), await get().mkdir(parent, name));
      } catch (err) {
        // Leave it unmapped: its files land in the nearest folder that exists
        // rather than vanishing, and the error is shown against the upload.
        set({ error: (err as Error).message });
      }
    }
    const byFolder = new Map<string, File[]>();
    for (const item of plan) {
      const key = item.path.join(" ");
      byFolder.set(key, [...(byFolder.get(key) ?? []), item.file]);
    }
    for (const [key, files] of byFolder) await get().upload(dirIds.get(key) ?? parentId, files);
    void get().loadTree();
  },

  async rename(id, name) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("FileNode/set", { accountId, update: { [id]: { name } } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadChildren(get().nodes[id]?.parentId ?? null);
    void get().loadTree();
  },

  async move(id, parentId) {
    const accountId = get().accountId!;
    const from = get().nodes[id]?.parentId ?? null;
    const res = await client.call<SetResponse>("FileNode/set", { accountId, update: { [id]: { parentId } } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await Promise.all([get().loadChildren(from), get().loadChildren(parentId)]);
    void get().loadTree();
  },

  async destroy(ids) {
    const accountId = get().accountId!;
    const parents = new Set(ids.map((id) => get().nodes[id]?.parentId ?? null));
    const res = await client.call<SetResponse>("FileNode/set", { accountId, destroy: ids, onDestroyRemoveChildren: true });
    const failed = Object.values(res.notDestroyed ?? {})[0];
    if (failed) throw new Error(setErrorMessage(failed));
    for (const p of parents) await get().loadChildren(p);
    void get().loadTree();
  },

  pathTo(id) {
    const out: FileNode[] = [];
    let cur = id ? get().nodes[id] : undefined;
    let guard = 0;
    while (cur && guard++ < 50) {
      out.unshift(cur);
      cur = cur.parentId ? get().nodes[cur.parentId] : undefined;
    }
    return out;
  },

  applyChanges(types) {
    if (types.has("FileNode")) {
      for (const key of Object.keys(get().children)) void get().loadChildren(key === "root" ? null : key);
    }
  },
}));

useSession.subscribe((s) => {
  if (s.status !== "authenticated") useFiles.setState({ accountId: null, nodes: {}, children: {} });
});
