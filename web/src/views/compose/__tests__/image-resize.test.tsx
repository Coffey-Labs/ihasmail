import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichEditor } from "../RichEditor";
import { imageWidth, setImageWidth } from "../ImageResizer";
import { sanitizeEditorHtml } from "@/lib/text/html";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

/*
 * An image in the composer could not be resized at all (Gitea issue #26).
 * jsdom does no layout, so dragging the handle is checked in a browser; these
 * pin what a size does to the message, and that the frame never ends up in it.
 */

describe("setting an image's width", () => {
  it("writes both the attribute Outlook reads and the style everything else reads", () => {
    const img = document.createElement("img");
    img.setAttribute("height", "480");
    setImageWidth(img, 300);
    expect(img.getAttribute("width")).toBe("300");
    expect(img.style.width).toBe("300px");
    // A leftover height would stretch it out of shape.
    expect(img.hasAttribute("height")).toBe(false);
    expect(img.style.height).toBe("auto");
    // Still shrinks to fit a narrow screen on the receiving end.
    expect(img.style.maxWidth).toBe("100%");
    expect(imageWidth(img)).toBe(300);
  });

  it("goes back to the image's own size", () => {
    const img = document.createElement("img");
    setImageWidth(img, 600);
    setImageWidth(img, null);
    expect(img.hasAttribute("width")).toBe(false);
    expect(img.style.width).toBe("");
    expect(imageWidth(img)).toBeNull();
  });

  it("survives the sanitizer a draft goes through", () => {
    const img = document.createElement("img");
    img.src = "https://example.com/a.png";
    setImageWidth(img, 450);
    const out = sanitizeEditorHtml(img.outerHTML);
    expect(out).toContain('width="450"');
    expect(out).toContain("width: 450px");
  });
});

describe("resizing an image in the editor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onChange: ReturnType<typeof vi.fn<(html: string) => void>>;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onChange = vi.fn<(html: string) => void>();
    await act(async () => {
      root.render(<RichEditor html='<p>Hi</p><img src="data:image/png;base64,AA==" alt="shot" style="max-width:100%">' onChange={onChange} showToolbar={false} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const editor = () => host.querySelector<HTMLElement>('[contenteditable="true"]')!;
  const img = () => editor().querySelector("img")!;
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".img-resize-bar button")].find((b) => b.textContent === label);

  it("offers sizes when the image is clicked, and applies one", async () => {
    expect(host.querySelector(".img-resize-bar")).toBeNull();
    await act(async () => img().click());
    expect(button("Medium")).toBeTruthy();
    await act(async () => button("Medium")!.click());
    expect(imageWidth(img())).toBe(600);
    expect(button("Medium")!.getAttribute("aria-pressed")).toBe("true");
    // The draft is saved with the new width in it.
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('width="600"'));
  });

  it("offers them on a right-click too, instead of the browser's menu", async () => {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => img().dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(button("Original size")).toBeTruthy();
  });

  it("never puts the frame or its buttons into the message", async () => {
    await act(async () => img().click());
    await act(async () => button("Small")!.click());
    const sent = onChange.mock.lastCall![0] as string;
    expect(sent).not.toContain("img-resize");
    expect(sent).not.toContain("Original size");
    expect(editor().querySelector(".img-resize-layer")).toBeNull();
  });

  it("lets go on a click elsewhere and on Escape", async () => {
    await act(async () => img().click());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector(".img-resize-bar")).toBeNull();

    await act(async () => img().click());
    await act(async () => editor().querySelector("p")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(host.querySelector(".img-resize-bar")).toBeNull();
  });
});
