/**
 * The `ihasmail` folder in JMAP Files, where the client keeps its own state:
 * signature images and over-sized signature HTML (Stalwart caps a signature at
 * 2 KB), and the synced settings file.
 *
 * It is a real folder in the user's account — that is the whole point, since it
 * is what makes this state travel between devices without ihasmail storing
 * anything server-side of its own — but it is housekeeping rather than
 * something anyone filed there, so the Files view hides it. See `isAppFolder`.
 *
 * Both lookups below filter on `parentId`/`isTopLevel` alone and match the name
 * here rather than asking the server to. Those are the filters Files itself
 * relies on; `name` is not one Stalwart is known to implement, and a filter it
 * does not know fails the whole query rather than being ignored.
 */
import { client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, Id, SetResponse } from "@/jmap/types";
import { directoryCreate } from "@/lib/filenode";

export const APP_FOLDER = "ihasmail";

/** Just enough to find the folder. */
export const folderProps = (): string[] => ["id", "name", "nodeType", "parentId"];

/** The client's own folder, which the Files view does not show. */
export function isAppFolder(n: Pick<FileNode, "name" | "parentId" | "nodeType">): boolean {
  return n.name === APP_FOLDER && !n.parentId && n.nodeType === "directory";
}

/** List one level of the tree: the top level, or the children of a folder. */
async function children(accountId: Id, parentId: Id | null, properties: string[]): Promise<FileNode[]> {
  const filter = parentId ? { parentId } : { isTopLevel: true };
  const res = await client.chain([
    ["FileNode/query", { accountId, filter, limit: 1000 }, "q"],
    ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties }, "g"],
  ]);
  return (res.get("g")?.[0] as unknown as GetResponse<FileNode>).list;
}

/** Find the app folder, or make it. Returns its node id. */
export async function ensureFolder(accountId: Id): Promise<Id> {
  const existing = (await children(accountId, null, folderProps())).find(isAppFolder);
  if (existing) return existing.id;
  const set = await client.call<SetResponse<FileNode>>("FileNode/set", { accountId, create: { d: directoryCreate(null, APP_FOLDER) } });
  const err = set.notCreated?.d;
  if (err) throw new Error(setErrorMessage(err));
  return set.created!.d!.id;
}

/**
 * A node's persistent blobId. `FileNode/set` does not return one on create, so
 * anything that needs the blob straight after making the node has to ask.
 */
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
  const props = ["id", "name", "parentId", "blobId", "size", "type", "nodeType"];
  const list = await children(accountId, folderId, props);
  return list.find((n) => n.name === name && n.parentId === folderId);
}
