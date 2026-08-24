import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog } from "../dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Dialogs are almost always given an inline arrow for onClose, so its identity
 * changes on every render of the parent. While that was in the effect's
 * dependencies, any dialog holding state tore the effect down and set it up
 * again on each keystroke — and its autofocus dragged the caret back to the
 * first field. Typing a digit into the second field jumped you to the first.
 */

/** A dialog with two fields, whose parent re-renders as either is typed in. */
function TwoFieldDialog() {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  return (
    <Dialog open onClose={() => undefined} title="Two fields">
      <input id="first" value={first} onChange={(e) => setFirst(e.target.value)} />
      <input id="second" value={second} onChange={(e) => setSecond(e.target.value)} />
    </Dialog>
  );
}

describe("Dialog focus handling", () => {
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

  const type = (el: HTMLInputElement, value: string) => {
    act(() => {
      el.focus();
      // What React's onChange sees when a character is typed.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("autofocuses the first field when it opens", async () => {
    act(() => root.render(<TwoFieldDialog />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement?.id).toBe("first");
  });

  it("leaves the caret alone while a later field is typed in", async () => {
    act(() => root.render(<TwoFieldDialog />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const second = document.getElementById("second") as HTMLInputElement;
    type(second, "1");
    // The old effect re-ran here and pulled focus back to the first field.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement?.id).toBe("second");

    type(second, "12");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement?.id).toBe("second");
    expect(second.value).toBe("12");
  });
});
