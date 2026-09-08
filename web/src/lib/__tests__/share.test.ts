import { afterEach, describe, expect, it, vi } from "vitest";
import { canShare, canShareFiles, resetShareSupport, shareFile, shareText } from "@/lib/share";

/**
 * The outcomes are the whole of this module: what the callers do next is
 * decided entirely by which of the three comes back, and two of the three are
 * reached through an exception rather than a return.
 *
 * `unsupported` is the one worth guarding. It is the instruction to download
 * instead, and it has to cover the browser that cannot share files *and* the
 * share that was refused because the tap's activation ran out while the
 * attachment was fetched -- which arrives as an error indistinguishable from a
 * permissions refusal, and would otherwise reach the reader as a toast about
 * something they cannot act on.
 */

function stubNavigator(nav: Partial<Navigator>) {
  vi.stubGlobal("navigator", nav as Navigator);
  resetShareSupport();
}

const aFile = () => new File(["x"], "note.txt", { type: "text/plain" });

afterEach(() => {
  vi.unstubAllGlobals();
  resetShareSupport();
});

describe("share availability", () => {
  it("is absent where the browser has no Web Share", () => {
    stubNavigator({});
    expect(canShare()).toBe(false);
    expect(canShareFiles()).toBe(false);
  });

  it("asks about files separately from sharing at all", () => {
    // Every iOS and Android browser shares text; not all of them take files,
    // and a Share button that turns out to be a download is worse than none.
    stubNavigator({ share: vi.fn(), canShare: () => false });
    expect(canShare()).toBe(true);
    expect(canShareFiles()).toBe(false);
  });

  it("probes with a real file, since canShare() cannot answer without one", () => {
    const canShareFn = vi.fn(() => true);
    stubNavigator({ share: vi.fn(), canShare: canShareFn as unknown as Navigator["canShare"] });
    expect(canShareFiles()).toBe(true);
    const probe = (canShareFn.mock.calls[0] as unknown as [ShareData])[0];
    expect(probe.files?.[0]).toBeInstanceOf(File);
    expect(probe.files?.[0]?.size).toBeGreaterThan(0);
  });

  it("asks once and remembers, because the answer is about the browser", () => {
    const canShareFn = vi.fn(() => true);
    stubNavigator({ share: vi.fn(), canShare: canShareFn as unknown as Navigator["canShare"] });
    canShareFiles();
    canShareFiles();
    canShareFiles();
    expect(canShareFn).toHaveBeenCalledTimes(1);
  });
});

describe("sharing text", () => {
  it("hands the data straight to the sheet", async () => {
    const share = vi.fn(async () => undefined);
    stubNavigator({ share });
    await expect(shareText({ title: "Lunch", text: "One o'clock?" })).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: "Lunch", text: "One o'clock?" });
  });

  it("reports unsupported rather than throwing where there is no share", async () => {
    stubNavigator({});
    await expect(shareText({ text: "hello" })).resolves.toBe("unsupported");
  });
});

describe("sharing a file", () => {
  it("passes the file through when the browser takes it", async () => {
    const share = vi.fn(async () => undefined);
    stubNavigator({ share, canShare: (() => true) as unknown as Navigator["canShare"] });
    const f = aFile();
    await expect(shareFile(f, { title: "note.txt" })).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: "note.txt", files: [f] });
  });

  it("does not call share at all when this file is not shareable", async () => {
    const share = vi.fn(async () => undefined);
    stubNavigator({ share, canShare: (() => false) as unknown as Navigator["canShare"] });
    await expect(shareFile(aFile())).resolves.toBe("unsupported");
    expect(share).not.toHaveBeenCalled();
  });

  it("treats a closed sheet as a decision, not a failure", async () => {
    stubNavigator({
      share: vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); }),
      canShare: (() => true) as unknown as Navigator["canShare"],
    });
    await expect(shareFile(aFile())).resolves.toBe("dismissed");
  });

  it("falls back rather than reporting an error when the gesture has expired", async () => {
    // What NotAllowedError means here is that fetching the attachment outlived
    // the tap that asked for it. The caller downloads; the reader sees a file
    // rather than a message about transient activation.
    stubNavigator({
      share: vi.fn(async () => { throw new DOMException("no activation", "NotAllowedError"); }),
      canShare: (() => true) as unknown as Navigator["canShare"],
    });
    await expect(shareFile(aFile())).resolves.toBe("unsupported");
  });

  it("raises anything it does not recognise, so a real fault is still reported", async () => {
    stubNavigator({
      share: vi.fn(async () => { throw new DOMException("boom", "DataError"); }),
      canShare: (() => true) as unknown as Navigator["canShare"],
    });
    await expect(shareFile(aFile())).rejects.toThrow("boom");
  });
});
