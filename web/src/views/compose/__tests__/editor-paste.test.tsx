import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_IMAGE_MAX, RichEditor, isLinkToPaste } from "../RichEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

/*
 * Two things pasting into a message now does: a link pasted over selected
 * words turns those words into the link, and an image too large to belong
 * in the text goes in as an attachment. jsdom does no editing, so these check
 * the command and the callback the editor reaches for.
 */

describe("what counts as a link to paste", () => {
  it("takes one web or mailto address", () => {
    expect(isLinkToPaste("https://example.com/a?b=1")).toBe(true);
    expect(isLinkToPaste("http://example.com")).toBe(true);
    expect(isLinkToPaste("mailto:ann@example.com")).toBe(true);
  });

  it("leaves ordinary text and anything with spaces alone", () => {
    expect(isLinkToPaste("see https://example.com")).toBe(false);
    expect(isLinkToPaste("example.com")).toBe(false);
    expect(isLinkToPaste("javascript:alert(1)")).toBe(false);
    expect(isLinkToPaste("")).toBe(false);
  });
});

describe("pasting into the editor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onFiles: ReturnType<typeof vi.fn<(files: File[]) => void>>;
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onFiles = vi.fn<(files: File[]) => void>();
    exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    await act(async () => {
      root.render(<RichEditor html="<p>read the docs here</p>" onChange={() => {}} onFiles={onFiles} showToolbar={false} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const editor = () => host.querySelector<HTMLElement>('[contenteditable="true"]')!;

  const paste = async (data: { text?: string; html?: string; files?: File[] }) => {
    const items = (data.files ?? []).map((f) => ({ type: f.type, kind: "file", getAsFile: () => f }));
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { items, getData: (t: string) => (t === "text/plain" ? data.text ?? "" : t === "text/html" ? data.html ?? "" : "") },
    });
    await act(async () => editor().dispatchEvent(ev));
    return ev;
  };

  const select = (word: string) => {
    const text = editor().querySelector("p")!.firstChild!;
    const i = text.textContent!.indexOf(word);
    const r = document.createRange();
    r.setStart(text, i);
    r.setEnd(text, i + word.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  };

  it("turns selected words into the pasted link", async () => {
    select("docs");
    const ev = await paste({ text: "https://example.com/docs" });
    expect(ev.defaultPrevented).toBe(true);
    expect(exec).toHaveBeenCalledWith("createLink", false, "https://example.com/docs");
  });

  it("pastes a link as text when nothing is selected", async () => {
    window.getSelection()!.removeAllRanges();
    await paste({ text: "https://example.com/docs" });
    expect(exec).not.toHaveBeenCalledWith("createLink", expect.anything(), expect.anything());
  });

  it("attaches a pasted image too large to sit in the text", async () => {
    const big = new File([new Uint8Array(8)], "huge.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: INLINE_IMAGE_MAX + 1 });
    await paste({ files: [big] });
    expect(onFiles).toHaveBeenCalledWith([big]);
  });

  it("keeps a normal-sized pasted image in the text", async () => {
    const small = new File([new Uint8Array(8)], "shot.png", { type: "image/png" });
    await paste({ files: [small] });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
