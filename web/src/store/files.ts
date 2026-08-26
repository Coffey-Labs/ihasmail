import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import { directoryCreate, fileCreate, fileNodeProps } from "@/lib/filenode";
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

  init(): Promise<void>;
  loadChildren(parentId: Id | null): Promise<void>;
  mkdir(parentId: Id | null, name: string): Promise<Id>;
  upload(parentId: Id | null, files: File[]): Promise<void>;
  rename(id: Id, name: string): Promise<void>;
  move(id: Id, parentId: Id | null): Promise<void>;
  destroy(ids: Id[]): Promise<void>;
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

export const useFiles = create<FilesState>((set, get) => ({
  accountId: null,
  available: false,
  nodes: {},
  children: {},
  loading: false,
  error: null,
  uploads: [],

  async init() {
    const accountId = useSession.getState().accountFor(CAP.filenode);
    const available = Boolean(accountId && client.hasCapability(CAP.filenode));
    if (accountId !== get().accountId) set({ accountId, nodes: {}, children: {} });
    set({ available });
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

  async rename(id, name) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("FileNode/set", { accountId, update: { [id]: { name } } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadChildren(get().nodes[id]?.parentId ?? null);
  },

  async move(id, parentId) {
    const accountId = get().accountId!;
    const from = get().nodes[id]?.parentId ?? null;
    const res = await client.call<SetResponse>("FileNode/set", { accountId, update: { [id]: { parentId } } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await Promise.all([get().loadChildren(from), get().loadChildren(parentId)]);
  },

  async destroy(ids) {
    const accountId = get().accountId!;
    const parents = new Set(ids.map((id) => get().nodes[id]?.parentId ?? null));
    const res = await client.call<SetResponse>("FileNode/set", { accountId, destroy: ids, onDestroyRemoveChildren: true });
    const failed = Object.values(res.notDestroyed ?? {})[0];
    if (failed) throw new Error(setErrorMessage(failed));
    for (const p of parents) await get().loadChildren(p);
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
