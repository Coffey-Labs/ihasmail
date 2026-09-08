/*
 * Collecting a share the operating system sent us.
 *
 * The other end of `share_target` in the manifest: the system POSTs a form at
 * `<base>/share`, the service worker takes the body and stashes it, and this
 * is the tab picking it up. See the note on `stashShare` in sw.js for why the
 * worker answers that request rather than the app or the server.
 *
 * The handoff goes through the cache rather than postMessage because a share
 * usually launches the app: there is no tab to message at the moment it
 * arrives, and the one that appears a second later is a different context that
 * has to find the payload lying somewhere.
 */
import { withBase } from "./basePath";
import { SW_CACHE_NAME } from "./swCache";

export interface SharedContent {
  title: string;
  text: string;
  url: string;
  files: File[];
}

/** The worker writes here; both sides name it absolutely. */
const SHARE_KEY = "/ihasmail-share";

/*
 * How long a share is worth acting on.
 *
 * It is collected on every app start rather than only when the launch URL says
 * so, because the launch may not survive the trip: a share to a signed-out
 * ihasmail lands on the sign-in page, and the composer can only open once
 * there is an account to open it in. Waiting for that means the payload has to
 * outlive a redirect and a login, which the query string does not.
 *
 * What that costs is the possibility of a stash nobody ever came back for, so
 * it expires. Ten minutes is long enough for signing in -- password manager,
 * app password, a second device -- and short enough that a share abandoned
 * this morning does not open a composer full of a forgotten photo tonight.
 */
export const SHARE_MAX_AGE_MS = 10 * 60_000;

interface StashedFile {
  key: string;
  name: string;
  type: string;
}

/**
 * Take whatever the worker left, and leave nothing behind.
 *
 * Returns null when there is nothing waiting, which is almost every start.
 * The entries are deleted whether or not the share is still worth opening: a
 * stash that stayed would be collected on the next start instead, which is the
 * expiry doing nothing.
 */
export async function collectShare(): Promise<SharedContent | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(SW_CACHE_NAME);
    const key = withBase(SHARE_KEY);
    const hit = await cache.match(key);
    if (!hit) return null;

    const meta = (await hit.json()) as Partial<SharedContent> & { at?: number; files?: StashedFile[] };
    await cache.delete(key);

    const files: File[] = [];
    for (const f of meta.files ?? []) {
      const res = await cache.match(f.key);
      await cache.delete(f.key);
      if (!res) continue;
      files.push(new File([await res.blob()], f.name, { type: f.type }));
    }

    if (typeof meta.at === "number" && Date.now() - meta.at > SHARE_MAX_AGE_MS) return null;

    const share: SharedContent = {
      title: meta.title ?? "",
      text: meta.text ?? "",
      url: meta.url ?? "",
      files,
    };
    // A share with nothing in it is a share that went wrong upstream. Opening
    // an empty composer over the inbox would be a worse account of that than
    // opening nothing.
    return share.title || share.text || share.url || files.length ? share : null;
  } catch {
    /* no cache, or nothing waiting: not a failure */
    return null;
  }
}

/**
 * The shared text and the shared link as one body.
 *
 * What arrives in which field is up to whatever did the sharing, and they do
 * not agree: a link from Chrome comes as a title and a `url`, from other apps
 * as `text` that already *is* the link, and from a few as both. Appending it
 * unconditionally would put the same URL in twice as often as not.
 */
export function shareBody(share: Pick<SharedContent, "text" | "url">): string {
  const text = share.text.trim();
  const url = share.url.trim();
  if (!url || text.includes(url)) return text;
  return text ? `${text}\n\n${url}` : url;
}
