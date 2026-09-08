import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreviewDialog, type PreviewFile } from "../filepreview";
import { resetShareSupport } from "@/lib/share";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The share sheet is wiring rather than arithmetic, and wiring is what a store
 * test cannot see: whether the button is drawn at all is a question about the
 * browser, and what it does is a fetch, a File and a fallback that has to fire
 * on any failure rather than leaving the reader with nothing.
 *
 * The dialog is also where both callers meet -- an attachment opened from a
 * message and a file opened from Files land in this same component -- so it is
 * the one place worth driving.
 */

const FILE: PreviewFile = {
  name: "photo.png",
  type: "image/png",
  size: 12,
  url: "/api/blob/photo.png",
  inlineUrl: "/api/blob/photo.png?inline=1",
};

function stubNavigator(nav: Partial<Navigator>) {
  vi.stubGlobal("navigator", nav as Navigator);
  resetShareSupport();
}

describe("sharing from the file preview", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["bytes"], { type: "image/png" }), { status: 200 })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetShareSupport();
  });

  const show = () => act(() => root.render(<FilePreviewDialog file={FILE} onClose={() => undefined} />));
  /* The dialog portals to the body, so the buttons are not under `host`. */
  const shareButton = () => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Share") ?? null;

  it("draws no Share button where the browser cannot share files", () => {
    // Desktop Linux and Firefox. A control that could only ever fall back to
    // the Download beside it is one worth not drawing.
    stubNavigator({});
    show();
    expect(shareButton()).toBeNull();
    expect(document.body.textContent).toContain("Download");
  });

  it("hands the bytes to the sheet as a File, not the URL", async () => {
    const share = vi.fn(async () => undefined);
    stubNavigator({ share, canShare: (() => true) as unknown as Navigator["canShare"] });
    show();
    const btn = shareButton();
    expect(btn).not.toBeNull();

    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(fetch).toHaveBeenCalledWith(FILE.url, { credentials: "same-origin" });
    const shared = (share.mock.calls[0] as unknown as [ShareData])[0];
    const file = shared.files?.[0];
    expect(file).toBeInstanceOf(File);
    expect(file?.name).toBe("photo.png");
    expect(file?.type).toBe("image/png");
  });

  it("downloads instead when the blob cannot be fetched", async () => {
    // The failure that matters is silent: without the fallback the tap does
    // nothing at all and the file is simply unreachable from a phone.
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    stubNavigator({ share: vi.fn(), canShare: (() => true) as unknown as Navigator["canShare"] });
    show();

    await act(async () => {
      shareButton()!.click();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(clicked).toHaveBeenCalled();
  });
});
