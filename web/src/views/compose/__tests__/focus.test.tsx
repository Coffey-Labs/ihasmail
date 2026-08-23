import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RichEditor } from "../RichEditor";
import { initialFocusTarget } from "../Composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("initialFocusTarget", () => {
  it("starts a blank message in the recipients", () => {
    expect(initialFocusTarget({ to: [], subject: "" })).toBe("to");
  });
  it("moves on to the subject once there are recipients", () => {
    expect(initialFocusTarget({ to: [{ name: null, email: "a@b.c" }], subject: "" })).toBe("subject");
  });
  it("starts a reply — addressed and titled — in the body", () => {
    expect(initialFocusTarget({ to: [{ name: null, email: "a@b.c" }], subject: "Re: hi" })).toBe("body");
  });
});

describe("RichEditor autoFocus", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (autoFocus: boolean) =>
    act(() => {
      root.render(<RichEditor html="" onChange={() => {}} showToolbar={false} autoFocus={autoFocus} />);
    });

  const editor = () => host.querySelector<HTMLElement>('[contenteditable="true"]');

  it("focuses on mount when asked to", () => {
    render(true);
    expect(document.activeElement).toBe(editor());
  });

  it("does not steal focus when autoFocus turns true later", () => {
    render(false);
    expect(document.activeElement).not.toBe(editor());

    // Something else holds the caret — the subject field being typed into.
    const subject = document.createElement("input");
    document.body.appendChild(subject);
    subject.focus();
    expect(document.activeElement).toBe(subject);

    render(true);
    expect(document.activeElement, "the editor grabbed focus mid-typing").toBe(subject);
    subject.remove();
  });
});
