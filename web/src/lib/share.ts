/*
 * The operating system's own share sheet.
 *
 * Everything that leaves ihasmail today leaves as a download, and on a phone a
 * download is close to a dead end: the file lands in Downloads and the person
 * who wanted to send it somewhere goes hunting for it in a file manager. Web
 * Share hands the bytes straight to whatever they meant to send them to, which
 * is the thing they were actually trying to do.
 *
 * Every entry point feature-detects and disappears where the API is not there
 * rather than failing at the tap: `navigator.share` is absent on desktop Linux
 * and in Firefox, exists on iOS and Android and on Windows and macOS Chrome,
 * and file sharing is a separate question from sharing at all.
 */

/**
 * What became of a share.
 *
 * `unsupported` is the interesting one: it says the share did not happen and
 * the caller should do whatever it did before — for an attachment, download
 * it. It covers both "this browser cannot" and "this browser could not this
 * time", because to the caller those are the same instruction.
 */
export type ShareOutcome = "shared" | "dismissed" | "unsupported";

/** Whether the browser can share at all. */
export function canShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/*
 * Whether it can share *files*, asked once and remembered.
 *
 * `canShare()` needs a real File to answer, and the answer is about the
 * browser rather than about any particular file, so a one-byte probe settles
 * it for the session. It has to be asked before there is anything to share:
 * this is what decides whether a Share button is drawn at all, and drawing one
 * that turns out to be a download in disguise is worse than not drawing it.
 *
 * A byte rather than an empty file on purpose — an implementation is entitled
 * to refuse a zero-length one, and being told "no" by the probe would hide the
 * button everywhere.
 */
let fileShareSupported: boolean | null = null;
export function canShareFiles(): boolean {
  if (fileShareSupported === null) {
    try {
      fileShareSupported =
        canShare() &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [new File(["x"], "probe.txt", { type: "text/plain" })] });
    } catch {
      fileShareSupported = false;
    }
  }
  return fileShareSupported;
}

/** Reset the remembered probe. Tests only. */
export function resetShareSupport(): void {
  fileShareSupported = null;
}

/** Share text, a title, a URL, or any combination the browser accepts. */
export async function shareText(data: { title?: string; text?: string; url?: string }): Promise<ShareOutcome> {
  if (!canShare()) return "unsupported";
  return await run(data);
}

/**
 * Share one file. `unsupported` means nothing happened and the caller should
 * fall back to a download.
 */
export async function shareFile(file: File, extra: { title?: string; text?: string } = {}): Promise<ShareOutcome> {
  if (!canShare() || !navigator.canShare?.({ files: [file] })) return "unsupported";
  return await run({ ...extra, files: [file] });
}

async function run(data: ShareData): Promise<ShareOutcome> {
  try {
    await navigator.share(data);
    return "shared";
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    // The sheet opened and was closed again. That is a decision, not a fault,
    // and a toast for it would be scolding somebody for changing their mind.
    if (name === "AbortError") return "dismissed";
    /*
     * `NotAllowedError` is reported as unsupported rather than raised, because
     * what it nearly always means here is that the tap's transient activation
     * ran out while the attachment downloaded. `share()` takes files and not a
     * promise of them, so there is no way to open the sheet first and fill it
     * afterwards — the fetch has to happen inside the gesture's window, and on
     * a slow connection and a large attachment it will sometimes not fit.
     *
     * The caller's fallback is a download, which is exactly what the button
     * did before this existed, so the failure costs a tap rather than the file.
     */
    if (name === "NotAllowedError") return "unsupported";
    throw err;
  }
}
