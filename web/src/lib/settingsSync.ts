/**
 * Settings that follow the account rather than the browser.
 *
 * Everything used to live in localStorage, which meant no preference travelled
 * between devices — most painfully the default identity, where the fallback is
 * whichever address sorts first, so a forgotten setting sends mail from an
 * address the recipient may not know (issue #54).
 *
 * The store is a `settings.json` in the account's own JMAP Files, beside the
 * signature images that are already kept there. That keeps ihasmail itself
 * stateless: no volume, no database, nothing to back up separately, and the
 * settings are covered by whatever backs up the mail store.
 *
 * localStorage stays, demoted to a cache: it is what paints the first frame,
 * and the file overwrites it once it lands. A browser with no cache (a private
 * window) therefore shows defaults for one frame before the account's real
 * settings arrive.
 */
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { FileNode, Id, SetResponse } from "@/jmap/types";
import { ensureFolder, findInFolder, nodeBlobId } from "@/lib/appFolder";
import { fileCreate } from "@/lib/filenode";
import { useSession } from "@/store/session";

const FILE = "settings.json";
const TYPE = "application/json";

/** How long a change sits before it is written up. */
const DEBOUNCE_MS = 3000;

let timer: number | null = null;
let pending: Record<string, unknown> | null = null;
let inFlight: Promise<void> | null = null;
/** Nothing is pushed before the first load has settled, or we would race it. */
let armed = false;
let listenersBound = false;

export function settingsSyncAvailable(): boolean {
  return client.hasCapability(CAP.filenode) && Boolean(useSession.getState().accountFor(CAP.filenode));
}

/**
 * Read the account's settings file. Returns null when there is nothing to read
 * — no file yet, no Files, an older server — which leaves the local cache in
 * charge rather than wiping it.
 */
export async function loadRemoteSettings(): Promise<Record<string, unknown> | null> {
  if (!settingsSyncAvailable()) return null;
  const accountId = useSession.getState().accountFor(CAP.filenode)!;
  try {
    const folderId = await ensureFolder(accountId);
    const node = await findInFolder(accountId, folderId, FILE);
    if (!node?.blobId) return null;
    const text = await client.fetchBlobText(accountId, node.blobId, TYPE);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // A settings file we cannot read must not cost anyone their session; the
    // cached settings are still perfectly good.
    return null;
  }
}

/** Allow pushes. Called once the first load has settled, either way. */
export function armSettingsSync(): void {
  armed = true;
  bindFlushListeners();
}

/** Stop syncing and drop anything queued (logout). */
export function stopSettingsSync(): void {
  armed = false;
  pending = null;
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

/**
 * Queue the synced settings for writing. Called on every change — including
 * each frame of a splitter drag — so it coalesces: the newest value wins and
 * one request goes out once the changes stop.
 */
export function queueSettingsPush(synced: Record<string, unknown>): void {
  if (!armed || !settingsSyncAvailable()) return;
  pending = synced;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void flushSettingsPush();
  }, DEBOUNCE_MS);
}

/** Write anything queued now, rather than waiting out the debounce. */
export async function flushSettingsPush(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (!pending || !armed) return;
  const body = pending;
  pending = null;
  // Serialise: two overlapping writes could land in either order.
  inFlight = (inFlight ?? Promise.resolve()).then(() => writeSettings(body)).catch(() => undefined);
  await inFlight;
}

async function writeSettings(body: Record<string, unknown>): Promise<void> {
  if (!settingsSyncAvailable()) return;
  const accountId = useSession.getState().accountFor(CAP.filenode)!;
  const json = JSON.stringify(body, null, 2);
  // Byte length, not character count: a template or a signature with any
  // non-ASCII in it would otherwise be reported shorter than it is.
  const blob = new Blob([json], { type: TYPE });
  const up = await client.upload(accountId, blob, { type: TYPE });
  const folderId = await ensureFolder(accountId);
  const existing = await findInFolder(accountId, folderId, FILE);
  if (existing) {
    const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
      accountId,
      update: { [existing.id]: { blobId: up.blobId, type: TYPE, size: blob.size } },
    });
    const err = res.notUpdated?.[existing.id];
    if (err) throw new Error(setErrorMessage(err));
    return;
  }
  const res = await client.call<SetResponse<FileNode>>("FileNode/set", {
    accountId,
    create: { s: fileCreate(folderId, FILE, up.blobId, TYPE) },
  });
  const err = res.notCreated?.s;
  if (err) throw new Error(setErrorMessage(err));
  // Some servers hand back no blobId on create; ask, so the next read finds it.
  await nodeBlobId(accountId, (res.created?.s as Partial<FileNode> | undefined)?.id as Id | undefined);
}

/**
 * A debounce that outlives the page helps no one, so a tab going away writes
 * first. `visibilitychange` is the one that fires reliably on mobile; `pagehide`
 * covers the desktop close.
 */
function bindFlushListeners(): void {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;
  const flush = () => {
    if (pending) void flushSettingsPush();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
