/**
 * The `ihasmail` folder in JMAP Files, where the client keeps its own state:
 * signature images and over-sized signature HTML (Stalwart caps a signature at
 * 2 KB), and the synced settings file.
 *
 * It is a real folder in the user's account — that is the whole point, since it
 * is what makes this state travel between devices without ihasmail storing
 * anything server-side of its own — but it is housekeeping rather than
 * something anyone filed there, so the Files view hides it. See `isAppFolder`.
 */
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { directoryCreate, normalizeFileNodes, queryOmitsDirectories, supportsNodeType } from "@/lib/filenode";

export const APP_FOLDER = "ihasmail";

/** Just enough to find the folder, asking for nodeType only where it exists. */
export const folderProps = (): string[] =>
  supportsNodeType() ? ["id", "name", "nodeType", "parentId"] : ["id", "name", "parentId", "blobId", "size", "type"];

/** The client's own folder, which the Files view does not show. */
export function isAppFolder(n: Pick<FileNode, "name" | "parentId" | "nodeType">): boolean {
  return n.name === APP_FOLDER && !n.parentId && n.nodeType === "directory";
}

/** Every node in the account, for servers whose query cannot see directories. */
async function allNodes(accountId: Id, properties: string[]): Promise<FileNode[]> {
  const res = await client.call<GetResponse<FileNode>>("FileNode/get", { accountId, ids: null, properties });
  return normalizeFileNodes(res.list);
}

/** Find the app folder, or make it. Returns its node id. */
export async function ensureFolder(accountId: Id): Promise<Id> {
  const props = folderProps();
  let list: FileNode[] = [];
  if (queryOmitsDirectories()) {
    // Query cannot see a directory on these servers, so it would never find the
    // folder and we would make a fresh one on every save. Ask get for the lot.
    list = await allNodes(accountId, props);
  } else {
    try {
      const res = await client.chain([
        ["FileNode/query", { accountId, filter: { isTopLevel: true, nodeType: "directory", name: APP_FOLDER }, limit: 5 }, "q"],
        ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: props }, "g"],
      ]);
      list = normalizeFileNodes((res.get("g")?.[0] as unknown as GetResponse<FileNode>).list);
    } catch {
      // Filters unsupported: scan everything and pick it out here.
      const res = await client.chain([
        ["FileNode/query", { accountId, limit: 1000 }, "q"],
        ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: props }, "g"],
      ]);
      list = normalizeFileNodes((res.get("g")?.[0] as unknown as GetResponse<FileNode>).list);
    }
  }
  const existing = list.find(isAppFolder);
  if (existing) return existing.id;
  const set = await client.call<SetResponse<FileNode>>("FileNode/set", { accountId, create: { d: directoryCreate(null, APP_FOLDER) } });
  const err = set.notCreated?.d;
  if (err) throw new Error(setErrorMessage(err));
  return set.created!.d!.id;
}

/** A node's persistent blobId, for servers that do not return one on create. */
export async function nodeBlobId(accountId: Id, id?: Id): Promise<Id | undefined> {
  if (!id) return undefined;
  try {
    const res = await client.call<GetResponse<FileNode>>("FileNode/get", { accountId, ids: [id], properties: ["id", "blobId"] });
    return res.list[0]?.blobId ?? undefined;
  } catch {
    return undefined;
  }
}

/** Find a file by name inside the app folder. */
export async function findInFolder(accountId: Id, folderId: Id, name: string): Promise<FileNode | undefined> {
  const props = ["id", "name", "parentId", "blobId", "size", "type", ...(supportsNodeType() ? ["nodeType"] : [])];
  try {
    const res = await client.chain([
      ["FileNode/query", { accountId, filter: { parentId: folderId, name }, limit: 5 }, "q"],
      ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: props }, "g"],
    ]);
    const list = normalizeFileNodes((res.get("g")?.[0] as unknown as GetResponse<FileNode>).list);
    const hit = list.find((n) => n.name === name && n.parentId === folderId);
    if (hit) return hit;
  } catch {
    /* filters unsupported: fall through to the full scan */
  }
  const list = await allNodes(accountId, props);
  return list.find((n) => n.name === name && n.parentId === folderId);
}
