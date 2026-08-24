/**
 * Signature images: Stalwart caps identity signatures at 2 KB, so pictures can't
 * be embedded as data: URLs. Instead we store them in JMAP Files (persistent
 * blobs) under an "ihasmail" folder and reference them by blob URL; the composer
 * turns such references into inline cid: parts when sending.
 */
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { FileNode, GetResponse, QueryResponse, SetResponse } from "@/jmap/types";
import { directoryCreate, fileCreate, supportsNodeType, normalizeFileNodes } from "@/lib/filenode";
import { useSession } from "@/store/session";
import { toast } from "@/ui/toast";

const FOLDER = "ihasmail";

/** Just enough to find the folder, asking for nodeType only where it exists. */
const folderProps = () => (supportsNodeType() ? ["id", "name", "nodeType", "parentId"] : ["id", "name", "parentId", "blobId", "size", "type"]);

async function ensureFolder(accountId: string): Promise<string> {
  let list: FileNode[] = [];
  try {
    const res = await client.chain([
      ["FileNode/query", { accountId, filter: { isTopLevel: true, nodeType: "directory", name: FOLDER }, limit: 5 }, "q"],
      ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: folderProps() }, "g"],
    ]);
    list = normalizeFileNodes((res.get("g")?.[0] as unknown as GetResponse<FileNode>).list);
  } catch {
    // Older servers: no filter support — scan everything.
    const res = await client.chain([
      ["FileNode/query", { accountId, limit: 1000 }, "q"],
      ["FileNode/get", { accountId, "#ids": { resultOf: "q", name: "FileNode/query", path: "/ids" }, properties: folderProps() }, "g"],
    ]);
    list = normalizeFileNodes((res.get("g")?.[0] as unknown as GetResponse<FileNode>).list);
  }
  const existing = list.find((n) => n.name === FOLDER && n.nodeType === "directory" && !n.parentId);
  if (existing) return existing.id;
  const set = await client.call<SetResponse<FileNode>>("FileNode/set", { accountId, create: { d: directoryCreate(null, FOLDER) } });
  const err = set.notCreated?.d;
  if (err) throw new Error(setErrorMessage(err));
  return set.created!.d!.id;
}

/** Upload an image for use in a signature; returns a same-origin blob URL. */
export async function uploadSignatureImage(file: File): Promise<string> {
  const accountId = useSession.getState().accountFor(CAP.filenode);
  if (!accountId || !client.hasCapability(CAP.filenode)) {
    toast.error("Images in signatures need the Files feature, which this account doesn't have.");
    throw new Error("filenode unavailable");
  }
  if (file.size > 512 * 1024) {
    toast.error("Please use an image under 512 KB for signatures.");
    throw new Error("too large");
  }
  try {
    const type = file.type || "image/png";
    const up = await client.upload(accountId, file, { type });
    const folderId = await ensureFolder(accountId);
    const name = `${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    const res = await client.call<SetResponse<FileNode>>("FileNode/set", { accountId, create: { f: fileCreate(folderId, name, up.blobId, type) } });
    const err = res.notCreated?.f;
    if (err) throw new Error(setErrorMessage(err));
    const created = res.created?.f as Partial<FileNode> | undefined;
    // Prefer the node's (persistent) blobId if the server returned one.
    const blobId = created?.blobId ?? (await nodeBlobId(accountId, created?.id)) ?? up.blobId;
    return client.downloadUrl(accountId, blobId, name, type, true);
  } catch (err) {
    toast.error(`Could not store image: ${(err as Error).message}`);
    throw err;
  }
}

/** Store the full HTML of an over-sized signature in Files; returns the blob id. */
export async function storeSignatureHtml(html: string): Promise<string> {
  const accountId = useSession.getState().accountFor(CAP.filenode);
  if (!accountId || !client.hasCapability(CAP.filenode)) throw new Error("This signature is too long for the server and the Files feature (needed to store long signatures) is not available.");
  const up = await client.upload(accountId, new Blob([html], { type: "text/html" }), { type: "text/html" });
  const folderId = await ensureFolder(accountId);
  const name = `signature-${Date.now()}.html`;
  const res = await client.call<SetResponse<FileNode>>("FileNode/set", { accountId, create: { f: fileCreate(folderId, name, up.blobId, "text/html") } });
  const err = res.notCreated?.f;
  if (err) throw new Error(setErrorMessage(err));
  const created = res.created?.f as Partial<FileNode> | undefined;
  return created?.blobId ?? (await nodeBlobId(accountId, created?.id)) ?? up.blobId;
}

/** Replace data: URL images (pasted pictures) in signature HTML with stored blob URLs. */
export async function externalizeDataImages(html: string): Promise<string> {
  if (!html.includes("data:image/")) return html;
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html");
  const root = doc.getElementById("r")!;
  const imgs = Array.from(root.querySelectorAll("img")).filter((i) => i.getAttribute("src")?.startsWith("data:image/"));
  for (const img of imgs) {
    const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(img.getAttribute("src")!);
    if (!m) {
      img.remove();
      continue;
    }
    const bin = atob(m[2]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], `image.${m[1]!.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`, { type: m[1]! });
    img.setAttribute("src", await uploadSignatureImage(file));
  }
  return root.innerHTML;
}

/** Load the full HTML of a marker signature. */
export async function loadStoredSignature(blobId: string, type = "text/html"): Promise<string> {
  const accountId = useSession.getState().accountFor(CAP.filenode) ?? useSession.getState().accountId;
  if (!accountId) throw new Error("no account");
  return client.fetchBlobText(accountId, blobId, type);
}

async function nodeBlobId(accountId: string, id?: string): Promise<string | undefined> {
  if (!id) return undefined;
  try {
    const res = await client.call<GetResponse<FileNode>>("FileNode/get", { accountId, ids: [id], properties: ["id", "blobId"] });
    return res.list[0]?.blobId ?? undefined;
  } catch {
    return undefined;
  }
}

export type { QueryResponse };
