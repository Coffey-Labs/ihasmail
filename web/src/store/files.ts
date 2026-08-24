import { create } from "zustand";
import { CAP, JmapMethodError, client, setErrorMessage } from "@/jmap/client";
import { directoryCreate, fileCreate, fileNodeProps, normalizeFileNodes, queryOmitsDirectories } from "@/lib/filenode";
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


/** Whether the server supports parentId/isTopLevel query filters (detected at runtime). */
let filtersSupported = true;

const byName = (a: FileNode, b: FileNode) => (a.nodeType === b.nodeType ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.nodeType === "directory" ? -1 : 1);

/** Fetch all nodes (paged, no filter) and rebuild the full children map. */
async function loadAllNodes(accountId: Id, set: (fn: (s: FilesState) => Partial<FilesState>) => void): Promise<void> {
  const all: FileNode[] = [];
  if (queryOmitsDirectories()) {
    // Query would hand back files only, so every folder — including one just
    // created — would be missing with nothing to say why. Ask get for the lot.
    const res = await client.call<GetResponse<FileNode>>("FileNode/get", { accountId, ids: null, properties: fileNodeProps() });
    all.push(...normalizeFileNodes(res.list));
  } else {
    let position = 0;
    for (let guard = 0; guard < 100; guard++) {
      const res = await client.chain([
        ["FileNode/query", { accountId, position, limit: 500, calculateTotal: true }, "q"],
        ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: fileNodeProps() }, "g"],
      ]);
      const q = res.get("q")?.[0] as unknown as QueryResponse;
      const g = res.get("g")?.[0] as unknown as GetResponse<FileNode>;
      all.push(...normalizeFileNodes(g.list));
      position += q.ids.length;
      if (!q.ids.length || (q.total != null && position >= q.total)) break;
    }
  }
  const nodes: Record<Id, FileNode> = {};
  const children: Record<string, Id[]> = { root: [] };
  for (const n of all) nodes[n.id] = n;
  for (const n of all.sort(byName)) {
    const key = n.parentId && nodes[n.parentId] ? n.parentId : "root";
    (children[key] ??= []).push(n.id);
  }
  for (const n of all) children[n.id] ??= [];
  set(() => ({ nodes, children, loading: false, error: null }));
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
      if (!filtersSupported || queryOmitsDirectories()) {
        await loadAllNodes(accountId, set);
        return;
      }
      const filter = parentId ? { parentId } : { isTopLevel: true };
      const res = await client.chain([
        ["FileNode/query", { accountId, filter, sort: [{ property: "nodeType", isAscending: false }, { property: "name", isAscending: true }], limit: 1000 }, "q"],
        ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: fileNodeProps() }, "g"],
      ]);
      const q = res.get("q")?.[0] as unknown as QueryResponse;
      const g = res.get("g")?.[0] as unknown as GetResponse<FileNode>;
      set((s) => {
        const nodes = { ...s.nodes };
        for (const n of normalizeFileNodes(g.list)) nodes[n.id] = n;
        return { nodes, children: { ...s.children, [parentId ?? "root"]: q.ids }, loading: false, error: null };
      });
    } catch (err) {
      // Older Stalwart releases don't support parentId / isTopLevel filters: fall back to
      // fetching every node and building the tree client-side.
      if (err instanceof JmapMethodError && (err.type === "unsupportedFilter" || err.type === "unsupportedSort")) {
        filtersSupported = false;
        try {
          await loadAllNodes(accountId, set);
          return;
        } catch (err2) {
          set({ loading: false, error: (err2 as Error).message });
          return;
        }
      }
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
