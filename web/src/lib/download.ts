/**
 * Hand the browser a file the app made, to save.
 *
 * The object URL is released as soon as the download has been started: a
 * click on the link starts it synchronously, and an unreleased URL keeps the
 * whole file in memory for as long as the tab is open -- an address book's
 * worth of vCards, per export.
 */
export function downloadFile(content: BlobPart, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
